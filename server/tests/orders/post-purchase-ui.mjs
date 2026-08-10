// POST-PURCHASE UI guards — source-level assertions over the two new admin
// surfaces. No database, no server: `vite build` already proves the JSX parses,
// so what is worth checking here is the set of properties a compiler cannot.
//
// Every check below exists because getting it wrong is silent and expensive:
// an operator who believes a button charged a card, or a client that quietly
// re-implements the money arithmetic, produces no error anywhere.
//
// Run:  node server/tests/orders/post-purchase-ui.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(HERE, '../../..', p), 'utf8');

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${extra}`); }
};

const modal = read('client/src/pages/orders/OrderEditModal.jsx');
const failed = read('client/src/pages/orders/FailedPaymentsPage.jsx');
const detail = read('client/src/pages/orders/OrderDetailPage.jsx');
const appJsx = read('client/src/App.jsx');
const sidebar = read('client/src/components/layout/Sidebar.jsx');
const routesIdx = read('server/src/routes/index.js');

// ── U1: the money sentence is on screen, not only in a comment ──────────────
{
  // Strip JS comments so a reassuring sentence that only exists for developers
  // cannot satisfy a check about what the OPERATOR sees.
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const modalUi = strip(modal);
  const failedUi = strip(failed);

  check('U1 the edit modal tells the operator, in rendered copy, that saving moves no money',
    /does not charge or refund/i.test(modalUi) && /No card is touched by this save/i.test(modalUi));
  check('U1 the failed-payments page says a retry does not charge a card, in rendered copy',
    /does not charge a card/i.test(failedUi) && /No card was charged/i.test(failedUi));
  check('U1 the order page repeats it next to the unsettled amount',
    /never moves money/i.test(strip(detail)) && /Nothing has been charged or refunded/i.test(strip(detail)));
  check('U1 the retry control is labelled as a REQUEST, never as a charge',
    /Request retry/.test(failedUi) && !/>\s*Retry charge\s*</.test(failedUi));
}

// ── U2: the client never re-implements the money arithmetic ────────────────
{
  // Every figure in the delta summary must come off the server preview object.
  // A client-side subtotal would be a second implementation of the money maths,
  // free to disagree with the number that actually gets recorded.
  const arithmetic = /(subtotal|total|owed)\w*\s*=\s*[^;\n]*\.reduce\(/;
  check('U2 the edit modal computes NO subtotal or total of its own',
    !arithmetic.test(modal), (modal.match(arithmetic) || [''])[0]);
  check('U2 every displayed figure is read off the server preview payload',
    /p\.subtotal_before/.test(modal) && /p\.owed_after/.test(modal)
    && /p\.captured_total/.test(modal) && /p\.total_delta/.test(modal));
  check('U2 the added line shows the SERVER-resolved price, not the operator\'s input',
    /changes \|\| \[\]\)\.find\(\(c\) => c\.variant_id === a\.variant_id\)\?\.price/.test(modal));
  check('U2 the modal never sends a client price for an added line',
    !/add_lines[\s\S]{0,200}price:/.test(modal), (modal.match(/add_lines[\s\S]{0,120}/) || [''])[0]);
}

// ── U3: the idempotency token is per modal-open, not per render ────────────
{
  const m = modal.match(/const editId = useMemo\(\([\s\S]*?\}, \[([^\]]*)\]\);/);
  check('U3 the edit_id is a useMemo keyed ONLY on `open` (one token per dialog opening)',
    Boolean(m) && m[1].trim() === 'open', m ? m[1] : 'useMemo not found');
  check('U3 the same token rides the commit request',
    /edit_id: editId/.test(modal));
  check('U3 the commit sends the base_version it previewed against',
    /base_version: baseVersion/.test(modal));
}

// ── U4: Save is gated on a SERVER-confirmed change ─────────────────────────
{
  check('U4 Save is disabled until the server preview reports dirty, and while it is in flight',
    /disabled=\{!linked\?\.editable \|\| !dirty \|\| preview\.status === 'loading' \|\| Boolean\(preview\.error\)\}/.test(modal));
  check('U4 `dirty` comes from the server preview, not from the form looking touched',
    /const dirty = Boolean\(p\?\.dirty\)/.test(modal));
}

// ── U5: currency handling degrades, never throws ───────────────────────────
{
  // Intl.NumberFormat throws RangeError on an unknown currency code, and these
  // values come straight off the money path — the one place a malformed code
  // would appear. A throw here blanks the page an operator is triaging.
  for (const [name, src] of [['edit modal', modal], ['failed payments', failed], ['order detail', detail]]) {
    const guarded = /style: 'currency'[\s\S]{0,200}?\} catch \{/.test(src);
    check(`U5 ${name} money formatting is wrapped so a bad currency code degrades to text`, guarded);
  }
}

// ── U6: an order with no checkout session is explained, not broken ─────────
{
  check('U6 the modal renders a reason for each linked:false case rather than an empty editor',
    /manual_order_has_no_checkout_session/.test(modal)
    && /no_checkout_session_for_this_store_order/.test(modal)
    && /order_never_mirrored_to_shopify/.test(modal));
  check('U6 the Edit button is disabled — with a reason in its tooltip — for such an order',
    /disabled=\{editState !== null && editState\.linked === false\}/.test(detail)
    && /edit it in Shopify/i.test(detail));
  check('U6 the edit-state load is fail-open so it can never blank the order page',
    /Fail-open: the edit panel is additive/.test(detail));
}

// ── U7: unmapped server errors are shown RAW ───────────────────────────────
{
  check('U7 the modal falls back to the raw error slug, never to a friendly lie',
    /SAVE_ERRORS\[code\] \|\| \(typeof code === 'string' && code\)/.test(modal));
  check('U7 the failed-payments page does the same',
    /RETRY_ERRORS\[code\] \|\| code \|\|/.test(failed));
  check('U7 stale_version copy tells the operator nothing was applied',
    /nothing here was applied/i.test(modal));
}

// ── U8: the wiring is exactly one additive line in each shared file ────────
{
  check('U8 the dunning page is routed', /path="failed-payments"/.test(appJsx));
  check('U8 the dunning page is in the sidebar under orders:access',
    /\/app\/failed-payments'[^\n]*permission: 'orders:access'/.test(sidebar));
  check('U8 both routers are mounted in routes/index.js',
    /app\.use\('\/api\/v1\/order-edit', orderEditRoutes\)/.test(routesIdx)
    && /app\.use\('\/api\/v1\/dunning', dunningRoutes\)/.test(routesIdx));
  check('U8 the mounts carry the money-seam warning for the next reader',
    /NEVER moves co_sessions/.test(routesIdx) && /RECORDS INTENT ONLY/.test(routesIdx));
}

// ── U9: the detail page reloads BOTH surfaces after an edit ────────────────
{
  const onSaved = detail.match(/onSaved=\{\(\) => \{[\s\S]*?\}\}/);
  check('U9 saving an edit reloads the order AND the edit state (never one alone)',
    Boolean(onSaved) && /load\(\);/.test(onSaved[0]) && /loadEditState\(\);/.test(onSaved[0]),
    onSaved ? onSaved[0].slice(0, 120) : 'onSaved not found');
}

// ── U10: the failed-payments RETRY button gates on the SERVER precondition ──
// The MAJOR fix: a scheduled row on a session with no vaulted card must not
// offer a retry the write path will refuse. The button gates on retry_possible
// (which the server computes), never on state alone.
{
  check('U10 the Request-retry button requires state===scheduled AND retry_possible',
    /r\.state === 'scheduled' && r\.retry_possible &&/.test(failed));
  check('U10 a scheduled row with no saved card shows WHY instead of a dead button',
    /r\.state === 'scheduled' && !r\.retry_possible &&/.test(failed) && /no saved card/i.test(failed));
  // The button must NOT gate on bare state anymore (the exact bug the review
  // called out).
  check('U10 the button no longer gates on {r.state === "scheduled" &&} alone',
    !/\{r\.state === 'scheduled' && \(\s*<Button/.test(failed));
}

// ── U11: the price-drift confirm-again loop ────────────────────────────────
// The commit sends the delta the operator saw; a price_changed refusal forces
// a fresh preview so the new amount is shown before a second Save.
{
  check('U11 the commit sends expected_total_delta (the number the operator saw)',
    /expected_total_delta: p\?\.total_delta/.test(modal));
  check('U11 a price_changed refusal forces a fresh preview via the refresh nonce',
    /code === 'price_changed'\) setRefreshNonce/.test(modal)
    && /refreshNonce\]/.test(modal));
  check('U11 the modal has copy for the price-changed case',
    /A catalog price changed since you last looked/i.test(modal));
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
