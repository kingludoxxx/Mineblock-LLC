// A minimal positional-hook React runtime, for driving REAL components through
// REAL commits in node — no jsdom, no browser.
//
// It exists because the static render harness (render-smoke) cannot see
// effect-lifecycle bugs at all: renderToStaticMarkup never runs an effect,
// never attaches a ref, and never re-renders. That blind spot shipped a globe
// that never animated, because the rAF effect keyed on `[]` and the canvas did
// not exist on the first commit.
//
// It implements exactly the semantics those bugs live in, in React's order:
//   render → attach/detach refs → run effects (cleanup-then-setup, deps-gated)
//
// It is NOT React. No concurrent mode, no suspense, no context, no children
// rendering (child components stay as unrendered elements in the tree — this
// harness drives ONE component at a time). That is enough to catch every bug in
// this class and small enough to trust.
//
// Consumed via vite aliases (see run-globe-effect.mjs): the component under
// test imports 'react' and gets this module instead.

// ── the hook dispatcher ─────────────────────────────────────────────────────
let cur = null; // the instance being rendered

function slot(init) {
  const h = cur.hooks;
  if (h.length <= cur.idx) h.push(init());
  return h[cur.idx++];
}

const depsChanged = (a, b) => {
  if (a === undefined || b === undefined) return true;
  if (a.length !== b.length) return true;
  return a.some((v, i) => !Object.is(v, b[i]));
};

export function useState(initial) {
  const inst = cur;
  const s = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }));
  const setter = (next) => {
    const v = typeof next === 'function' ? next(s.value) : next;
    if (Object.is(v, s.value)) return;   // React bails out on an identical value
    s.value = v;
    inst.dirty = true;
  };
  return [s.value, setter];
}

export function useRef(initial) {
  return slot(() => ({ current: initial }));
}

export function useMemo(fn, deps) {
  const s = slot(() => ({ deps: undefined, value: undefined }));
  if (depsChanged(s.deps, deps)) { s.value = fn(); s.deps = deps; }
  return s.value;
}

export function useCallback(fn, deps) {
  return useMemo(() => fn, deps);
}

export function useEffect(fn, deps) {
  const inst = cur;
  const s = slot(() => ({ deps: undefined, cleanup: undefined, first: true }));
  if (s.first || depsChanged(s.deps, deps)) {
    s.first = false;
    s.deps = deps;
    // Keyed by SLOT, not appended. React runs effects for the COMMITTED
    // render only — when a callback ref's setState forces an extra render
    // pass before commit, the effect must run ONCE with the final deps, not
    // once per intermediate pass. Appending made a single mount create (and
    // leak) two ResizeObservers.
    inst.pending.set(s, fn);
  }
}

export const useLayoutEffect = useEffect;

export function useSyncExternalStore(subscribe, getSnapshot) {
  const inst = cur;
  const s = slot(() => ({ sub: null, unsub: null }));
  if (s.sub !== subscribe) {
    if (s.unsub) s.unsub();
    s.sub = subscribe;
    s.unsub = subscribe(() => { inst.dirty = true; });
    inst.stores.push(s);
  }
  return getSnapshot();
}

// ── the JSX factory (aliased for react/jsx-runtime) ─────────────────────────
export const Fragment = Symbol('Fragment');
export function jsx(type, props) { return { $$el: true, type, props: props || {} }; }
export const jsxs = jsx;
export const jsxDEV = jsx;
export function createElement(type, props, ...children) {
  return { $$el: true, type, props: { ...(props || {}), children } };
}

// ── ref attachment ──────────────────────────────────────────────────────────
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const n of node) walk(n, visit); return; }
  if (!node.$$el) return;
  visit(node);
  walk(node.props?.children, visit);
}

/** Collect every host element carrying a ref, keyed by a stable identity. */
function collectRefs(tree) {
  const found = [];
  walk(tree, (n) => {
    if (n.props && n.props.ref && typeof n.type === 'string') {
      found.push({ tag: n.type, ref: n.props.ref, node: n });
    }
  });
  return found;
}

/**
 * Mount a component.
 *
 * `makeNode(tag)` builds the fake DOM node handed to a ref — that is where a
 * test injects an instrumented canvas.
 */
export function mount(Component, props, { makeNode = (tag) => ({ tag }) } = {}) {
  const inst = {
    hooks: [], idx: 0, dirty: false, pending: new Map(), stores: [],
    tree: null, props, attached: new Map(), commits: 0, unmounted: false,
  };

  const renderOnce = () => {
    cur = inst;
    inst.idx = 0;
    inst.dirty = false;
    inst.tree = Component(inst.props);
    cur = null;
    inst.commits++;
  };

  const syncRefs = () => {
    const live = collectRefs(inst.tree);
    const liveTags = new Set(live.map((r) => r.tag));
    // Detach refs whose element is gone (React calls them with null).
    for (const [tag, rec] of [...inst.attached]) {
      if (!liveTags.has(tag)) {
        inst.attached.delete(tag);
        if (typeof rec.ref === 'function') rec.ref(null);
      }
    }
    // Attach refs for newly present elements.
    for (const r of live) {
      if (inst.attached.has(r.tag)) continue;
      const node = makeNode(r.tag);
      inst.attached.set(r.tag, { ref: r.ref, node });
      if (typeof r.ref === 'function') r.ref(node);
    }
  };

  const runEffects = () => {
    const queue = inst.pending;
    inst.pending = new Map();
    for (const [s, fn] of queue) {
      if (typeof s.cleanup === 'function') { s.cleanup(); s.cleanup = undefined; }
      const c = fn();
      s.cleanup = typeof c === 'function' ? c : undefined;
    }
  };

  /** One user-visible commit: render (to quiescence), attach refs, run effects. */
  const commit = (nextProps) => {
    if (nextProps !== undefined) inst.props = nextProps;
    renderOnce();
    // A callback ref that calls setState (the canonical "measure the node"
    // pattern, and the fix for the globe) makes the component re-render before
    // effects run. Loop until quiet, exactly as React would.
    for (let guard = 0; guard < 25; guard++) {
      syncRefs();
      if (!inst.dirty) break;
      renderOnce();
    }
    runEffects();
    return inst;
  };

  const unmount = () => {
    inst.unmounted = true;
    for (const [tag, rec] of [...inst.attached]) {
      inst.attached.delete(tag);
      if (typeof rec.ref === 'function') rec.ref(null);
    }
    for (const h of inst.hooks) {
      if (h && typeof h.cleanup === 'function') { h.cleanup(); h.cleanup = undefined; }
      if (h && typeof h.unsub === 'function') { h.unsub(); h.unsub = null; }
    }
  };

  commit(props);

  return {
    get tree() { return inst.tree; },
    get commits() { return inst.commits; },
    node: (tag) => inst.attached.get(tag)?.node || null,
    has: (tag) => collectRefs(inst.tree).some((r) => r.tag === tag),
    find: (tag) => {
      let hit = null;
      walk(inst.tree, (n) => { if (!hit && n.type === tag) hit = n; });
      return hit;
    },
    text: () => {
      const out = [];
      walk(inst.tree, (n) => {
        const c = n.props?.children;
        const push = (v) => { if (typeof v === 'string' || typeof v === 'number') out.push(String(v)); };
        if (Array.isArray(c)) c.forEach(push); else push(c);
        if (n.props && n.props['data-testid']) out.push(`@${n.props['data-testid']}`);
      });
      return out.join(' ');
    },
    rerender: commit,
    unmount,
  };
}

export default { useState, useRef, useMemo, useCallback, useEffect, useLayoutEffect, useSyncExternalStore, mount };
