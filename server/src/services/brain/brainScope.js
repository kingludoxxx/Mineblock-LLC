// THE STORE BRAIN — the READ SCOPE.
//
// S4-SB2 / NEW-1: `approved_only` was enforced inside `parseFilters`, which only
// `GET /search` calls, so `GET /insights` — the same property, the same caller, a
// different door — handed the pipeline actor every PROPOSED and REJECTED insight
// by default, bodies, quotes and citations included. That is the one thing R16
// forbids, reached by a route nobody had re-checked.
//
// A per-route check cannot be trusted with a property like this: the next read
// door added is the next hole. So the rule lives HERE, in the layer every door
// must pass through, and it is MANDATORY — a store read that can surface an
// insight takes a scope, and refuses to run without one. A route that forgets it
// does not quietly leak; it raises `scope_required` and the suite catches it.
//
// Who may see unapproved work is decided by the CREDENTIAL, never by the query
// string: only `brain:approve` (a reviewer, or SuperAdmin's {"*":["*"]}) may.
// The service token — the credential that exists so a pipeline can read — never
// may, by construction: it has no session and therefore no action permission.

import { BrainError } from './brainSchema.js';

/** The only status a caller without `brain:approve` may ever see. */
export const APPROVED = 'approved';

/**
 * Build a scope. The single producer, so "who may read unapproved work" is one
 * expression in the codebase rather than one per route.
 * @param {{mayReadUnapproved?: boolean}} [input]
 */
export function readScope({ mayReadUnapproved = false } = {}) {
  return Object.freeze({ mayReadUnapproved: mayReadUnapproved === true });
}

/** The scope a pipeline / service credential always gets. */
export const SERVICE_SCOPE = readScope({ mayReadUnapproved: false });

/**
 * Every store read that can surface an insight starts with this. A missing or
 * malformed scope is a PROGRAMMING error, not a request error: it means a door
 * was opened that never asked who was knocking. Fail loudly (500) rather than
 * defaulting — a default is how NEW-1 happened.
 */
export function requireReadScope(ctx) {
  if (!ctx || typeof ctx !== 'object' || typeof ctx.mayReadUnapproved !== 'boolean') {
    throw new BrainError('scope_required',
      'internal: a Brain read that can surface insights was attempted with no actor scope — '
      + 'the caller must pass req.brainScope', 500);
  }
  return ctx;
}

/**
 * Refuse an explicit request for unapproved work from a caller who may not see
 * it. ONE message and ONE code (`approval_scope`) for every door, so a pipeline
 * author who hits it on `/search` recognises it on `/insights`.
 * @param {{mayReadUnapproved:boolean}} ctx
 * @param {string} what  the parameter the caller actually sent, quoted back
 */
export function assertMayReadUnapproved(ctx, what) {
  const scope = requireReadScope(ctx);
  if (scope.mayReadUnapproved) return scope;
  throw new BrainError('approval_scope',
    `${what} shows unapproved insights and is limited to reviewers (brain:approve) — `
    + 'a service credential always reads the approved layer', 403);
}

export default { readScope, requireReadScope, assertMayReadUnapproved, SERVICE_SCOPE, APPROVED };
