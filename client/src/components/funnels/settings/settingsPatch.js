// Shared non-component helpers for the Funnel Settings sections (kept out of
// the .jsx component files so react-refresh sees only component exports there).
import api from '../../../services/api';

export const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

// Fetch the freshest funnel row, merge, PATCH. `build(fresh)` returns the
// PATCH body. Returns the updated funnel row.
export async function saveFunnelPatch(funnelId, build) {
  const res = await api.get(`/funnels/${funnelId}`);
  const fresh = res.data?.data?.funnel || {};
  const body = build(fresh);
  const patched = await api.patch(`/funnels/${funnelId}`, body);
  return patched.data?.data || null;
}

// The save-serialization queue lives in ./serialQueue.js (dependency-free so
// the server-side harness can unit-test it directly).
