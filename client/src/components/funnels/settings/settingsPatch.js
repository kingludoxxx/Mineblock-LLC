// Shared non-component helpers for the Funnel Settings sections (kept out of
// the .jsx component files so react-refresh sees only component exports there).
import api from '../../../services/api';
import { enqueueSettingsSave } from './serialQueue';

export const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/**
 * Read-merge-write against the funnels PATCH: re-GET the freshest funnel row,
 * hand it to `build(fresh)`, PATCH the result. Returns the updated funnel row.
 *
 * SERIALIZED HERE, ONCE, FOR EVERY SECTION. `PATCH /funnels/:id` replaces the
 * whole `settings` column, so the GET→PATCH pair is a read-modify-write that
 * is only safe if no other save interleaves with it. Sections used to hold
 * their OWN queues, which serialized each section against itself and nothing
 * else — General could GET, Shipping could GET+PATCH, then General's PATCH
 * would land built on the pre-Shipping snapshot and silently revert it.
 *
 * The queue lives at module scope in ./serialQueue.js so it spans sections AND
 * survives a section remount. CALLERS MUST NOT WRAP THIS IN THE SAME QUEUE —
 * enqueueing from inside a queued job waits on the job that is running it, and
 * that is a deadlock, not a slow save.
 */
export async function saveFunnelPatch(funnelId, build) {
  return enqueueSettingsSave(async () => {
    const res = await api.get(`/funnels/${funnelId}`);
    const fresh = res.data?.data?.funnel || {};
    const body = build(fresh);
    const patched = await api.patch(`/funnels/${funnelId}`, body);
    return patched.data?.data || null;
  });
}
