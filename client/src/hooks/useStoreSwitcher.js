// W6 — what the sidebar's store dropdown renders from.
//
// The list is NOT built here and is never guessed: it is the {code, name} list the hub SIGNED into the SSO
// ticket this session was opened with, parked on the session row and served by GET /api/v1/store-config
// (server/src/routes/storeConfig.js). R5/R15: no store code, no store name and no hub url is written into
// this bundle — every one of them is data that arrives at runtime.
//
// R21, the detach rule: no hub origin, or an empty list (a local login, or the hub gone), means `enabled`
// is false and the sidebar renders exactly the brand block it renders today. There is no half state.
//
// The read happens once per page load and is shared by every caller, like config/brand.js does for the brand.
import { useEffect, useState } from 'react';
import api from '../services/api';

const EMPTY = Object.freeze({ loading: false, enabled: false, hubOrigin: null, ssoEnabled: false, current: null, stores: [] });

// W6b: the HUB is the authority on what a store code is (store-hub src/repo/scope.js STORE_CODE_RE is
// ^[A-Z0-9]{1,8}$), and this list is the hub's answer, not this store's identity. This dashboard's OWN
// STORE_CODE stays 2-4 characters; the two are different questions, and under W6 the narrower rule here
// silently deleted any hub store outside 2-4 characters from the dropdown.
const STORE_CODE_RE = /^[A-Z0-9]{1,8}$/;
const ROLE_MAX = 24;

/**
 * W6c / R10 P2-1: a BARE origin (scheme + host + port) or null — never a path, a query or a fragment.
 *
 * switchUrl() concatenates this with `/switch/<code>?next=…`, so anything after the authority breaks every
 * link in the dropdown SILENTLY: measured, `https://hub.example.test#x` produced
 * `https://hub.example.test#x/switch/MB?next=%2Fapp%2Fdashboard`, which is the hub root. The server now
 * normalises HUB_ORIGIN the same way (server/src/config/storeConfig.js hub()); this is the client half of
 * the same rule, because the client must not depend on the server's version being deployed first.
 */
export function bareOrigin(value) {
  if (typeof value !== 'string' || value === '') return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return url.origin;
}

/**
 * Defensive read of the server's answer: the server validates, the client refuses to render anything odd.
 * W6b, per ENTRY: an unusable entry is dropped and the rest of the list is rendered — one odd store must not
 * cost the operator every other row. `role` is a LABEL for a pill (never a permission: every gate is taken at
 * the hub), `can_hop` false means the row is shown greyed instead of being hidden.
 */
export function readStoreConfig(data) {
  const hub = data && typeof data === 'object' ? data.hub : null;
  const sw = data && typeof data === 'object' ? data.switcher : null;
  const hubOrigin = bareOrigin(hub?.origin);
  const stores = Array.isArray(sw?.stores)
    ? sw.stores.filter((s) => s && typeof s.code === 'string' && STORE_CODE_RE.test(s.code) && typeof s.name === 'string' && s.name.length > 0 && s.name.length <= 80)
      .map((s) => ({
        code: s.code,
        name: s.name,
        role: typeof s.role === 'string' && s.role.length <= ROLE_MAX ? s.role : '',
        can_hop: typeof s.can_hop === 'boolean' ? s.can_hop : true,
      }))
    : [];
  const current = typeof sw?.current === 'string' && sw.current ? sw.current : null;
  return {
    loading: false,
    enabled: Boolean(hubOrigin) && stores.length > 0,
    hubOrigin,
    ssoEnabled: hub?.sso_enabled === true,
    current,
    stores,
  };
}

/** `<hub>/switch/<code>?next=<relative path>`: the hub re-checks the role, mints the ticket and posts it on. */
export function switchUrl(hubOrigin, code, next = '/app/dashboard') {
  return `${hubOrigin}/switch/${encodeURIComponent(code)}?next=${encodeURIComponent(next)}`;
}

/** `<hub>/#add-store` opens the hub's Add-store wizard on arrival; the hub root is where stores are managed. */
export const addStoreUrl = (hubOrigin) => `${hubOrigin}/#add-store`;
export const manageStoresUrl = (hubOrigin) => `${hubOrigin}/`;

let shared = null;
/** One read per page load, shared. Any failure (401, offline, a server with no hub) resolves to EMPTY. */
function load() {
  shared ??= api.get('/store-config')
    .then((r) => readStoreConfig(r?.data?.data))
    .catch(() => EMPTY);
  return shared;
}

/** Test hook: forget the shared read (the browser check mounts the sidebar more than once). */
export function resetStoreSwitcher() { shared = null; }

export function useStoreSwitcher() {
  const [state, setState] = useState({ ...EMPTY, loading: true });
  useEffect(() => {
    let alive = true;
    load().then((s) => { if (alive) setState(s); });
    return () => { alive = false; };
  }, []);
  return state;
}

export default useStoreSwitcher;
