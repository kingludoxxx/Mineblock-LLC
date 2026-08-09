// Serializes async jobs: each enqueued job starts only after the previous one
// SETTLED, in enqueue order. The funnels PATCH is a whole-object replace, so
// two overlapping read-merge-write saves can interleave their GET/PATCH and
// silently drop one — routing every save through one of these queues makes
// each save's fresh GET observe the previous PATCH's commit.
// A failed job rejects ITS OWN returned promise but never wedges the queue.
export function makeSerialQueue() {
  let tail = Promise.resolve();
  return (job) => {
    const run = tail.then(() => job());
    tail = run.catch(() => {}); // swallow only for chaining — `run` still rejects
    return run;
  };
}

// ── THE SETTINGS QUEUE — ONE INSTANCE FOR THE WHOLE MODAL ──────────────────
// Every section of Funnel Settings writes the SAME funnels.settings column
// through the same whole-object PATCH. A per-section queue only serializes a
// section against ITSELF: General's save and Shipping's save each had their own
// queue, so General could GET, Shipping could GET+PATCH, and General's PATCH
// would then land built on the pre-Shipping snapshot — silently reverting it.
// Serializing across SECTIONS is what actually prevents that, so every settings
// save in this modal must enqueue here rather than on a local queue.
//
// Module scope is deliberate: the instance must outlive any single component,
// or remounting a section would hand it a fresh queue and reopen the race.
export const enqueueSettingsSave = makeSerialQueue();
