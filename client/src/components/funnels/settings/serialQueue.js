// Serializes async jobs: each enqueued job starts only after the previous one
// SETTLED, in enqueue order. The funnels PATCH is a whole-object replace, so
// two overlapping read-merge-write saves can interleave their GET/PATCH and
// silently drop one write — routing every save through one of these queues
// makes each save's fresh GET observe the previous PATCH's commit.
// A failed job rejects ITS OWN returned promise but never wedges the queue.
export function makeSerialQueue() {
  let tail = Promise.resolve();
  return (job) => {
    const run = tail.then(() => job());
    tail = run.catch(() => {}); // swallow only for chaining — `run` still rejects
    return run;
  };
}
