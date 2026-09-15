// PRODUCT BIBLE PICKER — Product -> Market -> Avatar -> Angle, each with "Auto (best from the bible)".
//
// Emits onChange(selection, meta):
//   selection = { product, market, avatar, angle } (avatar/angle null = auto), or null when no bible applies
//   meta      = { product, market, avatars, angles, loading }  (the loaded bible rows, for callers that render them)
// Renders NOTHING (and emits null) when the store has no product with markets, so pages for other stores are unchanged.
// `productId` is the page's own product: when it has markets the picker follows it, when it has none the picker
// shows "None" and emits null. Picking a product in the picker calls onProductSelect(id) so the page can follow.
// `showAngle={false}` hides the angle step for pages that pick the angle themselves; `hideProduct` hides the product
// step where the page's own product control sits right beside it; `inline` lays the steps out in one wrapping row.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { BookOpen, Loader2, RotateCw } from 'lucide-react';
import { fetchBibleProducts, fetchBibleEntities, peekBibleEntities, bibleErrorText } from './bibleApi';
import {
  AVATAR_TYPE_LABEL, sortAvatars, anglesForAvatar, groupAnglesByTier, fitAvatarNames, toBibleBody,
  sameProduct, loadRemembered, remember, marketLabel,
} from './bibleSelection';

const SELECT_CLS = 'w-full bg-[#0a0a0a] border border-white/[0.06] rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-[#c9a84c]/40 focus:border-[#c9a84c]/30 cursor-pointer appearance-none transition-colors hover:border-white/[0.12] disabled:opacity-50 disabled:cursor-not-allowed truncate';
const SELECT_STYLE = {
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23a1a1aa' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E")`,
  backgroundRepeat: 'no-repeat',
  backgroundPosition: 'right 0.75rem center',
  paddingRight: '2rem',
};
const LABEL_CLS = 'block font-mono text-[10px] font-semibold text-zinc-500 uppercase tracking-[0.15em] mb-1';

export default function BiblePicker({
  productId = null, onChange, onProductSelect, showAngle = true, inline = false, hideProduct = false, className = '',
}) {
  const uid = useId();
  const [products, setProducts] = useState(null); // null = loading
  const [product, setProduct] = useState('');     // bible product id as string, '' = none
  const [market, setMarket] = useState('');
  const [avatar, setAvatar] = useState('');
  const [angle, setAngle] = useState('');
  const [showAllAngles, setShowAllAngles] = useState(false);
  const [avatars, setAvatars] = useState([]);
  const [angles, setAngles] = useState([]);
  const [entLoading, setEntLoading] = useState(false);
  // Which product:market the avatars/angles above belong to. A market switch renders once before its data is
  // in; without this key that render handed the page the PREVIOUS market's angles, then an empty list.
  const [loadedKey, setLoadedKey] = useState('');
  const [entError, setEntError] = useState(null);
  const [retry, setRetry] = useState(0);
  const onChangeRef = useRef(onChange);
  const onProductSelectRef = useRef(onProductSelect);
  onProductSelectRef.current = onProductSelect;
  onChangeRef.current = onChange;
  const pendingRestore = useRef(null);

  useEffect(() => {
    let alive = true;
    fetchBibleProducts()
      .then((list) => { if (alive) setProducts(list); })
      .catch((err) => {
        console.error('[BiblePicker] could not load bible products:', bibleErrorText(err));
        if (alive) setProducts([]);
      });
    return () => { alive = false; };
  }, []);

  const current = useMemo(
    () => (products || []).find((p) => sameProduct(p.id, product)) || null,
    [products, product],
  );
  const markets = current?.markets || [];

  // Follow the page's product.
  useEffect(() => {
    if (!products) return;
    const match = products.find((p) => sameProduct(p.id, productId));
    selectProduct(match ? String(match.id) : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId, products]);

  function selectProduct(id) {
    const p = (products || []).find((x) => sameProduct(x.id, id));
    if (!p) {
      setProduct(''); setMarket(''); setAvatar(''); setAngle('');
      return;
    }
    const saved = loadRemembered(p.id);
    const mk = (p.markets || []).find((m) => m.market_key === saved?.market) || (p.markets || [])[0];
    pendingRestore.current = saved && mk && saved.market === mk.market_key ? saved : null;
    setProduct(String(p.id));
    applyMarket(String(p.id), mk?.market_key || '');
  }

  // Switch market in ONE render: when this page already loaded the market, its avatars + angles go in with it.
  function applyMarket(productKey, marketKey) {
    setMarket(marketKey);
    setAvatar('');
    setAngle('');
    setShowAllAngles(false);
    const av = productKey && marketKey ? peekBibleEntities(productKey, marketKey, 'avatar') : undefined;
    const an = productKey && marketKey ? peekBibleEntities(productKey, marketKey, 'angle') : undefined;
    if (av && an) {
      setAvatars(sortAvatars(av));
      setAngles(an);
      setEntError(null);
      setEntLoading(false);
      setLoadedKey(`${productKey}:${marketKey}`);
    }
  }

  // Load avatars + angles for the chosen market.
  useEffect(() => {
    if (!product || !market) { setAvatars([]); setAngles([]); setEntError(null); setLoadedKey(''); return undefined; }
    const key = `${product}:${market}`;
    const restore = () => {
      const saved = pendingRestore.current;
      pendingRestore.current = null;
      return saved;
    };
    if (loadedKey === key && retry === 0) {
      // Already applied synchronously by applyMarket; only a remembered avatar/angle may still need restoring.
      const saved = restore();
      if (saved) {
        if (saved.avatar && avatars.some((a) => a.key === saved.avatar)) setAvatar(saved.avatar);
        if (saved.angle && angles.some((a) => a.key === saved.angle)) setAngle(saved.angle);
      }
      return undefined;
    }
    let alive = true;
    setEntLoading(true);
    setEntError(null);
    Promise.all([
      fetchBibleEntities(product, market, 'avatar'),
      fetchBibleEntities(product, market, 'angle'),
    ]).then(([av, an]) => {
      if (!alive) return;
      setAvatars(sortAvatars(av));
      setAngles(an);
      setLoadedKey(key);
      const saved = restore();
      if (saved) {
        if (saved.avatar && av.some((a) => a.key === saved.avatar)) setAvatar(saved.avatar);
        if (saved.angle && an.some((a) => a.key === saved.angle)) setAngle(saved.angle);
      }
    }).catch((err) => {
      if (!alive) return;
      setAvatars([]); setAngles([]); setLoadedKey('');
      setEntError(bibleErrorText(err));
    }).finally(() => { if (alive) setEntLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product, market, retry]);

  // Warm every market of the product once, so switching markets never waits on the network.
  useEffect(() => {
    if (!product) return;
    for (const m of markets) {
      for (const type of ['avatar', 'angle']) {
        fetchBibleEntities(product, m.market_key, type)
          .catch((err) => console.warn('[BiblePicker] prefetch failed:', m.market_key, type, bibleErrorText(err)));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product, markets.length]);

  const avatarRow = avatars.find((a) => a.key === avatar) || null;
  const { angles: offeredAngles, filtered } = anglesForAvatar(angles, avatarRow, showAllAngles);
  const tierGroups = groupAnglesByTier(offeredAngles);
  const angleRow = angles.find((a) => a.key === angle) || null;

  // Emit. Never hand out rows that belong to another market.
  const fresh = !!product && !!market && loadedKey === `${product}:${market}`;
  useEffect(() => {
    if (!products) return;
    const sel = product
      ? toBibleBody({ product: Number(product), market, avatar: avatar || null, angle: showAngle ? (angle || null) : null })
      : null;
    if (sel) remember(sel);
    onChangeRef.current?.(sel, {
      product: current, market: markets.find((m) => m.market_key === market) || null,
      avatars: fresh ? avatars : [], angles: fresh ? angles : [], loading: entLoading || (!!sel && !fresh && !entError),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products, product, market, avatar, angle, showAngle, avatars, angles, entLoading, fresh, entError]);

  if (!products || products.length === 0) return null;
  // inline: one wrapping row for toolbars/footers; default: a stacked card for sidebars.
  const field = inline ? 'min-w-[9rem] flex-1 max-w-[16rem]' : '';

  return (
    <div className={`${inline ? 'flex flex-wrap items-start gap-x-3 gap-y-2' : 'space-y-3'} rounded-lg border border-[#c9a84c]/15 bg-[#c9a84c]/[0.03] p-3 ${className}`}>
      <div className={`flex items-center gap-2 ${inline ? 'w-full' : ''}`}>
        <BookOpen className="w-3.5 h-3.5 text-[#c9a84c]" aria-hidden="true" />
        <span className="font-mono text-[10px] font-semibold text-[#c9a84c] uppercase tracking-[0.15em]">Product Bible</span>
        {entLoading && <Loader2 className="w-3 h-3 text-zinc-500 animate-spin ml-auto" aria-label="Loading bible" />}
      </div>

      <div className={field} hidden={hideProduct}>
        <label htmlFor={`${uid}-product`} className={LABEL_CLS}>Product</label>
        <select
          id={`${uid}-product`}
          value={product}
          onChange={(e) => {
            selectProduct(e.target.value);
            // Picking a bible product also picks it on the page, so product_id and bible.product never disagree.
            if (e.target.value) onProductSelectRef.current?.(Number(e.target.value));
          }}
          className={SELECT_CLS}
          style={SELECT_STYLE}
        >
          <option value="">None (no bible)</option>
          {products.map((p) => (
            <option key={p.id} value={String(p.id)}>{p.name}{p.product_code ? ` (${p.product_code})` : ''}</option>
          ))}
        </select>
      </div>

      {product && markets.length > 0 && (
        <div className={field}>
          <span id={`${uid}-market`} className={LABEL_CLS}>Market</span>
          <div role="radiogroup" aria-labelledby={`${uid}-market`} className="flex flex-wrap gap-1.5">
            {markets.map((m) => {
              const on = m.market_key === market;
              return (
                <button
                  key={m.market_key}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => { if (!on) { pendingRestore.current = null; applyMarket(product, m.market_key); } }}
                  className={`px-2.5 py-1 text-xs rounded-md border transition-colors cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-[#c9a84c]/50 ${
                    on
                      ? 'bg-[#c9a84c]/10 border-[#c9a84c]/30 text-[#e8d5a3]'
                      : 'bg-white/[0.02] border-white/[0.05] text-zinc-400 hover:border-white/[0.1] hover:text-zinc-200'
                  }`}
                >
                  {marketLabel(m)}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {product && market && entError && (
        <div className={`flex items-center gap-2 text-[11px] text-red-400 ${inline ? 'w-full' : ''}`} role="alert">
          <span className="flex-1 min-w-0 break-words">Bible failed to load: {entError}</span>
          <button type="button" onClick={() => setRetry((n) => n + 1)} className="inline-flex items-center gap-1 text-zinc-400 hover:text-white cursor-pointer">
            <RotateCw className="w-3 h-3" /> Retry
          </button>
        </div>
      )}

      {product && market && !entError && (
        <>
          <div className={field}>
            <label htmlFor={`${uid}-avatar`} className={LABEL_CLS}>Avatar</label>
            <select
              id={`${uid}-avatar`}
              value={avatar}
              disabled={entLoading}
              onChange={(e) => setAvatar(e.target.value)}
              className={SELECT_CLS}
              style={SELECT_STYLE}
            >
              <option value="">Auto (best from the bible)</option>
              {avatars.map((a) => (
                <option key={a.key} value={a.key}>
                  {(a.title || a.key)}{a.data?.type ? ` · ${AVATAR_TYPE_LABEL[a.data.type] || a.data.type}` : ''}
                </option>
              ))}
            </select>
          </div>

          {showAngle && (
            <div className={field}>
              <div className="flex items-center justify-between gap-2">
                <label htmlFor={`${uid}-angle`} className={LABEL_CLS}>Angle</label>
                {avatarRow && (filtered || showAllAngles) && (
                  <label className="flex items-center gap-1 text-[10px] text-zinc-500 mb-1 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={showAllAngles}
                      onChange={(e) => setShowAllAngles(e.target.checked)}
                      className="accent-[#c9a84c]"
                    />
                    All angles
                  </label>
                )}
              </div>
              <select
                id={`${uid}-angle`}
                value={angle}
                disabled={entLoading}
                onChange={(e) => setAngle(e.target.value)}
                className={SELECT_CLS}
                style={SELECT_STYLE}
              >
                <option value="">Auto (best from the bible)</option>
                {angleRow && !offeredAngles.includes(angleRow) && (
                  <option value={angleRow.key}>{angleRow.title || angleRow.key}</option>
                )}
                {tierGroups.map((g) => (
                  <optgroup key={g.tier} label={g.tier === 'Other' ? 'Other' : `Tier ${g.tier}`}>
                    {g.angles.map((a) => (
                      <option key={a.key} value={a.key}>{a.title || a.key}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <p className="text-[10px] text-zinc-500 mt-1 leading-snug break-words">
                {angleRow
                  ? (() => {
                    const names = fitAvatarNames(angleRow, avatars);
                    return `${angleRow.tier ? `Tier ${angleRow.tier}. ` : ''}Fits: ${names.length ? names.join(', ') : 'no linked avatar'}`;
                  })()
                  : avatarRow && filtered
                    ? `${offeredAngles.length} angle${offeredAngles.length === 1 ? '' : 's'} linked to this avatar`
                    : `${angles.length} angle${angles.length === 1 ? '' : 's'} in this market`}
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
