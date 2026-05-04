import express from 'express';
import fetch from 'node-fetch';

const router = express.Router();

const WHOP_TOKEN = process.env.WHOP_API_TOKEN;
const CUSTOM_PLAN_PRODUCT = 'prod_f39F0e4fpb26N'; // Mineblock product — works for custom orders

// Agent discount codes — add/edit here to manage agent discounts
// Format: 'CODE': { name: 'Display Name', pct: discount_percentage }
const DISCOUNT_CODES = {
  // Example entries — replace with real agent codes:
  // 'SARAH15': { name: 'Sarah', pct: 15 },
  // 'JOHN10': { name: 'John', pct: 10 },
  // 'VIP20':  { name: 'VIP',   pct: 20 },
};

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
    const { items, discount_pct, agent_code } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'No items selected' });
    }

    const discount = Math.max(0, Math.min(99, parseFloat(discount_pct) || 0));
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
    const discountNote = discount > 0
      ? `${discount}% discount${agent_code ? ` (${agent_code})` : ''}`
      : null;
    const fullDesc = discountNote ? `${description} | ${discountNote}` : description;

    // Build a readable title from the first item (truncated to 60 chars)
    const firstItem = items[0];
    const titleBase = items.length === 1
      ? `${firstItem.product_name} — ${firstItem.variant_label}`
      : `${firstItem.product_name} + ${items.length - 1} more`;
    const title = (discount > 0 ? `${titleBase} (${discount}% off)` : titleBase).slice(0, 60);

    // Create custom Whop plan — stock:1 + unlimited_stock:false = single-use link
    const payload = {
      access_pass_id: CUSTOM_PLAN_PRODUCT,
      plan_type: 'one_time',
      release_method: 'buy_now',
      initial_price: finalPrice,
      renewal_price: 0,
      stock: 1,
      unlimited_stock: false,
      visibility: 'hidden',
      description: fullDesc.slice(0, 1000),
      internal_notes: title.slice(0, 500),
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

  /* Discount / Agent Code */
  .discount-section { margin-bottom: 14px; }
  .discount-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #666;
    margin-bottom: 6px;
  }
  .discount-field { position: relative; }
  .discount-input {
    width: 100%;
    background: #1a1a1a;
    border: 2px solid #2a2a2a;
    border-radius: 10px;
    padding: 11px 14px;
    color: #f0f0f0;
    font-size: 14px;
    font-weight: 500;
    outline: none;
    transition: border-color 0.15s, background 0.15s;
    text-transform: uppercase;
    letter-spacing: 1px;
  }
  .discount-input::placeholder { color: #444; font-weight: 400; font-size: 13px; text-transform: none; letter-spacing: 0; }
  .discount-input:focus { border-color: #3b82f6; background: #111827; }
  .discount-input.valid { border-color: #22c55e; background: #052e16; }
  .discount-input.invalid { border-color: #ef4444; }
  .discount-status {
    margin-top: 6px;
    font-size: 12px;
    min-height: 18px;
  }
  .discount-status.ok { color: #4ade80; }
  .discount-status.err { color: #f87171; }
  .discount-badge {
    display: none;
    font-size: 11px;
    color: #4ade80;
    background: #052e16;
    padding: 3px 8px;
    border-radius: 20px;
    margin-top: 6px;
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
    display: block;
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
    text-decoration: none;
  }
  .result-link:hover { background: #102843; color: #bfdbfe; }
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
  <svg width="160" height="21" viewBox="0 0 521 66" fill="none" xmlns="http://www.w3.org/2000/svg" style="margin-bottom:14px">
    <g clip-path="url(#clip0_78_13663)">
    <mask id="mask0_78_13663" style="mask-type:luminance" maskUnits="userSpaceOnUse" x="0" y="0" width="521" height="66"><path d="M521 0H0V66H521V0Z" fill="white"/></mask>
    <g mask="url(#mask0_78_13663)">
    <path d="M149.199 64.9537V0H160.428L184.528 33.0436H179.173L202.755 0H213.984V64.9537H202.149V13.5138L206.728 14.6473L182.283 47.5165H180.9L157.06 14.6473L160.947 13.5138V64.9537H149.199Z" fill="white"/>
    <path d="M221.031 64.9537V17.5245H232.346V64.9537H221.031ZM221.031 12.2061V0H232.346V12.2061H221.031Z" fill="white"/>
    <path d="M238.475 64.9537V17.5245H249.1V26.8534L248.236 25.1968C249.33 22.3487 251.115 20.1981 253.591 18.745C256.125 17.2338 259.062 16.4782 262.402 16.4782C265.858 16.4782 268.909 17.2338 271.559 18.745C274.264 20.2563 276.367 22.3779 277.864 25.1096C279.361 27.7834 280.11 30.893 280.11 34.4386V64.9537H268.795V37.1413C268.795 35.0489 268.39 33.2471 267.585 31.7358C266.779 30.2245 265.656 29.062 264.216 28.2484C262.834 27.3764 261.192 26.9406 259.292 26.9406C257.449 26.9406 255.808 27.3764 254.368 28.2484C252.928 29.062 251.805 30.2245 251 31.7358C250.194 33.2471 249.79 35.0489 249.79 37.1413V64.9537H238.475Z" fill="white"/>
    <path d="M307.646 66C302.808 66 298.575 64.8957 294.948 62.6869C291.319 60.4782 288.498 57.4848 286.483 53.7067C284.467 49.9286 283.458 45.7437 283.458 41.1519C283.458 36.3857 284.467 32.1718 286.483 28.5099C288.555 24.79 291.348 21.8547 294.861 19.7041C298.432 17.5535 302.405 16.4782 306.782 16.4782C310.467 16.4782 313.691 17.0885 316.456 18.3091C319.278 19.5298 321.668 21.2153 323.625 23.3659C325.584 25.5165 327.081 27.9867 328.118 30.7768C329.154 33.5086 329.672 36.473 329.672 39.6697C329.672 40.4835 329.615 41.3263 329.499 42.1982C329.442 43.07 329.298 43.8256 329.068 44.4649H292.788V35.7464H322.675L317.32 39.8441C317.838 37.1705 317.694 34.7874 316.888 32.6949C316.14 30.6023 314.873 28.9459 313.087 27.7252C311.36 26.5046 309.257 25.8943 306.782 25.8943C304.42 25.8943 302.319 26.5046 300.476 27.7252C298.633 28.8877 297.222 30.6315 296.244 32.9564C295.322 35.2232 294.976 37.9841 295.206 41.239C294.976 44.1453 295.351 46.7319 296.329 48.9987C297.366 51.2074 298.863 52.922 300.822 54.1427C302.837 55.3633 305.14 55.9736 307.732 55.9736C310.323 55.9736 312.511 55.4214 314.297 54.317C316.14 53.2127 317.578 51.7306 318.615 49.8706L327.772 54.4042C326.851 56.6711 325.411 58.6764 323.452 60.4201C321.495 62.1638 319.163 63.5297 316.456 64.5179C313.807 65.506 310.87 66 307.646 66Z" fill="white"/>
    <path d="M335.831 64.9537V0H362.868C366.727 0 370.038 0.697492 372.802 2.09247C375.624 3.48745 377.783 5.46368 379.28 8.02114C380.836 10.5205 381.613 13.5139 381.613 17.0014C381.613 20.1981 380.778 23.1044 379.108 25.72C377.495 28.2774 375.105 30.2827 371.938 31.7358L371.852 28.5099C374.616 29.5562 376.891 30.9511 378.676 32.6949C380.519 34.3804 381.9 36.3567 382.822 38.6236C383.743 40.8322 384.204 43.1863 384.204 45.6856C384.204 51.6724 382.304 56.3804 378.503 59.8098C374.702 63.2391 369.519 64.9537 362.955 64.9537H335.831ZM344.296 57.1071H363.3C367.044 57.1071 370.038 56.0898 372.284 54.0555C374.529 52.0211 375.652 49.2603 375.652 45.7727C375.652 42.2853 374.529 39.5244 372.284 37.4901C370.038 35.3977 367.044 34.3514 363.3 34.3514H344.296V57.1071ZM344.296 26.6789H362.695C365.805 26.6789 368.311 25.7781 370.211 23.9762C372.111 22.1162 373.061 19.7623 373.061 16.9142C373.061 13.9498 372.111 11.683 370.211 10.1136C368.311 8.54426 365.805 7.75958 362.695 7.75958H344.296V26.6789Z" fill="white"/>
    <path d="M389.437 64.9537V8.85376H396.265V64.9537H389.437Z" fill="white"/>
    <path d="M421.339 65.8431C417.52 65.8431 414.069 64.9537 410.986 63.1752C407.902 61.3471 405.455 58.8522 403.643 55.6902C401.833 52.5283 400.926 48.9464 400.926 44.9445C400.926 40.9427 401.808 37.3855 403.57 34.2729C405.382 31.1604 407.829 28.6901 410.912 26.8621C413.996 25.0341 417.471 24.1201 421.339 24.1201C425.156 24.1201 428.606 25.0341 431.691 26.8621C434.775 28.6407 437.197 31.0863 438.959 34.1988C440.771 37.3114 441.676 40.8932 441.676 44.9445C441.676 48.9958 440.746 52.6024 438.886 55.7643C437.026 58.8769 434.554 61.3471 431.47 63.1752C428.436 64.9537 425.059 65.8431 421.339 65.8431ZM421.339 59.1734C423.786 59.1734 425.988 58.5557 427.946 57.3206C429.953 56.0854 431.52 54.381 432.645 52.2071C433.82 50.0332 434.407 47.6124 434.407 44.9445C434.407 42.2272 433.82 39.831 432.645 37.756C431.52 35.6315 429.953 33.9518 427.946 32.7167C425.988 31.4321 423.786 30.7899 421.339 30.7899C418.842 30.7899 416.59 31.4321 414.583 32.7167C412.626 33.9518 411.059 35.6315 409.884 37.756C408.709 39.831 408.122 42.2272 408.122 44.9445C408.122 47.6124 408.709 50.0332 409.884 52.2071C411.059 54.381 412.626 56.0854 414.583 57.3206C416.59 58.5557 418.842 59.1734 421.339 59.1734Z" fill="white"/>
    <path d="M464.619 65.8431C460.752 65.8431 457.301 64.9291 454.266 63.1011C451.28 61.273 448.93 58.7781 447.218 55.6161C445.505 52.4542 444.648 48.8969 444.648 44.9445C444.648 40.9427 445.505 37.3855 447.218 34.2729C448.93 31.1604 451.28 28.6901 454.266 26.8621C457.301 25.0341 460.752 24.1201 464.619 24.1201C467.213 24.1201 469.636 24.5895 471.888 25.5282C474.14 26.4669 476.122 27.7267 477.835 29.3076C479.549 30.8886 480.796 32.7414 481.579 34.8658L475.485 37.8301C474.555 35.7551 473.136 34.0753 471.226 32.7908C469.318 31.4569 467.116 30.7899 464.619 30.7899C462.22 30.7899 460.042 31.4074 458.085 32.6425C456.176 33.8777 454.658 35.5575 453.532 37.6819C452.406 39.8064 451.844 42.252 451.844 45.0186C451.844 47.6865 452.406 50.1075 453.532 52.2812C454.658 54.4057 456.176 56.0854 458.085 57.3206C460.042 58.5557 462.22 59.1734 464.619 59.1734C467.116 59.1734 469.318 58.5311 471.226 57.2465C473.136 55.9126 474.555 54.1586 475.485 51.9848L481.579 55.0973C480.796 57.1725 479.549 59.0251 477.835 60.6555C476.122 62.2365 474.14 63.4964 471.888 64.4351C469.636 65.3738 467.213 65.8431 464.619 65.8431Z" fill="white"/>
    <path d="M486.184 64.9537V8.85376H493.013V47.316L490.222 46.649L511.221 25.0094H519.959L504.761 41.0908L520.986 64.9537H512.91L498.078 43.3142L502.337 43.0918L490.809 55.2456L493.013 50.2062V64.9537H486.184Z" fill="white"/>
    <path d="M119.356 64.7549L99.4614 44.8303L119.356 24.9057L139.251 44.8302L119.356 64.7549Z" fill="white"/>
    <path d="M49.7241 44.8303L69.6191 64.7548L114.383 19.9245L94.4879 0L49.7241 44.8303Z" fill="white"/>
    <path d="M44.7501 0L64.6451 19.9245L19.8813 64.7548L-0.0136719 44.8303L44.7501 0Z" fill="white"/>
    </g></g>
    <defs><clipPath id="clip0_78_13663"><rect width="521" height="66" fill="white"/></clipPath></defs>
  </svg>
  <h1>Payment Link Generator</h1>
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

      <div class="discount-section">
        <div class="discount-label">Agent Discount Code</div>
        <div class="discount-field">
          <input type="text" id="discount-code" class="discount-input" placeholder="Enter your code..." oninput="applyDiscountCode(this.value)">
        </div>
        <div class="discount-status" id="discount-status"></div>
        <span class="discount-badge" id="discount-badge"></span>
      </div>

      <div class="totals" id="totals"></div>

      <button class="btn-generate" id="btn-generate" onclick="generateLink()">
        Generate Payment Link
      </button>
      <button class="btn-reset" onclick="resetAll()">Clear</button>

      <div class="result" id="result">
        <a class="result-link" id="result-link" href="#" target="_blank" rel="noopener"></a>
        <button class="copy-btn" id="copy-btn" onclick="copyLink()">Copy Link</button>
      </div>
      <div class="error-msg" id="error-msg"></div>
    </div>
  </div>
</div>

<script>
const PRODUCTS = ${JSON.stringify(PRODUCTS)};
const DISCOUNT_CODES = ${JSON.stringify(DISCOUNT_CODES)};

// State
let cart = {};
let activeDiscount = 0;
let activeAgent = null;

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

function applyDiscountCode(val) {
  const code = val.trim().toUpperCase();
  const inputEl = document.getElementById('discount-code');
  const statusEl = document.getElementById('discount-status');
  const badge = document.getElementById('discount-badge');

  if (!code) {
    activeDiscount = 0;
    activeAgent = null;
    inputEl.className = 'discount-input';
    statusEl.textContent = '';
    statusEl.className = 'discount-status';
    badge.className = 'discount-badge';
    badge.textContent = '';
    updateTotals();
    return;
  }

  const entry = DISCOUNT_CODES[code];
  if (entry) {
    activeDiscount = entry.pct;
    activeAgent = { code, name: entry.name, pct: entry.pct };
    inputEl.className = 'discount-input valid';
    statusEl.textContent = \`✓ \${entry.name} — \${entry.pct}% discount applied\`;
    statusEl.className = 'discount-status ok';
    badge.textContent = entry.pct + '% off';
    badge.className = 'discount-badge visible';
  } else {
    activeDiscount = 0;
    activeAgent = null;
    inputEl.className = 'discount-input invalid';
    statusEl.textContent = 'Invalid code';
    statusEl.className = 'discount-status err';
    badge.className = 'discount-badge';
    badge.textContent = '';
  }
  updateTotals();
  hideResult();
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

  const discount = activeDiscount;
  const subtotal = items.reduce((s, i) => s + i.price, 0);
  const total = discount > 0 ? subtotal * (1 - discount / 100) : subtotal;

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
    const discount_pct = activeDiscount;
    const agent_code = activeAgent ? activeAgent.code : null;
    const res = await fetch('/api/sales/generate-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, discount_pct, agent_code }),
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
  linkEl.href = link;
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
  activeDiscount = 0;
  activeAgent = null;
  const codeInput = document.getElementById('discount-code');
  if (codeInput) { codeInput.value = ''; codeInput.className = 'discount-input'; }
  const statusEl = document.getElementById('discount-status');
  if (statusEl) { statusEl.textContent = ''; statusEl.className = 'discount-status'; }
  const badge = document.getElementById('discount-badge');
  if (badge) { badge.textContent = ''; badge.className = 'discount-badge'; }
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
