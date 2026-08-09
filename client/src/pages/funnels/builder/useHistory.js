// PAGE BUILDER — client-side undo/redo history for the blocks array.
//
// Snapshot-based: past[] / present / future[]. Commits with the same `tag`
// arriving within COALESCE_MS collapse into one history entry so typing a
// sentence into a prop is ONE undo step, not thirty. Structural ops (insert /
// delete / reorder) pass distinct tags and always cut a new entry.
//
// All stack logic runs SYNCHRONOUSLY against a ref (not inside React state
// updaters): undo()/redo() must return the restored value to their caller so
// the autosave can be scheduled — a value computed inside setState's updater
// would not be visible until after this function already returned.
//
// The stacks stay in refs, but their EMPTINESS is mirrored into state. Reading
// `pastRef.current.length` straight out of the return value was a ref read
// during render (react-hooks/refs): the Undo button's disabled state then rode
// on whatever OTHER state change happened to re-render next, so the first
// commit after a reset could leave Undo greyed out until an unrelated
// keystroke woke it up.
import { useCallback, useRef, useState } from 'react';

const COALESCE_MS = 700;
const MAX_DEPTH = 100;

export default function useHistory(initial) {
  const [present, setPresent] = useState(initial);
  const presentRef = useRef(initial);
  const pastRef = useRef([]);
  const futureRef = useRef([]);
  const lastCommitRef = useRef({ tag: null, at: 0 });
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  // Called at the END of every stack mutation. Cheap booleans, so React bails
  // out of the re-render whenever nothing actually changed.
  const syncFlags = useCallback(() => {
    setCanUndo(pastRef.current.length > 0);
    setCanRedo(futureRef.current.length > 0);
  }, []);

  const reset = useCallback((value) => {
    pastRef.current = [];
    futureRef.current = [];
    lastCommitRef.current = { tag: null, at: 0 };
    presentRef.current = value;
    setPresent(value);
    syncFlags();
  }, [syncFlags]);

  const commit = useCallback((updater, tag = 'edit') => {
    const prev = presentRef.current;
    const next = typeof updater === 'function' ? updater(prev) : updater;
    if (next === prev) return prev;
    const now = Date.now();
    const last = lastCommitRef.current;
    const coalesce = last.tag === tag && now - last.at < COALESCE_MS && pastRef.current.length > 0;
    if (!coalesce) {
      pastRef.current.push(prev);
      if (pastRef.current.length > MAX_DEPTH) pastRef.current.shift();
    }
    futureRef.current = [];
    lastCommitRef.current = { tag, at: now };
    presentRef.current = next;
    setPresent(next);
    syncFlags();
    return next;
  }, [syncFlags]);

  const undo = useCallback(() => {
    if (!pastRef.current.length) return null;
    const previous = pastRef.current.pop();
    futureRef.current.push(presentRef.current);
    lastCommitRef.current = { tag: null, at: 0 };
    presentRef.current = previous;
    setPresent(previous);
    syncFlags();
    return previous;
  }, [syncFlags]);

  const redo = useCallback(() => {
    if (!futureRef.current.length) return null;
    const next = futureRef.current.pop();
    pastRef.current.push(presentRef.current);
    lastCommitRef.current = { tag: null, at: 0 };
    presentRef.current = next;
    setPresent(next);
    syncFlags();
    return next;
  }, [syncFlags]);

  return { present, commit, undo, redo, reset, canUndo, canRedo };
}
