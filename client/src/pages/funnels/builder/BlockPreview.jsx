// PAGE BUILDER — canvas block previews.
//
// Faithful STRUCTURAL approximations of the server renderer's output
// (funnelRender.js), in the light buyer theme. Deliberately NOT the server
// renderer: no dangerouslySetInnerHTML anywhere in the admin DOM. All operator
// text renders through React text nodes (auto-escaped). Operator HTML props
// (custom_html / html / section html / row columns) preview inside a fully
// sandboxed iframe (sandbox="" — no scripts, no same-origin) so hostile HTML
// typed into a prop can never execute in the admin surface.
import { useMemo } from 'react';
import { CreditCard, ReceiptText, Film, Image as ImageIcon, Code2 } from 'lucide-react';

const T = {
  text: '#374151',
  faint: '#6B7280',
  dark: '#111827',
  border: '#E5E7EB',
  muted: '#F9FAFB',
  primary: '#2563EB',
  secondary: '#10B981',
  accent: '#F59E0B',
};

const isHttpUrl = (v) => /^https?:\/\//i.test(String(v || '').trim());

// Fully sandboxed HTML preview. sandbox="" (no tokens): scripts cannot run,
// no same-origin access, no top navigation, no forms. The minimal base style
// approximates the buyer theme so the preview is representative.
export function SandboxedHtml({ html, css = '', pageCss = '', height = 140 }) {
  const srcDoc = useMemo(() => {
    const base =
      'html,body{margin:0;padding:8px;font-family:Inter,system-ui,sans-serif;' +
      `font-size:14px;line-height:1.5;color:${T.text};background:#fff;}` +
      'img{max-width:100%;height:auto;}';
    return `<!DOCTYPE html><html><head><style>${base}</style><style>${pageCss || ''}</style><style>${css || ''}</style></head><body>${html || ''}</body></html>`;
  }, [html, css, pageCss]);
  return (
    <iframe
      title="Sandboxed HTML preview"
      sandbox=""
      srcDoc={srcDoc}
      style={{ width: '100%', height, border: 0, display: 'block', background: '#fff', pointerEvents: 'none' }}
    />
  );
}

function HtmlChip({ label = 'Raw HTML — sandboxed preview' }) {
  return (
    <div
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 10, fontWeight: 600,
        textTransform: 'uppercase', letterSpacing: '0.06em', color: T.faint,
        padding: '2px 8px', background: T.muted, border: `1px solid ${T.border}`,
        borderRadius: 6, marginBottom: 6,
      }}
    >
      <Code2 size={11} /> {label}
    </div>
  );
}

function MediaPlaceholder({ icon: Icon, label }) {
  return (
    <div
      style={{
        border: `1px dashed ${T.border}`, borderRadius: 10, padding: 28, textAlign: 'center',
        color: T.faint, background: T.muted, fontSize: 13,
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
      }}
    >
      <Icon size={22} />
      <span style={{ wordBreak: 'break-all' }}>{label}</span>
    </div>
  );
}

function Btn({ children, block: blk }) {
  return (
    <span
      style={{
        display: 'inline-block', background: T.primary, color: '#fff', padding: '12px 20px',
        borderRadius: 12, fontWeight: 600, fontSize: 14, width: blk ? '100%' : undefined,
        textAlign: 'center', boxSizing: 'border-box',
      }}
    >
      {children}
    </span>
  );
}

export default function BlockPreview({ block, pageCss = '' }) {
  const p = block?.props && typeof block.props === 'object' ? block.props : {};
  switch (block?.type) {
    case 'heading': {
      const level = Math.max(1, Math.min(parseInt(p.level, 10) || 2, 6));
      const Tag = `h${level}`;
      const sizes = { 1: 34, 2: 27, 3: 22, 4: 19, 5: 16, 6: 14 };
      return (
        <Tag style={{ color: T.dark, fontWeight: 700, lineHeight: 1.2, margin: 0, fontSize: sizes[level] }}>
          {String(p.text || '')}
        </Tag>
      );
    }
    case 'text': {
      if (p.html) {
        return (
          <div>
            <HtmlChip label="Text with custom HTML — sandboxed" />
            <SandboxedHtml html={String(p.html)} pageCss={pageCss} height={100} />
          </div>
        );
      }
      return <div style={{ color: T.text, fontSize: 15, whiteSpace: 'pre-wrap' }}>{String(p.text || '')}</div>;
    }
    case 'button':
      return (
        <div>
          <Btn>{String(p.text || 'Click')}</Btn>
          <div style={{ fontSize: 11, color: T.faint, marginTop: 4, fontFamily: 'monospace' }}>
            → {String(block?.interaction?.href || p.href || '#')}
          </div>
        </div>
      );
    case 'image': {
      const src = String(p.src || '');
      if (isHttpUrl(src)) {
        return (
          <figure style={{ margin: 0 }}>
            <img src={src} alt={String(p.alt || '')} style={{ maxWidth: '100%', height: 'auto', borderRadius: 8, display: 'block' }} />
          </figure>
        );
      }
      return <MediaPlaceholder icon={ImageIcon} label={src ? `Image: ${src}` : 'Image — set a URL in the panel'} />;
    }
    case 'video': {
      const src = String(p.src || '');
      return <MediaPlaceholder icon={Film} label={src ? `Video: ${src}` : 'Video — set a URL in the panel'} />;
    }
    case 'divider':
      return <hr style={{ border: 0, borderTop: `1px solid ${T.border}`, margin: '8px 0' }} />;
    case 'spacer': {
      const h = Math.max(4, Math.min(parseInt(p.height, 10) || 32, 400));
      return (
        <div
          style={{
            height: h, background: `repeating-linear-gradient(45deg,#f3f4f6,#f3f4f6 6px,#fafafa 6px,#fafafa 12px)`,
            borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: T.faint, fontSize: 11,
          }}
        >
          spacer · {h}px
        </div>
      );
    }
    case 'section':
      return (
        <div style={{ padding: 8, background: p.background && String(p.background).length < 64 ? String(p.background) : undefined, borderRadius: 8 }}>
          <HtmlChip label={`Section — sandboxed (pad ${String(p.padding || '48px 24px')})`} />
          <SandboxedHtml html={String(p.html || '')} pageCss={pageCss} height={130} />
        </div>
      );
    case 'row': {
      const cols = Array.isArray(p.columns) ? p.columns : [];
      return (
        <div>
          <HtmlChip label={`Row — ${cols.length} column${cols.length === 1 ? '' : 's'}, sandboxed`} />
          <div style={{ display: 'flex', gap: Math.max(0, parseInt(p.gap, 10) || 16), flexWrap: 'wrap' }}>
            {cols.map((c, i) => (
              <div key={i} style={{ flex: '1 1 160px', minWidth: 0, border: `1px dashed ${T.border}`, borderRadius: 8, overflow: 'hidden' }}>
                <SandboxedHtml html={String((c && c.html) || '')} pageCss={pageCss} height={90} />
              </div>
            ))}
            {!cols.length && <div style={{ color: T.faint, fontSize: 13 }}>No columns yet.</div>}
          </div>
        </div>
      );
    }
    case 'custom_html':
      return (
        <div>
          <HtmlChip label="Custom HTML — sandboxed preview" />
          <SandboxedHtml html={String(p.html || '')} css={String(p.css || '')} pageCss={pageCss} height={150} />
        </div>
      );
    case 'html':
    case 'embed':
      return (
        <div>
          <HtmlChip label="Raw HTML / Embed — sandboxed preview (scripts run only on the live page)" />
          <SandboxedHtml html={String(p.html || '')} pageCss={pageCss} height={220} />
        </div>
      );
    case 'hero':
      return (
        <section style={{ padding: '40px 20px', textAlign: 'center', background: T.muted, borderRadius: 10 }}>
          <h1 style={{ color: T.dark, fontSize: 30, margin: '0 0 8px', lineHeight: 1.2 }}>{String(p.headline || '')}</h1>
          <p style={{ color: T.faint, margin: '0 0 16px' }}>{String(p.subheadline || '')}</p>
          <Btn>{String(p.cta_text || 'Learn more')}</Btn>
        </section>
      );
    case 'list':
      return (
        <ul style={{ color: T.text, margin: 0, paddingLeft: 22, fontSize: 15 }}>
          {(Array.isArray(p.items) ? p.items : []).map((it, i) => <li key={i}>{String(it)}</li>)}
        </ul>
      );
    case 'checklist':
      return (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, color: T.text, fontSize: 15 }}>
          {(Array.isArray(p.items) ? p.items : []).map((it, i) => (
            <li key={i} style={{ padding: '4px 0', display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ width: 20, height: 20, lineHeight: '20px', textAlign: 'center', background: T.secondary, color: '#fff', borderRadius: 999, fontSize: 11, flexShrink: 0 }}>✓</span>
              <span>{String(it)}</span>
            </li>
          ))}
        </ul>
      );
    case 'testimonial':
      return (
        <blockquote style={{ borderLeft: `4px solid ${T.primary}`, padding: '8px 16px', margin: 0, fontStyle: 'italic', color: T.faint }}>
          <p style={{ margin: '0 0 6px', color: T.text }}>{String(p.quote || '')}</p>
          <footer style={{ fontSize: 13 }}>— {String(p.author || 'Anonymous')}</footer>
        </blockquote>
      );
    case 'faq':
      return (
        <section>
          <h2 style={{ color: T.dark, fontSize: 20, margin: '0 0 10px' }}>{String(p.title || 'FAQ')}</h2>
          {(Array.isArray(p.items) ? p.items : []).filter((x) => x && typeof x === 'object').map((q, i) => (
            <div key={i} style={{ background: T.muted, border: `1px solid ${T.border}`, borderRadius: 10, padding: 12, marginBottom: 8 }}>
              <div style={{ fontWeight: 600, color: T.dark, fontSize: 14 }}>{String(q.q || '')}</div>
              <div style={{ color: T.faint, fontSize: 13, marginTop: 4 }}>{String(q.a || '')}</div>
            </div>
          ))}
        </section>
      );
    case 'ranking':
      return (
        <section>
          <h2 style={{ color: T.dark, fontSize: 20, margin: '0 0 10px' }}>{String(p.title || 'Top Picks')}</h2>
          {(Array.isArray(p.items) ? p.items : []).filter((x) => x && typeof x === 'object').map((it, i) => (
            <article key={i} style={{ background: T.muted, border: `1px solid ${T.border}`, borderRadius: 10, padding: 12, marginBottom: 8, display: 'flex', gap: 12 }}>
              <span style={{ fontSize: 24, fontWeight: 700, color: T.primary, minWidth: 44 }}>#{String(it.rank ?? i + 1)}</span>
              <div>
                <div style={{ fontWeight: 700, color: T.dark }}>{String(it.name || '')}</div>
                <div style={{ color: T.faint, fontSize: 13 }}>{String(it.summary || '')}</div>
                <span style={{ display: 'inline-block', marginTop: 4, padding: '1px 8px', background: T.accent, color: '#fff', borderRadius: 999, fontSize: 12, fontWeight: 600 }}>
                  {String(it.score ?? '')}/10
                </span>
              </div>
            </article>
          ))}
        </section>
      );
    case 'comparison_table': {
      const rows = (Array.isArray(p.rows) ? p.rows : []).filter((r) => r && typeof r === 'object' && !Array.isArray(r));
      const cols = rows.length ? Object.keys(rows[0]).filter((k) => k !== 'feature') : [];
      return (
        <section>
          <h2 style={{ color: T.dark, fontSize: 20, margin: '0 0 10px' }}>{String(p.title || 'Comparison')}</h2>
          <table style={{ width: '100%', borderCollapse: 'collapse', border: `1px solid ${T.border}`, fontSize: 13, color: T.text }}>
            <thead>
              <tr style={{ background: T.muted }}>
                <th style={{ padding: 8, textAlign: 'left', borderBottom: `1px solid ${T.border}` }}>Feature</th>
                {cols.map((c) => <th key={c} style={{ padding: 8, textAlign: 'left', borderBottom: `1px solid ${T.border}` }}>{c}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <th style={{ padding: 8, textAlign: 'left', background: T.muted, borderBottom: `1px solid ${T.border}` }}>{String(r.feature ?? '')}</th>
                  {cols.map((c) => <td key={c} style={{ padding: 8, borderBottom: `1px solid ${T.border}` }}>{String(r[c] ?? '')}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      );
    }
    case 'product_grid':
      return (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))', gap: 10 }}>
          {(Array.isArray(p.items) ? p.items : []).filter((x) => x && typeof x === 'object').map((it, i) => (
            <article key={i} style={{ background: T.muted, border: `1px solid ${T.border}`, borderRadius: 10, padding: 10, textAlign: 'center' }}>
              {isHttpUrl(it.image)
                ? <img src={String(it.image)} alt="" style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: 8 }} />
                : <div style={{ aspectRatio: '1', background: '#eee', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.faint }}><ImageIcon size={18} /></div>}
              <div style={{ fontWeight: 700, color: T.dark, fontSize: 13, marginTop: 6 }}>{String(it.name || '')}</div>
              <div style={{ color: T.faint, fontSize: 12 }}>{String(it.summary || '')}</div>
              <div style={{ marginTop: 6 }}><Btn>{String(it.cta || 'View')}</Btn></div>
            </article>
          ))}
        </div>
      );
    case 'table': {
      const rows = (Array.isArray(p.rows) ? p.rows : []).filter(Array.isArray);
      return (
        <table style={{ width: '100%', borderCollapse: 'collapse', border: `1px solid ${T.border}`, fontSize: 13, color: T.text }}>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>{r.map((c, j) => <td key={j} style={{ padding: 8, borderBottom: `1px solid ${T.border}` }}>{String(c)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      );
    }
    case 'countdown':
      return (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', color: T.text, fontSize: 15 }}>
          <span>{String(p.label || 'Offer ends in')}</span>
          <span style={{ fontWeight: 700, fontFamily: 'monospace', color: T.dark }}>23:59:59</span>
          <span style={{ fontSize: 11, color: T.faint }}>(live on the public page)</span>
        </div>
      );
    case 'sticky_cta':
      return (
        <div style={{ textAlign: 'center' }}>
          <span style={{ display: 'inline-block', background: T.primary, color: '#fff', padding: '10px 24px', borderRadius: 999, fontWeight: 600, fontSize: 14, boxShadow: '0 4px 16px rgba(0,0,0,0.15)' }}>
            {String(p.text || 'Buy Now')}
          </span>
          <div style={{ fontSize: 11, color: T.faint, marginTop: 4 }}>Sticky — floats at the bottom of the live page</div>
        </div>
      );
    case 'whop_checkout': {
      const items = Array.isArray(p.line_items) && p.line_items.length
        ? p.line_items
        : (p.variant_id ? [{ variant_id: p.variant_id, quantity: p.quantity || 1 }] : []);
      return (
        <div style={{ maxWidth: 460, margin: '0 auto', padding: 16, border: `1px solid ${T.border}`, borderRadius: 12, background: '#fff' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: T.dark, fontWeight: 700, fontSize: 14, marginBottom: 8 }}>
            <CreditCard size={16} /> Whop embedded checkout
          </div>
          {items.length ? (
            items.map((li, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: T.text, padding: '4px 0', borderBottom: `1px solid ${T.border}` }}>
                <span style={{ fontFamily: 'monospace' }}>variant {String(li?.variant_id ?? '?')}</span>
                <span>× {String(li?.quantity ?? 1)}</span>
              </div>
            ))
          ) : (
            <div style={{ color: '#b91c1c', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: 10, fontSize: 13 }}>
              No product configured yet — set a variant in the Wiring section.
            </div>
          )}
          <div style={{ marginTop: 10, border: `1px dashed ${T.border}`, borderRadius: 8, padding: 18, textAlign: 'center', color: T.faint, fontSize: 12 }}>
            Payment form mounts here on the live page (server-priced)
          </div>
          <div style={{ marginTop: 10 }}><Btn blk>{String(p.button_text || 'Complete order')}</Btn></div>
        </div>
      );
    }
    case 'order_summary':
      return (
        <section style={{ maxWidth: 460, margin: '0 auto', padding: 16, border: `1px solid ${T.border}`, borderRadius: 12, background: '#fff' }}>
          <h3 style={{ margin: '0 0 10px', fontSize: 16, color: T.dark, display: 'flex', alignItems: 'center', gap: 8 }}>
            <ReceiptText size={16} /> {String(p.title || 'Order summary')}
          </h3>
          <div style={{ color: T.faint, fontSize: 13 }}>Filled at runtime from the server-priced session.</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, color: T.dark, borderTop: `2px solid ${T.border}`, marginTop: 10, paddingTop: 8, fontSize: 14 }}>
            <span>Total</span><span>$ —</span>
          </div>
        </section>
      );
    case 'upsell_offer':
      return (
        <section style={{ maxWidth: 520, margin: '0 auto', padding: 18, border: `1px solid ${T.border}`, borderRadius: 12, background: '#fff', textAlign: 'center' }}>
          <div style={{ fontWeight: 800, fontSize: 20, color: T.dark }}>{String(p.headline || 'Wait — one exclusive offer before you go')}</div>
          <p style={{ color: T.faint, fontSize: 13, margin: '6px 0 12px' }}>{String(p.subheadline || '')}</p>
          <div style={{ border: `1px dashed ${T.border}`, borderRadius: 10, padding: 14, color: T.faint, fontSize: 12, marginBottom: 12 }}>
            Offer name, image + PRICE load at runtime (server-priced{p.offer_id ? `, offer ${String(p.offer_id)}` : ', page default offer'})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Btn blk>{String(p.accept_text || 'Add this to my order')}</Btn>
            <span style={{ color: T.faint, fontSize: 13, textDecoration: 'underline' }}>{String(p.decline_text || 'No thanks')}</span>
          </div>
          {p.fine_print ? <p style={{ color: T.faint, fontSize: 11, marginTop: 10 }}>{String(p.fine_print)}</p> : null}
        </section>
      );
    case 'order_bump':
      return (
        <div style={{ border: '2px dashed #f59e0b', borderRadius: 12, background: '#fffbeb', padding: '16px 18px' }}>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
            <input type="checkbox" checked={p.checked === true} readOnly style={{ marginTop: 3, width: 18, height: 18, accentColor: '#f59e0b', pointerEvents: 'none' }} />
            <span style={{ flex: 1, fontWeight: 600, color: T.dark, fontSize: 14 }}>
              {String(p.label || 'Yes! Add this one-time offer to my order')}
            </span>
            {p.price != null && String(p.price).trim() !== '' && (
              <span style={{ fontWeight: 700, color: T.dark, whiteSpace: 'nowrap', fontSize: 14 }}>{String(p.price)}</span>
            )}
          </label>
          {p.description != null && String(p.description).trim() !== '' && (
            <p style={{ margin: '8px 0 0 28px', color: T.faint, fontSize: 13 }}>{String(p.description)}</p>
          )}
          <div style={{ marginLeft: 28, marginTop: 6, fontSize: 11, color: T.faint }}>
            Visual block — the checkbox does not charge yet
          </div>
        </div>
      );
    case 'shipping_method': {
      const opts = (Array.isArray(p.options) ? p.options : []).filter((o) => o && typeof o === 'object' && !Array.isArray(o));
      return (
        <div>
          {p.title != null && String(p.title).trim() !== '' && (
            <div style={{ fontWeight: 700, color: T.dark, marginBottom: 4, fontSize: 14 }}>{String(p.title)}</div>
          )}
          {opts.length ? opts.map((o, i) => (
            <label key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', border: `1px solid ${T.border}`, borderRadius: 10, margin: '8px 0', background: '#fff' }}>
              <input type="radio" checked={i === 0} readOnly style={{ pointerEvents: 'none' }} />
              <span style={{ flex: 1, color: T.text, fontSize: 14 }}>{String(o.label ?? '')}</span>
              <span style={{ fontWeight: 600, color: T.dark, fontSize: 14 }}>{String(o.price ?? '')}</span>
            </label>
          )) : (
            <div style={{ color: T.faint, fontSize: 13 }}>No shipping options yet — add them in the panel.</div>
          )}
          <div style={{ fontSize: 11, color: T.faint }}>Display strings only — shipping totals stay server-side</div>
        </div>
      );
    }
    case 'product':
      return (
        <article style={{ border: `1px solid ${T.border}`, borderRadius: 12, background: '#fff', padding: 20, textAlign: 'center', maxWidth: 460, margin: '0 auto' }}>
          {isHttpUrl(p.image)
            ? <img src={String(p.image)} alt="" style={{ width: '100%', maxWidth: 320, borderRadius: 10, display: 'block', margin: '0 auto 12px' }} />
            : <div style={{ maxWidth: 320, aspectRatio: '4/3', margin: '0 auto 12px', background: T.muted, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.faint }}><ImageIcon size={20} /></div>}
          <h3 style={{ margin: 0, color: T.dark, fontSize: 18 }}>{String(p.name || p.title || 'Product')}</h3>
          {p.description != null && String(p.description).trim() !== '' && (
            <p style={{ color: T.faint, margin: '4px 0 0', fontSize: 13 }}>{String(p.description)}</p>
          )}
          {p.price != null && String(p.price).trim() !== '' && (
            <div style={{ fontWeight: 700, fontSize: 17, color: T.dark, marginTop: 8 }}>{String(p.price)}</div>
          )}
          {p.cta_text != null && String(p.cta_text).trim() !== '' && (
            <div style={{ marginTop: 12 }}><Btn>{String(p.cta_text)}</Btn></div>
          )}
        </article>
      );
    case 'checkout_template':
      return (
        <div style={{ border: `1px dashed ${T.border}`, borderRadius: 10, padding: 18, textAlign: 'center', color: T.faint, fontSize: 13, background: T.muted }}>
          Checkout Template — renders as an inert labelled placeholder on the public page.
          Use the Whop Checkout block (or a checkout-type page) for a live checkout.
        </div>
      );
    default:
      return (
        <div style={{ border: `1px dashed ${T.border}`, borderRadius: 10, padding: 18, textAlign: 'center', color: T.faint, fontSize: 13, background: T.muted }}>
          {String(block?.type || 'unknown')} — no preview (renders as-is on the live page)
        </div>
      );
  }
}
