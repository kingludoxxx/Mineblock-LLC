// useCostSaves — THE inline cost save. There is exactly one of these
// (NEW FILE, costs lane; ported from the reference hook).
//
// Two surfaces price a variant in place (the Variants grid and the By-funnel
// table) and they hold DIFFERENT trees of the same rows. A rate row is a
// SNAPSHOT, not a patch: a shipping write carries the variant's current
// `unit_cogs` forward and a cost write carries its current `ship` map forward.
// If a page patched one tree and forgot another, the NEXT inline edit on the
// same variant would build its body from the stale copy and post
// `unit_cogs: null` over a cost the operator just typed — silently erasing it
// in the append-only ledger. So the write lives here, once; the host
// contributes only `applyPatch` (map a patch over every tree it holds) and
// `reload` (its authoritative refetch).
//
// WHAT IS DELIBERATELY NOT SENT: no `effective_from`, no `only_from_today`.
// The server backdates a variant's FIRST cost to its first sale and starts a
// later one today. Pinning belongs to the RateDrawer.
//
// `value` arrives already null-vs-0 correct from `parseCostInput`: null means
// UNKNOWN and clears; a real 0.00 can only come from the drawer's known-free
// checkbox. This hook never coerces one into the other.
import { useCallback, useState } from 'react';

import { costApiError, postRate } from './costsApi.js';
import { buildInlineRateBody, buildInlineShipBody } from './costTargets.js';

/**
 * @param {(variantId, patch) => void} applyPatch  patch every copy of the row
 *        the host holds — called BEFORE the POST so the cell does not flicker
 *        back to a dash, and so the next edit builds from a current row.
 * @param {(opts?: {quiet?: boolean}) => Promise<void>} reload  the host's
 *        authoritative refetch, awaited in `finally` (an inline write moves
 *        coverage and at-risk money, which a row patch cannot recompute).
 * @param {(msg: string|null, isError?: boolean) => void} [notify]
 *        host status line (no toast library in this client).
 */
export default function useCostSaves({ applyPatch, reload, notify }) {
  const [savingId, setSavingId] = useState(null);

  const say = useCallback((msg, isError) => { notify?.(msg, Boolean(isError)); }, [notify]);

  const saveCogs = useCallback(async (row, value) => {
    setSavingId(row.variant_id);
    applyPatch(row.variant_id, (v) => ({
      ...v,
      unit_cogs: value,
      cogs_source: value === null ? null : 'variant',
    }));
    try {
      // The POST echoes the rate it wrote, so the message names the day the
      // SERVER resolved rather than the day the grid assumed.
      const saved = await postRate(buildInlineRateBody(row, value));
      const from = saved?.effective_from;
      say(value === null
        ? 'Cost cleared to unknown'
        : (from ? `Cost saved — applies from ${from}` : 'Cost saved'));
    } catch (e) {
      say(costApiError(e, 'Could not save the cost'), true);
    } finally {
      setSavingId(null);
      await reload({ quiet: true });
    }
  }, [applyPatch, reload, say]);

  const saveShip = useCallback(async (row, context, value) => {
    setSavingId(row.variant_id);
    applyPatch(row.variant_id, (v) => ({
      ...v,
      ship: { ...(v.ship || {}), [context]: value },
    }));
    try {
      const saved = await postRate(buildInlineShipBody(row, context, value));
      const from = saved?.effective_from;
      say(value === null
        ? `${context} shipping cleared to unknown`
        : (from ? `Shipping saved — applies from ${from}` : 'Shipping saved'));
    } catch (e) {
      say(costApiError(e, 'Could not save the shipping cost'), true);
    } finally {
      setSavingId(null);
      await reload({ quiet: true });
    }
  }, [applyPatch, reload, say]);

  return { savingId, saveCogs, saveShip };
}
