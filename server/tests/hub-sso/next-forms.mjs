// W6c / R10 P0-1 — the ONE list of `next` values every guard must refuse, dashboard copy.
//
// THE TWIN OF store-hub/test/next-forms.mjs. It is a copy on purpose: the two guards live in two different
// repos that deploy independently, so there is no module to share — what there IS is one list, written out
// identically in both, named in both comments, so a change to either is visibly a change to a pair.
//
// The three guards this list exists for:
//   1. store-hub src/ui/switcher.mjs  pendingNext()  — the only exploitable one (its answer goes to
//      location.replace()); it ALSO resolves and compares origins, which a character class alone cannot do.
//   2. store-hub src/routes/switcher.js  safeNext()
//   3. THIS repo, server/src/routes/hubSso.js  safeNext()  — `next` becomes a res.redirect() Location.
//
// R10 found the whitespace class: a URL parser STRIPS tab, LF and CR out of a URL before parsing it, so
// `/<TAB>/evil.example` passes a `startsWith('//')` test and is then read as `//evil.example` —
// protocol-relative, off-site. Express's encodeurl neutralises it on THIS side (measured), so this repo was
// never exploitable; the list is enforced here anyway because three guards that disagree about what a path is
// are three chances to be wrong, and the lane's original six-form enumeration read as a complete list.
//
// EVERY string here must be REFUSED. '' is deliberately absent: it is not a bad form, it means "no next",
// and safeNext answers '/' for it (while the hub's client-side pendingNext answers null). See EMPTY_NEXT.

/** @type {{label: string, raw: string, why: string}[]} */
export const BAD_NEXT_FORMS = Object.freeze([
  { label: '//evil.example', raw: '//evil.example', why: 'protocol-relative: the browser reads it as a host' },
  { label: '/\\evil.example', raw: '/\\evil.example', why: 'browsers read a backslash as a slash' },
  { label: 'https://evil.example', raw: 'https://evil.example', why: 'an absolute url' },
  { label: 'javascript:alert(1)', raw: 'javascript:alert(1)', why: 'a scheme, not a path' },
  { label: 'switch/AAA', raw: 'switch/AAA', why: 'relative, not rooted: resolves against whatever page is current' },
  { label: 'data:text/html,x', raw: 'data:text/html,x', why: 'a scheme, not a path' },
  { label: '/%09/evil.example', raw: '/\t/evil.example', why: 'TAB is stripped -> //evil.example' },
  { label: '/%0A/evil.example', raw: '/\n/evil.example', why: 'LF is stripped -> //evil.example' },
  { label: '/%0D/evil.example', raw: '/\r/evil.example', why: 'CR is stripped -> //evil.example' },
  { label: '/%09%2F%2Fevil.example', raw: '/\t//evil.example', why: 'TAB then an explicit // -> //evil.example' },
  { label: '/ /evil', raw: '/ /evil', why: 'a space in a path is a malformed url, not a route this app serves' },
  { label: '/%0D%0ASet-Cookie:%20a=b', raw: '/\r\nSet-Cookie: a=b', why: 'CRLF: header injection if it ever reached a header unencoded' },
  { label: '/%00/evil', raw: '/\u0000/evil', why: 'NUL: a C0 control inside the path' },
]);

/** '' is NOT a bad form: safeNext answers '/' (the SPA's root), which is what "no next" means here. */
export const EMPTY_NEXT = '';

/** A `next` the guard must ACCEPT unchanged — the positive control, so a guard that refuses everything fails. */
export const GOOD_NEXT_FORMS = Object.freeze(['/', '/funnels', '/orders?x=1#frag', '/app/dashboard', '/a/b?x=1']);
