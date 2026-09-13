// Create-on-first-save for a record the operator opens as a DRAFT (golden path P0.5).
//
// "Add Product" used to POST a blank product the instant it was clicked, so every click left a junk row in a live
// library. A draft is now written only when the operator saves something, and every save that races the first one
// shares its single create instead of making its own.
//
//   ensure(payload) -> { id, created }
//   created is true ONLY for the call that issued the create: its payload rode inside it and needs no second write.
//   A call that merely WAITED on that create still has its own edit to write.
export function makeDraftCreator({ create, onCreated = () => {}, initialId = null }) {
  let id = initialId;
  let inflight = null;
  return {
    get id() { return id; },
    reset(nextId = null) { id = nextId; inflight = null; },
    async ensure(payload = {}) {
      if (id) return { id, created: false };
      let initiated = false;
      if (!inflight) {
        initiated = true;
        inflight = Promise.resolve()
          .then(() => create(payload))
          .then((record) => {
            if (!record || !record.id) throw new Error('create returned no id');
            id = record.id;
            onCreated(record);
            return record;
          })
          .catch((err) => { inflight = null; throw err; });   // a failed create can be retried by the next save
      }
      const record = await inflight;
      return { id: record.id, created: initiated };
    },
  };
}
