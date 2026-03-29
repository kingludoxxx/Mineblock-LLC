import { useState, useEffect, useRef } from 'react';
import { Package, ChevronDown, Check, ExternalLink, X, Loader2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import api from '../services/api';

export default function ProductSelector({ selectedId, onSelect, className = '' }) {
  const [products, setProducts] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const ref = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    api.get('/product-profiles')
      .then((r) => {
        setProducts(r.data.data || []);
        setLoading(false);
      })
      .catch((err) => {
        console.error('Failed to load products:', err.message);
        setLoading(false);
      });
  }, []);

  // Close on outside click or escape — only listen when open
  useEffect(() => {
    if (!open) return;
    const handleClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const handleKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  const selected = products.find((p) => p.id === selectedId);

  const handleSelect = (product) => {
    onSelect(product);
    setOpen(false);
  };

  const handleClear = (e) => {
    e.stopPropagation();
    onSelect(null);
    setOpen(false);
  };

  return (
    <div ref={ref} className={`relative ${className}`}>
      {/* Trigger */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center justify-between w-full gap-2 bg-[#0a0a0a] border border-white/[0.06] rounded-lg px-2.5 py-2 text-[13px] text-white/90 hover:border-white/[0.12] transition-colors"
      >
        <div className="flex items-center gap-2.5 min-w-0">
          {selected ? (
            <>
              {selected.product_images?.[0] ? (
                <img src={selected.product_images[0]} alt="" className="w-6 h-6 rounded object-cover shrink-0" />
              ) : (
                <Package className="w-4 h-4 shrink-0 text-white/40" />
              )}
              <span className="truncate">{selected.name}</span>
            </>
          ) : (
            <>
              <Package className="w-4 h-4 shrink-0 text-white/40" />
              <span className="text-white/40">Select Product</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {selected && (
            <span
              role="button"
              tabIndex={0}
              onClick={handleClear}
              onKeyDown={(e) => e.key === 'Enter' && handleClear(e)}
              className="p-0.5 rounded hover:bg-white/[0.08] text-white/30 hover:text-white/60 transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </span>
          )}
          <ChevronDown className={`w-4 h-4 text-white/30 transition-transform ${open ? 'rotate-180' : ''}`} />
        </div>
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute z-50 mt-1.5 w-full min-w-[220px] bg-[#0a0a0a] border border-white/[0.1] rounded-xl shadow-2xl overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="w-5 h-5 text-violet-400 animate-spin" />
            </div>
          ) : products.length === 0 ? (
            <div className="px-3 py-4 text-center">
              <p className="text-sm text-white/40 mb-2">No products yet</p>
              <button
                type="button"
                onClick={() => { setOpen(false); navigate('/app/assets'); }}
                className="text-sm text-violet-400 hover:text-violet-300 font-medium transition-colors"
              >
                Create one &rarr;
              </button>
            </div>
          ) : (
            <>
              <div className="max-h-[240px] overflow-y-auto py-1">
                {products.map((product) => {
                  const isSelected = product.id === selectedId;
                  return (
                    <button
                      key={product.id}
                      type="button"
                      onClick={() => handleSelect(product)}
                      className={`flex items-center justify-between w-full px-3 py-2 text-left text-sm transition-colors ${
                        isSelected ? 'bg-white/[0.06]' : 'hover:bg-white/[0.04]'
                      }`}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        {product.product_images?.[0] ? (
                          <img src={product.product_images[0]} alt="" className="w-6 h-6 rounded object-cover shrink-0" />
                        ) : (
                          <Package className="w-4 h-4 shrink-0 text-white/20" />
                        )}
                        <span className="text-white/90 truncate">{product.name}</span>
                      </div>
                      {isSelected && (
                        <Check className="w-4 h-4 shrink-0 text-emerald-400" />
                      )}
                    </button>
                  );
                })}
              </div>
              <div className="border-t border-white/[0.06] px-3 py-2">
                <button
                  type="button"
                  onClick={() => { setOpen(false); navigate('/app/assets'); }}
                  className="flex items-center gap-1.5 text-sm text-violet-400 hover:text-violet-300 font-medium transition-colors"
                >
                  Manage Products
                  <ExternalLink className="w-3.5 h-3.5" />
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
