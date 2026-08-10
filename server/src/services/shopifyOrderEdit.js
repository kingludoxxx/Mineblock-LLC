// Mirror a post-purchase order edit INTO the Shopify order we created.
//
// This is the OUTBOUND twin of shopifyRefund.js: the same stance, the same
// credentials, the same fail-closed-but-non-fatal posture. It exists because
// crm_orders — the table the Orders UI renders — is fed by the store's
// orders/* webhooks. An edit we only record locally leaves the store (and
// therefore the CRM, and therefore the pick list) describing the OLD order.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS IS OFF BY DEFAULT (SHOPIFY_ORDER_EDIT_ENABLED=1 to arm it)
//
// Shopify's `orderEditCommit` is ADDITIVE and NOT IDEMPOTENT. Running the same
// begin→add→commit twice adds the line twice. There is no idempotency key on
// that API. The only protection is that the caller never issues a second push
// for the same edit — which is exactly what the immutable co_order_edits row
// guarantees (UNIQUE (session_id, edit_id) turns a client retry into a replay
// that never reaches this module).
//
// Because that protection lives in the CALLER, this module refuses to be
// called blind: it is opt-in per deployment, exactly like
// shopifyOrderCreateEnabled(). A shared-codebase deploy pointed at a different
// store cannot edit orders in a store it does not own, and an operator who
// wants the local-only behaviour simply never sets the flag.
//
// FAILURE STANCE — this module NEVER throws and NEVER retries.
//   'skipped'      the lane is off / there is nothing to push
//   'pushed'       the store agrees with our snapshot
//   'needs_review' something went wrong; a HUMAN owns it
// An automatic retry of a partially-applied additive commit is how one edit
// becomes two lines, so there is no retry path here by construction. The
// co_order_edit_pushes row is the audit trail an operator works from.
//
// ORDERING — address first, lines second. The address write is an idempotent
// REST PUT; the line edit is the non-idempotent additive commit. Doing the
// idempotent one first means an address failure can never strand a committed
// line edit, and re-running the address after a line failure is harmless.
import { shopifyOrderCreds } from './shopifyOrderCreate.js';

const EDIT_TIMEOUT_MS = 8_000;

// Armed only on an EXPLICIT opt-in, with the store configured, and with the
// kill switch clear. Mirrors shopifyOrderCreateEnabled() deliberately: an
// operator learns one rule for every outbound Shopify write in this codebase.
export function shopifyOrderEditEnabled() {
  if (process.env.SHOPIFY_ORDER_EDIT_DISABLED === '1') return false;
  if (process.env.SHOPIFY_ORDER_EDIT_ENABLED !== '1') return false;
  const { store, token } = shopifyOrderCreds();
  return Boolean(store && token);
}

// Shopify numeric ids arrive as numbers or gids; the REST order path wants the
// bare digits. Returns '' when it cannot be reduced to one.
export function numericOrderId(raw) {
  const v = String(raw == null ? '' : raw).trim();
  if (/^\d+$/.test(v)) return v;
  const m = v.match(/Order\/(\d+)/);
  return m ? m[1] : '';
}

export function variantGid(raw) {
  const v = String(raw == null ? '' : raw).trim();
  return v.startsWith('gid://') ? v : `gid://shopify/ProductVariant/${v}`;
}

/**
 * Map OUR stored address shape (address1/address2/city/state/zip/country) onto
 * Shopify's REST mailing address. Returns null when there is no street line —
 * Shopify silently accepts a blank address1 and then renders an unshippable
 * order, so we refuse it here instead.
 *
 * `state`/`country` are passed as `province`/`country` (the free-text fields),
 * NOT as province_code/country_code: our checkout stores human-entered values
 * of unbounded length, and posting "California" into province_code is how an
 * address quietly loses its state.
 */
export function toShopifyAddress(addr) {
  if (!addr || typeof addr !== 'object') return null;
  const s = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const address1 = s(addr.address1, 250);
  if (!address1) return null;
  const out = { address1 };
  const a2 = s(addr.address2, 250); if (a2) out.address2 = a2;
  const city = s(addr.city, 120); if (city) out.city = city;
  const zip = s(addr.zip, 32); if (zip) out.zip = zip;
  const province = s(addr.state, 120); if (province) out.province = province;
  const country = s(addr.country, 60); if (country) out.country = country;
  return out;
}

async function shopifyFetch(fetchImpl, url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EDIT_TIMEOUT_MS);
  if (timer.unref) timer.unref();
  try {
    const resp = await fetchImpl(url, { ...init, signal: controller.signal });
    let json = {};
    try { json = await resp.json(); } catch { json = {}; }
    return { ok: resp.ok, status: resp.status, json };
  } catch (err) {
    const kind = err?.name === 'AbortError' ? 'timeout' : `network:${err?.name || 'Error'}`;
    return { ok: false, status: 0, transport: kind, json: {} };
  } finally {
    clearTimeout(timer);
  }
}

async function restPut(fetchImpl, creds, path, body) {
  const r = await shopifyFetch(
    fetchImpl,
    `${creds.apiBase}/admin/api/${creds.apiVersion}/${path}`,
    {
      method: 'PUT',
      headers: { 'X-Shopify-Access-Token': creds.token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
  if (r.transport) return { ok: false, reason: `transport:${r.transport}` };
  if (!r.ok) {
    const detail = r.json?.errors ? JSON.stringify(r.json.errors).slice(0, 200) : '';
    return { ok: false, reason: `http_${r.status}${detail ? ` ${detail}` : ''}` };
  }
  return { ok: true, body: r.json };
}

async function graphql(fetchImpl, creds, query, variables) {
  const r = await shopifyFetch(
    fetchImpl,
    `${creds.apiBase}/admin/api/${creds.apiVersion}/graphql.json`,
    {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': creds.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    }
  );
  if (r.transport) return { ok: false, reason: `transport:${r.transport}` };
  if (!r.ok) return { ok: false, reason: `http_${r.status}` };
  if (r.json?.errors) {
    return { ok: false, reason: `graphql:${JSON.stringify(r.json.errors).slice(0, 200)}` };
  }
  return { ok: true, data: r.json?.data || {} };
}

// userErrors are Shopify's SEMANTIC failures and arrive inside a 200. Missing
// them is how "the API said OK" turns into an order that never changed.
function userErrors(payload) {
  const errs = payload?.userErrors;
  if (!Array.isArray(errs) || !errs.length) return '';
  return errs.map((e) => `${(e.field || []).join('.')}:${e.message}`).join('; ').slice(0, 250);
}

const Q_BEGIN = `
mutation editBegin($id: ID!) {
  orderEditBegin(id: $id) { calculatedOrder { id } userErrors { field message } }
}`.trim();

const Q_ADD = `
mutation editAdd($id: ID!, $variantId: ID!, $quantity: Int!) {
  orderEditAddVariant(id: $id, variantId: $variantId, quantity: $quantity) {
    calculatedOrder { id } userErrors { field message }
  }
}`.trim();

const Q_LINES = `
query calcLines($id: ID!) {
  node(id: $id) {
    ... on CalculatedOrder {
      id
      lineItems(first: 100) { edges { node { id quantity variant { id } } } }
    }
  }
}`.trim();

const Q_SET_QTY = `
mutation editQty($id: ID!, $lineItemId: ID!, $quantity: Int!) {
  orderEditSetQuantity(id: $id, lineItemId: $lineItemId, quantity: $quantity, restock: true) {
    calculatedOrder { id } userErrors { field message }
  }
}`.trim();

const Q_COMMIT = `
mutation editCommit($id: ID!) {
  orderEditCommit(id: $id, notifyCustomer: false, staffNote: "Order edit (Puure dashboard)") {
    order { id } userErrors { field message }
  }
}`.trim();

/**
 * Push one edit to Shopify. NEVER throws.
 *
 * @param {object} p
 * @param {string} p.editRowId          co_order_edits.id (audit correlation)
 * @param {string} p.shopifyOrderId     the mirrored store order, or null
 * @param {Array}  p.changes            preview changes[] — {kind, variant_id, to, quantity}
 * @param {object} [p.shippingAddress]  our stored shape, or null when unchanged
 * @param {function} [p.fetchImpl]      injected for the harness
 * @returns {Promise<{status:string, reason:string, detail:object}>}
 */
export async function pushOrderEdit({
  editRowId = '', shopifyOrderId = null, changes = [], shippingAddress = null, fetchImpl = null,
} = {}) {
  const detail = { edit_row_id: editRowId, ops: [] };
  try {
    if (!shopifyOrderEditEnabled()) {
      return { status: 'skipped', reason: 'push_disabled', detail };
    }
    const numeric = numericOrderId(shopifyOrderId);
    if (!numeric) {
      // A local/draft order that was never mirrored has nothing to push to.
      // That is a legitimate outcome, not a failure.
      return { status: 'skipped', reason: 'no_shopify_order', detail };
    }
    const lineChanges = (Array.isArray(changes) ? changes : []).filter(
      (c) => c && (c.kind === 'added' || c.kind === 'quantity' || c.kind === 'removed')
    );
    const addr = shippingAddress ? toShopifyAddress(shippingAddress) : null;
    if (!lineChanges.length && !addr) {
      return { status: 'skipped', reason: 'nothing_to_push', detail };
    }

    const creds = shopifyOrderCreds();
    const doFetch = fetchImpl || globalThis.fetch;
    const orderGid = `gid://shopify/Order/${numeric}`;

    // ── 1. ADDRESS (idempotent REST PUT — safe to be first, safe to repeat) ──
    // A post-purchase edit corrects the SHIPPING address only. We push
    // shipping_address alone and NEVER touch billing_address: mirroring the
    // shipping value onto billing would silently overwrite the buyer's real
    // billing address (a different thing — the card's address, used for AVS and
    // accounting) every time an operator fixed a delivery typo. The edit
    // changed shipping, so the write changes shipping.
    if (addr) {
      const r = await restPut(doFetch, creds, `orders/${numeric}.json`, {
        order: { id: Number(numeric), shipping_address: addr },
      });
      detail.ops.push({ op: 'address', ok: r.ok, reason: r.reason || null });
      if (!r.ok) {
        // Refuse to continue to the NON-idempotent half. Retrying the address
        // later is free; retrying a half-committed line edit is not.
        return { status: 'needs_review', reason: `address_failed:${r.reason}`.slice(0, 300), detail };
      }
    }

    if (!lineChanges.length) {
      return { status: 'pushed', reason: 'address_only', detail };
    }

    // ── 2. LINES (begin → add → setQuantity → commit; additive, one shot) ────
    const begun = await graphql(doFetch, creds, Q_BEGIN, { id: orderGid });
    if (!begun.ok) {
      detail.ops.push({ op: 'begin', ok: false, reason: begun.reason });
      return { status: 'needs_review', reason: `begin_failed:${begun.reason}`.slice(0, 300), detail };
    }
    const beginErr = userErrors(begun.data?.orderEditBegin);
    const calcId = begun.data?.orderEditBegin?.calculatedOrder?.id || '';
    if (beginErr || !calcId) {
      detail.ops.push({ op: 'begin', ok: false, reason: beginErr || 'no_calculated_order' });
      return { status: 'needs_review', reason: `begin_failed:${beginErr || 'no_calculated_order'}`.slice(0, 300), detail };
    }
    detail.calculated_order_id = calcId;
    detail.ops.push({ op: 'begin', ok: true });

    for (const c of lineChanges.filter((x) => x.kind === 'added')) {
      const qty = parseInt(c.quantity, 10) || 0;
      if (qty <= 0) continue;
      const r = await graphql(doFetch, creds, Q_ADD, {
        id: calcId, variantId: variantGid(c.variant_id), quantity: qty,
      });
      const ue = r.ok ? userErrors(r.data?.orderEditAddVariant) : r.reason;
      detail.ops.push({ op: 'add', variant_id: c.variant_id, ok: r.ok && !ue, reason: ue || null });
      if (!r.ok || ue) {
        // Nothing was committed — an abandoned calculated order expires on
        // Shopify's side and changes nothing. Bail before the commit.
        return { status: 'needs_review', reason: `add_failed:${ue || r.reason}`.slice(0, 300), detail };
      }
    }

    const qtyChanges = lineChanges.filter((x) => x.kind === 'quantity' || x.kind === 'removed');
    if (qtyChanges.length) {
      const listed = await graphql(doFetch, creds, Q_LINES, { id: calcId });
      if (!listed.ok) {
        detail.ops.push({ op: 'list_lines', ok: false, reason: listed.reason });
        return { status: 'needs_review', reason: `list_lines_failed:${listed.reason}`.slice(0, 300), detail };
      }
      const byVariant = new Map();
      for (const edge of listed.data?.node?.lineItems?.edges || []) {
        const vid = edge?.node?.variant?.id;
        if (vid && !byVariant.has(vid)) byVariant.set(vid, edge.node.id);
      }
      for (const c of qtyChanges) {
        const lineId = byVariant.get(variantGid(c.variant_id));
        if (!lineId) {
          detail.ops.push({ op: 'set_qty', variant_id: c.variant_id, ok: false, reason: 'line_not_found_on_order' });
          return { status: 'needs_review', reason: `line_not_found:${c.variant_id}`.slice(0, 300), detail };
        }
        const qty = c.kind === 'removed' ? 0 : (parseInt(c.to, 10) || 0);
        const r = await graphql(doFetch, creds, Q_SET_QTY, { id: calcId, lineItemId: lineId, quantity: qty });
        const ue = r.ok ? userErrors(r.data?.orderEditSetQuantity) : r.reason;
        detail.ops.push({ op: 'set_qty', variant_id: c.variant_id, quantity: qty, ok: r.ok && !ue, reason: ue || null });
        if (!r.ok || ue) {
          return { status: 'needs_review', reason: `set_quantity_failed:${ue || r.reason}`.slice(0, 300), detail };
        }
      }
    }

    const committed = await graphql(doFetch, creds, Q_COMMIT, { id: calcId });
    const commitErr = committed.ok ? userErrors(committed.data?.orderEditCommit) : committed.reason;
    detail.ops.push({ op: 'commit', ok: committed.ok && !commitErr, reason: commitErr || null });
    if (!committed.ok || commitErr) {
      return { status: 'needs_review', reason: `commit_failed:${commitErr || committed.reason}`.slice(0, 300), detail };
    }
    detail.shopify_order_id = committed.data?.orderEditCommit?.order?.id || orderGid;
    return { status: 'pushed', reason: addr ? 'lines_and_address' : 'lines', detail };
  } catch (err) {
    // The caller's edit is already durable. A thrown push is a review item,
    // never an exception into the request.
    return { status: 'needs_review', reason: `exception:${err.message}`.slice(0, 300), detail };
  }
}

export default { pushOrderEdit, shopifyOrderEditEnabled, toShopifyAddress, numericOrderId, variantGid };
