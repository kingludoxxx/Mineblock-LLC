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

const STORE_CODE_RE = /^[A-Z0-9]{2,4}$/;

/** Defensive read of the server's answer: the server validates, the client refuses to render anything odd. */
export function readStoreConfig(data) {
  const hub = data && typeof data === 'object' ? data.hub : null;
  const sw = data && typeof data === 'object' ? data.switcher : null;
  const hubOrigin = hub && typeof hub.origin === 'string' && /^https?:\/\//.test(hub.origin) ? hub.origin.replace(/\/+$/, '') : null;
  const stores = Array.isArray(sw?.stores)
    ? sw.stores.filter((s) => s && typeof s.code === 'string' && STORE_CODE_RE.test(s.code) && typeof s.name === 'string' && s.name.length > 0 && s.name.length <= 80)
      .map((s) => ({ code: s.code, name: s.name }))
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
