import express from 'express';
import fetch from 'node-fetch';

const router = express.Router();

const WHOP_TOKEN = process.env.WHOP_API_TOKEN;
const CUSTOM_PLAN_PRODUCT = 'prod_f39F0e4fpb26N'; // Mineblock product — works for custom orders

const PRODUCTS = [
  {
    id: 'prod_PEQEWF93E38iO',
    name: 'Miner Forge PRO 2.0',
    plans: [
      { id: 'plan_8Nuoz5KJ9mmLr', label: '1 Miner',     price: 69.99  },
      { id: 'plan_4YaO9KeLLOWO6', label: '2 Miners',    price: 109.99 },
      { id: 'plan_c1JOLdl3APQA3', label: '3 + 1 Free',  price: 179.99 },
      { id: 'plan_pXIUCpd26vl2f', label: '6 + 2 Free',  price: 319.99 },
      { id: 'plan_qY3WNqSzo2GSm', label: '12 + 4 Free', price: 559.99 },
      { id: 'plan_NGJ7BnMF3RAFT', label: '18 + 6 Free', price: 799.00 },
    ],
  },
  {
    id: 'prod_lzSlOXUcBsUjj',
    name: 'Bitaxe Gamma Miner',
    plans: [
      { id: 'plan_NO03QiBGb8noE', label: 'Buy 1',            price: 299.99 },
      { id: 'plan_Ktsu2p5ekJL9Y', label: 'Buy 2',            price: 599.98 },
      { id: 'plan_Ji7C07hLyBQkU', label: 'Buy 3 Get 1 Free', price: 899.97 },
    ],
  },
  {
    id: 'prod_dNMmFjAVffY9c',
    name: 'Titan Max',
    plans: [
      { id: 'plan_qgx3deqX9hycA', label: 'Buy 1',            price: 997.00  },
      { id: 'plan_KoQvhTTdxJveS', label: 'Buy 2',            price: 1597.00 },
      { id: 'plan_rmBK03tCiM5pZ', label: 'Buy 3 Get 1 Free', price: 2392.00 },
    ],
  },
  {
    id: 'prod_QKKKaqCysD46y',
    name: 'PhantomAxe Ultra',
    plans: [
      { id: 'plan_LYgmEY4hyauGG', label: 'Buy 1',            price: 2999.00 },
      { id: 'plan_6fyMedZK7QMum', label: 'Buy 2',            price: 5998.00 },
      { id: 'plan_yWTgC5FNMv6mn', label: 'Buy 3 Get 1 Free', price: 8997.00 },
    ],
  },
  {
    id: 'prod_dX3zZC8eBhvzl',
    name: 'Mining Rig',
    plans: [
      { id: 'plan_cP2G9UkzngeY6', label: '1 Slot',  price: 14.99 },
      { id: 'plan_31mqIFNKffd2a', label: '2 Slots', price: 19.99 },
      { id: 'plan_VHph7nPkrXO9h', label: '4 Slots', price: 24.99 },
    ],
  },
  {
    id: 'prod_h9teNi3KKKG5w',
    name: 'VIP Miner Verification',
    plans: [
      { id: 'plan_Nyf5YF7EOIINy', label: 'VIP Verification', price: 249.93 },
    ],
  },
];

// Serve the tool page
router.get('/sales/payment-links', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(buildPage());
});

// Expose product catalog to the frontend
router.get('/api/sales/products', (req, res) => {
  res.json(PRODUCTS);
});

// Generate a Whop checkout link
router.post('/api/sales/generate-link', async (req, res) => {
  try {
    const { items, discount_pct } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'No items selected' });
    }

    const discount = parseFloat(discount_pct) || 0;
    const isSingle = items.length === 1 && discount === 0;

    // Single item, no discount — return existing plan link directly
    if (isSingle) {
      return res.json({ link: `https://whop.com/checkout/${items[0].plan_id}` });
    }

    // Calculate total
    const subtotal = items.reduce((sum, i) => sum + parseFloat(i.price), 0);
    const total = discount > 0 ? subtotal * (1 - discount / 100) : subtotal;
    const finalPrice = Math.round(total * 100) / 100;

    if (finalPrice < 1) {
      return res.status(400).json({ error: 'Final price must be at least $1.00' });
    }

    // Build description
    const description = items
      .map(i => `${i.product_name}: ${i.variant_label} ($${parseFloat(i.price).toFixed(2)})`)
      .join(' + ');
    const fullDesc = discount > 0
      ? `${description} | ${discount}% discount applied`
      : description;

    // Create custom Whop plan
    const payload = {
      access_pass_id: CUSTOM_PLAN_PRODUCT,
      plan_type: 'one_time',
      release_method: 'buy_now',
      initial_price: finalPrice,
      renewal_price: 0,
      unlimited_stock: true,
      visibility: 'hidden',
      title: 'Custom Order',
      description: fullDesc.slice(0, 1000),
      internal_notes: fullDesc.slice(0, 500),
    };

    const whopRes = await fetch('https://api.whop.com/api/v2/plans', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WHOP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!whopRes.ok) {
      const err = await whopRes.text();
      console.error('[sales-tools] Whop plan creation failed:', err);
      return res.status(502).json({ error: 'Failed to create payment link', detail: err });
    }

    const plan = await whopRes.json();
    return res.json({ link: plan.direct_link });
  } catch (err) {
    console.error('[sales-tools] generate-link error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

function buildPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Mineblock — Payment Link Generator</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background: #0a0a0a;
    color: #f0f0f0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    min-height: 100vh;
    padding: 24px 16px 80px;
  }

  .header {
    text-align: center;
    margin-bottom: 32px;
  }
  .header h1 {
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.3px;
  }
  .header p { color: #888; font-size: 13px; margin-top: 6px; }

  .layout {
    max-width: 960px;
    margin: 0 auto;
    display: grid;
    grid-template-columns: 1fr 320px;
    gap: 20px;
    align-items: start;
  }
  @media (max-width: 700px) {
    .layout { grid-template-columns: 1fr; }
  }

  /* Search */
  .search-wrap { margin-bottom: 16px; }
  .search-wrap input {
    width: 100%;
    background: #1a1a1a;
    border: 1px solid #2a2a2a;
    border-radius: 10px;
    padding: 11px 16px;
    color: #f0f0f0;
    font-size: 14px;
    outline: none;
    transition: border-color 0.15s;
  }
  .search-wrap input:focus { border-color: #3b82f6; }
  .search-wrap input::placeholder { color: #555; }

  /* Product cards */
  .products { display: flex; flex-direction: column; gap: 12px; }

  .product-card {
    background: #141414;
    border: 1px solid #222;
    border-radius: 12px;
    padding: 16px;
    transition: border-color 0.15s;
  }
  .product-card.has-selection { border-color: #3b82f6; }
  .product-card.hidden { display: none; }

  .product-name {
    font-size: 13px;
    font-weight: 600;
    color: #ccc;
    margin-bottom: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .variants { display: flex; flex-wrap: wrap; gap: 8px; }

  .variant-btn {
    background: #1e1e1e;
    border: 1px solid #2e2e2e;
    border-radius: 8px;
    padding: 8px 14px;
    cursor: pointer;
    transition: all 0.15s;
    text-align: left;
    color: #f0f0f0;
  }
  .variant-btn:hover { border-color: #555; background: #242424; }
  .variant-btn.selected {
    background: #1d3461;
    border-color: #3b82f6;
    color: #fff;
  }
  .variant-label { font-size: 13px; font-weight: 500; display: block; }
  .variant-price { font-size: 12px; color: #888; display: block; margin-top: 2px; }
  .variant-btn.selected .variant-price { color: #93c5fd; }

  /* Cart */
  .cart {
    background: #141414;
    border: 1px solid #222;
    border-radius: 12px;
    padding: 20px;
    position: sticky;
    top: 24px;
  }
  .cart-title {
    font-size: 13px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #888;
    margin-bottom: 16px;
  }

  .cart-empty { color: #444; font-size: 13px; text-align: center; padding: 20px 0; }

  .cart-items { display: flex; flex-direction: column; gap: 10px; margin-bottom: 16px; }

  .cart-item {
    background: #1a1a1a;
    border-radius: 8px;
    padding: 10px 12px;
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 8px;
  }
  .cart-item-info { flex: 1; min-width: 0; }
  .cart-item-name { font-size: 12px; font-weight: 600; color: #ddd; }
  .cart-item-variant { font-size: 11px; color: #666; margin-top: 2px; }
  .cart-item-price { font-size: 13px; font-weight: 600; color: #fff; white-space: nowrap; }
  .cart-item-remove {
    background: none; border: none; color: #444;
    cursor: pointer; font-size: 16px; line-height: 1;
    padding: 0 0 0 4px; flex-shrink: 0;
    transition: color 0.15s;
  }
  .cart-item-remove:hover { color: #ef4444; }

  .divider { height: 1px; background: #222; margin: 12px 0; }

  /* Discount */
  .discount-row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 12px;
  }
  .discount-row label { font-size: 12px; color: #888; flex-shrink: 0; }
  .discount-input {
    width: 70px;
    background: #1e1e1e;
    border: 1px solid #2e2e2e;
    border-radius: 8px;
    padding: 7px 10px;
    color: #f0f0f0;
    font-size: 13px;
    outline: none;
    text-align: center;
  }
  .discount-input:focus { border-color: #3b82f6; }
  .discount-badge {
    font-size: 11px;
    color: #4ade80;
    background: #052e16;
    padding: 3px 8px;
    border-radius: 20px;
    display: none;
  }
  .discount-badge.visible { display: inline-block; }

  /* Totals */
  .totals { margin-bottom: 16px; }
  .total-row {
    display: flex;
    justify-content: space-between;
    font-size: 13px;
    color: #888;
    margin-bottom: 6px;
  }
  .total-row.final {
    font-size: 16px;
    font-weight: 700;
    color: #fff;
    margin-top: 8px;
  }
  .total-row .strike { text-decoration: line-through; color: #555; }

  /* Generate button */
  .btn-generate {
    width: 100%;
    background: #3b82f6;
    border: none;
    border-radius: 10px;
    padding: 13px;
    color: #fff;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s, opacity 0.15s;
    margin-bottom: 10px;
  }
  .btn-generate:hover { background: #2563eb; }
  .btn-generate:disabled { opacity: 0.4; cursor: not-allowed; }

  .btn-reset {
    width: 100%;
    background: none;
    border: 1px solid #2a2a2a;
    border-radius: 10px;
    padding: 10px;
    color: #666;
    font-size: 13px;
    cursor: pointer;
    transition: all 0.15s;
  }
  .btn-reset:hover { border-color: #444; color: #aaa; }

  /* Result */
  .result {
    margin-top: 14px;
    display: none;
  }
  .result.visible { display: block; }
  .result-link {
    background: #0d2137;
    border: 1px solid #1e4e8c;
    border-radius: 8px;
    padding: 10px 12px;
    font-size: 12px;
    color: #93c5fd;
    word-break: break-all;
    margin-bottom: 8px;
    cursor: pointer;
    transition: background 0.15s;
  }
  .result-link:hover { background: #102843; }
  .copy-btn {
    width: 100%;
    background: #052e16;
    border: 1px solid #14532d;
    border-radius: 8px;
    padding: 9px;
    color: #4ade80;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s;
  }
  .copy-btn:hover { background: #0a3d1f; }
  .copy-btn.copied { background: #14532d; }

  .error-msg {
    background: #2d0a0a;
    border: 1px solid #7f1d1d;
    border-radius: 8px;
    padding: 10px 12px;
    color: #fca5a5;
    font-size: 12px;
    margin-top: 10px;
    display: none;
  }
  .error-msg.visible { display: block; }

  .spinner {
    display: inline-block;
    width: 14px; height: 14px;
    border: 2px solid rgba(255,255,255,0.3);
    border-top-color: #fff;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
    vertical-align: middle;
    margin-right: 6px;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>

<div class="header">
  <h1>Mineblock — Payment Link Generator</h1>
  <p>Select products, apply a discount, and generate a Whop checkout link for your customer.</p>
</div>

<div class="layout">
  <!-- Left: Product selection -->
  <div>
    <div class="search-wrap">
      <input type="text" id="search" placeholder="Search products..." oninput="filterProducts(this.value)">
    </div>
    <div class="products" id="products"></div>
  </div>

  <!-- Right: Cart -->
  <div class="cart">
    <div class="cart-title">Order Summary</div>

    <div id="cart-empty" class="cart-empty">No products selected</div>
    <div class="cart-items" id="cart-items"></div>

    <div id="cart-controls" style="display:none">
      <div class="divider"></div>

      <div class="discount-row">
        <label>Discount</label>
        <input type="number" id="discount" class="discount-input" min="0" max="99" placeholder="0" oninput="updateTotals()">
        <span class="discount-badge" id="discount-badge">% off</span>
      </div>

      <div class="totals" id="totals"></div>

      <button class="btn-generate" id="btn-generate" onclick="generateLink()">
        Generate Payment Link
      </button>
      <button class="btn-reset" onclick="resetAll()">Clear</button>

      <div class="result" id="result">
        <div class="result-link" id="result-link" onclick="copyLink()"></div>
        <button class="copy-btn" id="copy-btn" onclick="copyLink()">Copy Link</button>
      </div>
      <div class="error-msg" id="error-msg"></div>
    </div>
  </div>
</div>

<script>
const PRODUCTS = ${JSON.stringify(PRODUCTS)};

// State
let cart = {}; // { plan_id: { product_name, variant_label, price, plan_id } }

// Render product cards
function renderProducts(list) {
  const container = document.getElementById('products');
  container.innerHTML = '';
  list.forEach(prod => {
    const card = document.createElement('div');
    card.className = 'product-card';
    card.id = 'card-' + prod.id;
    card.innerHTML = \`
      <div class="product-name">\${prod.name}</div>
      <div class="variants">
        \${prod.plans.map(plan => \`
          <button
            class="variant-btn \${cart[plan.id] ? 'selected' : ''}"
            id="btn-\${plan.id}"
            onclick="toggleVariant('\${prod.id}', '\${prod.name}', '\${plan.id}', '\${plan.label}', \${plan.price})"
          >
            <span class="variant-label">\${plan.label}</span>
            <span class="variant-price">$\${plan.price.toFixed(2)}</span>
          </button>
        \`).join('')}
      </div>
    \`;
    // Mark card selected if any variant in cart
    const hasSelection = prod.plans.some(p => cart[p.id]);
    if (hasSelection) card.classList.add('has-selection');
    container.appendChild(card);
  });
}

function filterProducts(query) {
  const q = query.toLowerCase();
  PRODUCTS.forEach(prod => {
    const card = document.getElementById('card-' + prod.id);
    if (card) {
      card.classList.toggle('hidden', q && !prod.name.toLowerCase().includes(q));
    }
  });
}

function toggleVariant(prodId, prodName, planId, label, price) {
  if (cart[planId]) {
    delete cart[planId];
  } else {
    const prod = PRODUCTS.find(p => p.id === prodId);
    prod.plans.forEach(p => { delete cart[p.id]; });
    cart[planId] = { product_name: prodName, variant_label: label, price, plan_id: planId };
  }
  renderProducts(PRODUCTS);
  const q = document.getElementById('search').value.toLowerCase();
  if (q) filterProducts(q);
  updateCart();
}

function updateCart() {
  const items = Object.values(cart);
  const empty = document.getElementById('cart-empty');
  const controls = document.getElementById('cart-controls');
  const itemsEl = document.getElementById('cart-items');

  if (items.length === 0) {
    empty.style.display = 'block';
    controls.style.display = 'none';
    itemsEl.innerHTML = '';
    hideResult();
    return;
  }

  empty.style.display = 'none';
  controls.style.display = 'block';
  itemsEl.innerHTML = items.map(item => \`
    <div class="cart-item">
      <div class="cart-item-info">
        <div class="cart-item-name">\${item.product_name}</div>
        <div class="cart-item-variant">\${item.variant_label}</div>
      </div>
      <div style="display:flex;align-items:center;gap:4px">
        <div class="cart-item-price">$\${item.price.toFixed(2)}</div>
        <button class="cart-item-remove" onclick="removeItem('\${item.plan_id}')" title="Remove">×</button>
      </div>
    </div>
  \`).join('');

  updateTotals();
  hideResult();
}

function removeItem(planId) {
  delete cart[planId];
  renderProducts(PRODUCTS);
  const q = document.getElementById('search').value.toLowerCase();
  if (q) filterProducts(q);
  updateCart();
}

function updateTotals() {
  const items = Object.values(cart);
  if (items.length === 0) return;

  const raw = parseFloat(document.getElementById('discount').value) || 0;
  const discount = Math.max(0, Math.min(99, raw));
  const subtotal = items.reduce((s, i) => s + i.price, 0);
  const total = discount > 0 ? subtotal * (1 - discount / 100) : subtotal;

  const badge = document.getElementById('discount-badge');
  badge.textContent = discount + '% off';
  badge.classList.toggle('visible', discount > 0);

  const totalsEl = document.getElementById('totals');
  if (discount > 0) {
    totalsEl.innerHTML = \`
      <div class="total-row"><span>Subtotal</span><span class="strike">$\${subtotal.toFixed(2)}</span></div>
      <div class="total-row"><span>Discount (\${discount}%)</span><span style="color:#4ade80">-$\${(subtotal - total).toFixed(2)}</span></div>
      <div class="total-row final"><span>Total</span><span>$\${total.toFixed(2)}</span></div>
    \`;
  } else {
    totalsEl.innerHTML = \`
      <div class="total-row final"><span>Total</span><span>$\${total.toFixed(2)}</span></div>
    \`;
  }

  hideResult();
}

async function generateLink() {
  const items = Object.values(cart);
  if (items.length === 0) return;

  const btn = document.getElementById('btn-generate');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Generating...';
  hideResult();

  try {
    const raw = parseFloat(document.getElementById('discount').value) || 0;
    const discount_pct = Math.max(0, Math.min(99, raw));
    const res = await fetch('/api/sales/generate-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, discount_pct }),
    });
    const data = await res.json();

    if (!res.ok || data.error) {
      showError(data.error || 'Failed to generate link');
      return;
    }

    if (!data.link) {
      showError('No link returned — please try again');
      return;
    }
    showResult(data.link);
  } catch (err) {
    showError('Network error — please try again');
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'Generate Payment Link';
  }
}

function showResult(link) {
  const result = document.getElementById('result');
  const linkEl = document.getElementById('result-link');
  const copyBtn = document.getElementById('copy-btn');
  linkEl.textContent = link;
  linkEl.dataset.link = link;
  copyBtn.textContent = 'Copy Link';
  copyBtn.classList.remove('copied');
  result.classList.add('visible');
  document.getElementById('error-msg').classList.remove('visible');
}

function copyLink() {
  const link = document.getElementById('result-link').dataset.link;
  if (!link) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(link).then(() => {
      const btn = document.getElementById('copy-btn');
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = 'Copy Link'; btn.classList.remove('copied'); }, 2000);
    }).catch(() => fallbackCopy(link));
  } else {
    fallbackCopy(link);
  }
}

function fallbackCopy(link) {
  const ta = document.createElement('textarea');
  ta.value = link;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    const btn = document.getElementById('copy-btn');
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = 'Copy Link'; btn.classList.remove('copied'); }, 2000);
  } catch (e) {
    const btn = document.getElementById('copy-btn');
    btn.textContent = 'Select link above';
  }
  document.body.removeChild(ta);
}

function showError(msg) {
  const el = document.getElementById('error-msg');
  el.textContent = msg;
  el.classList.add('visible');
}

function hideResult() {
  document.getElementById('result').classList.remove('visible');
  document.getElementById('error-msg').classList.remove('visible');
}

function resetAll() {
  cart = {};
  document.getElementById('discount').value = '';
  renderProducts(PRODUCTS);
  updateCart();
  document.getElementById('search').value = '';
}

// Initial render
renderProducts(PRODUCTS);
</script>
</body>
</html>`;
}

export default router;
