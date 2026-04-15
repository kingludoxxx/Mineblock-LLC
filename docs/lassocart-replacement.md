# LassoCart Replacement — Full Specification Document

**Project:** Custom Checkout / Payment Bridge to replace LassoCart
**Owner:** Mineblock LLC
**Status:** Discovery & Planning
**Created:** 2026-04-13

**Scope:** MVP only — strict minimum to process payments through Whop via Shopify. No analytics dashboard. No extras.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Hosting & Infrastructure](#2-hosting--infrastructure)
3. [Core Architecture](#3-core-architecture)
4. [Shopify Integration](#4-shopify-integration)
5. [Whop Payments Integration](#5-whop-payments-integration)
6. [Checkout System](#6-checkout-system)
7. [One-Click Upsell Engine](#7-one-click-upsell-engine)
8. [Upsell Page Builder (Optimizers)](#8-upsell-page-builder-optimizers)
9. [Flow Builder & Upsell Logic](#9-flow-builder--upsell-logic)
10. [Confirmation / Thank You Page](#10-confirmation--thank-you-page)
11. [Tracking Integrations](#11-tracking-integrations)
12. [Admin Dashboard (MVP)](#12-admin-dashboard-mvp)
13. [Database Schema](#13-database-schema)
14. [Security & Compliance](#14-security--compliance)
15. [Migration Plan](#15-migration-plan)
16. [Page-by-Page Reverse Engineering](#16-page-by-page-reverse-engineering)

---

## 1. Project Overview

### What LassoCart Does
LassoCart is a custom CRM that bridges Shopify and Whop Payments. Whop has no native Shopify integration, so LassoCart handles the entire checkout flow:

- Custom checkout page → charges card via Whop → creates order in Shopify
- Post-purchase one-click upsells (tokenized, no re-entry of card)
- Upsell logic (if customer buys X, show upsell Y)
- Fires tracking pixels to TW, Meta, Klaviyo, Google Ads

### Why Replace It
Goal: eliminate dependency on third-party CRM. Own the checkout infrastructure.

### MVP Success Criteria
- [ ] Checkout page processes payments through Whop
- [ ] Orders created in Shopify after payment
- [ ] Post-purchase upsells work with one-click charge
- [ ] Flow builder logic working (product → upsell mapping)
- [ ] All 4 tracking integrations firing (TW, Meta, Klaviyo, GAds)
- [ ] Confirmation/thank you page with post-purchase pixel
- [ ] Inventory synced from Shopify

---

## 2. Hosting & Infrastructure

> _TODO: Decide after full discovery. Key constraint: checkout page MUST be always-on, zero cold start._

### Infrastructure Components Needed
| Component | Purpose | Notes |
|-----------|---------|-------|
| Checkout Frontend | Customer-facing payment page | Must be FAST, globally accessible |
| API Server | Shopify ↔ Whop bridge, order creation, upsell logic | Always-on |
| Database | Orders, payment tokens, upsell configs, flow rules | Postgres |
| Admin Panel | Configure flows, checkout design, integrations | Can live in Mineblock dashboard |

---

## 3. Core Architecture

### System Flow (from LassoCart reverse engineering)
```
Shopify Store (native cart)
    │
    ▼
Customer clicks checkout → redirected to our Payment Page
    │
    ▼
Payment Page (custom checkout - "Checkout V1")
    │  Fields: email, phone, shipping address, shipping method,
    │  billing address, card (via Whop hosted fields)
    │
    ▼
"Complete Checkout" → Whop Payments API charges card
    │
    ├──► Create order in Shopify via Admin API
    ├──► Fire tracking pixels (Meta, TW, Klaviyo, GAds)
    │
    ▼
Post Purchase Trail (optional upsell funnel)
    │  "Default Funnel" - one-click charge via Whop token
    │  Logic: "Always show" OR conditional per product
    │
    ▼
Confirmation Page ("Thank You Page")
    │  Post-purchase pixel fires here
    │
    ▼
Done
```

### Key Stats from Current LassoCart
- **Total Orders:** 4,107
- **Total Revenue via checkout:** $593,299.70
- **Checkout AOV:** $144.46
- **Post-Purchase Upsell Revenue:** $28,446.26
- **Upsell AOV:** $122.09
- **Total Impressions:** 9,152

---

## 4. Shopify Integration

### How LassoCart Connects
- Uses **native Shopify cart** (not a custom cart replacement)
- Shopify cart redirects to LassoCart's payment page URL
- After payment, LassoCart creates the order in Shopify via API
- Inventory is synced: 30 products currently imported from Shopify

### Inventory Sync (Store > Inventory)
- **Auto-imports products from Shopify store**
- Displays: Name, Price, Variants count, Collection, Orders count, Status (Active/Inactive)
- Generates a **"Buy Now Link"** per product (direct checkout URL)
- Currently 30 products synced, paginated (10/page)
- Products show as "Untitled Product" with $0.00 — likely placeholder data or products without titles

### What We Need to Build
- Shopify Admin API integration (products, orders, customers)
- Product sync job (pull products periodically or via webhook)
- Buy Now link generator (direct-to-checkout URL per product)
- Order creation after successful payment

---

## 5. Whop Payments Integration

### Current Setup in LassoCart
- Simple OAuth/API key connection
- Status display: "Whop Payments Connected!" with green badge
- Once connected, Whop handles all card processing

### What We Need
- [ ] Whop API authentication (OAuth or API key)
- [ ] Charge a card (initial checkout purchase)
- [ ] Tokenize payment method (for one-click upsells)
- [ ] Charge a tokenized card (upsell purchase, no card re-entry)
- [ ] Handle payment callbacks/webhooks (success, failure, refund)
- [ ] Connection status check (connected/disconnected indicator)

### Open Questions
> _TODO: Get Whop Payments API documentation_
> _TODO: Understand tokenization flow — does Whop provide hosted fields / iframe for PCI compliance?_
> _TODO: Token lifecycle — single use? Multi-use? Expiry window?_

---

## 6. Checkout System (Payment Page)

### Overview
The checkout is a **standalone page** hosted by LassoCart (not inside Shopify). Customers are redirected here from the Shopify cart. It has two configuration tabs: **Design** and **Configure**.

---

### 6.1 Design Tab

#### Page Name
- Editable name field (e.g., "Checkout V1")

#### Theme
- **"Use Shopify Theme"** toggle — pulls styling from connected Shopify store

#### Logo
- Upload custom logo (JPG, GIF, or PNG, max 3MB)
- **Logo Size** slider: 20% → 80%, with presets: Tiny, Small, Medium, Large
- Currently set to 42%

#### Color Customization
| Setting | Purpose |
|---------|---------|
| Secondary Text Color | Labels, helper text |
| Background color | Page background |
| Button text color | Text inside buttons |
| Whop Checkout Button Color | The "Complete Checkout" CTA button |
| **Reset** button | Revert colors to default |

#### Live Preview
- Right side shows real-time preview of the checkout page
- Desktop/mobile/tablet viewport toggles (3 icons top-right)

---

### 6.2 Configure Tab

#### Expandable Configuration Sections

**1. Promotions and Incentives** (collapsed)
> _TODO: Need screenshot of expanded state — likely discount codes, coupon support_

**2. Rewards** (collapsed)
> _TODO: Need screenshot of expanded state_

**3. Shipping**
- **Use Shopify Native Shipping Rates** toggle (currently ON)
- **Custom Shipping Methods** — add directly to checkout:
  - Method 1: "Free Tracked Shipping" — 6-10 Business Days — FREE
  - Method 2: "Premium Shipping" — 5-8 business days — $9.97
  - Each method: drag handle (reorder), edit button, delete button
  - **"Add method"** button to create new shipping options
- **Restrict Shipping Countries** toggle (currently OFF)
- **Enable Shipping Protection** toggle (currently OFF)

**4. Trust and Credibility** (collapsed)
> _TODO: Need screenshot — likely trust badges, security seals, guarantee text_

**5. Checkout Fields and Display**
- **Enable State Selection** toggle (ON) — adds state/province dropdown
- **Require Phone Number** toggle (OFF) — makes phone mandatory
- **Hide Mobile Order Summary** toggle (ON) — hides order summary on mobile
- **Continue Shopping Button** toggle (OFF) — shows/hides back-to-store link

**6. Payment Methods Image**
- Displays accepted payment method badges at checkout
- **Size presets:** Small, Medium, Large
- Current image shows: Apple Pay, Google Pay, PayPal, Visa, Mastercard, Amex, Discover
- Upload custom image (JPG/PNG, max 3MB)
- **"Replace Image"** button

---

### 6.3 Checkout Form Fields (from preview)

| Section | Field | Required | Notes |
|---------|-------|----------|-------|
| Contact Information | Email | Yes | |
| Contact Information | Phone | Optional | Configurable via toggle |
| Shipping | Full Name | Yes | Single field, not first/last |
| Shipping | Address | Yes | |
| Shipping | Apt, suite, etc. | No | |
| Shipping | City | Yes | |
| Shipping | Country | Yes | Dropdown |
| Shipping | Postal Code | Yes | |
| Shipping | State | Configurable | Via "Enable State Selection" toggle |
| Shipping Method | Radio selection | Yes | Free Tracked / Premium options |
| Billing Address | Same as shipping | Checkbox | Default checked |
| Card | Card Number | Yes | Via Whop hosted fields |
| Card | Expiry Date | Yes | MM/YY format |
| Card | CVV | Yes | 3 digits |

#### Order Summary Sidebar
- Subtotal
- Total
- (Presumably shows line items when products are in cart)

#### CTA Button
- "✓ Complete Checkout" — blue/customizable color

---

### 6.4 A/B Testing & Order Bumps
From the Flow Builder:
- **A/B Test toggle** on Payment Page — can split test different checkout designs
- **"Split Test"** button to add variant
- **"Add Order Bump"** — pre-purchase upsell shown on checkout page (green bordered button)

---

## 7. One-Click Upsell Engine

### How It Works (from Flow Builder)
- Called **"Post Purchase Trails"** in LassoCart
- Marked as **Optional** in the flow
- Current funnel: **"Default Funnel"** — status: Active, rule: "Always show"
- Stats: $28,446.26 Revenue, $122.09 AOV
- Can add multiple trails (funnels) with **"+ Add new trail"**

### Flow
```
Payment succeeds → Whop returns payment token
    │
    ▼
Check Post Purchase Trail rules
    │
    ├── Rule matches → Show upsell page
    │       │
    │       ├── Customer clicks "Yes" → Whop charges token (one-click)
    │       │       → Update/create Shopify order
    │       │       → Fire upsell tracking pixels
    │       │       → Next upsell OR confirmation page
    │       │
    │       └── Customer clicks "No" → Next upsell OR confirmation page
    │
    └── No rule matches → Go to confirmation page
```

### What We Need to Build
- Payment token storage (encrypted)
- One-click charge endpoint (Whop token charge)
- Upsell accept/decline flow
- Upsell sequencing (chain multiple offers)
- Revenue tracking per funnel

> _TODO: Need screenshots of the upsell page builder (Optimizers) and the funnel configuration UI_

---

## 8. Upsell Page Builder (Optimizers)

> _TODO: Need screenshots of the Optimizer/upsell page builder interface_
> This is where you design the post-purchase upsell offer pages.

### Expected Features (to be confirmed with screenshots)
- Product selection (which product to upsell)
- Price / discount configuration
- Accept / Decline buttons
- Page layout/design options
- Timer/urgency elements (?)
- Mobile responsive preview

---

## 9. Flow Builder & Upsell Logic

### Overview
The Flow Builder is a **visual pipeline** showing the entire checkout flow as connected steps:

```
┌─────────────────────┐
│   Shopify Store      │
│   Cart (Required)    │
│   Native Shopify cart│
└─────────┬───────────┘
          ▼
┌─────────────────────┐
│   Payment Page       │
│   (Required)         │
│   "Checkout V1"      │
│   A/B Test toggle    │
│   Split Test option  │
│   Add Order Bump     │
│   Stats: Revenue,    │
│   Impressions,       │
│   Orders, AOV        │
└─────────┬───────────┘
          ▼
┌─────────────────────┐
│   Post Purchase      │
│   Trails (Optional)  │
│   "Default Funnel"   │
│   Rule: Always show  │
│   + Add new trail    │
└─────────┬───────────┘
          ▼
┌─────────────────────┐
│   Confirmation Page  │
│   (Required)         │
│   "Thank You Page"   │
└─────────────────────┘
```

### Trail/Funnel Rules
- Each trail has a **trigger rule** (e.g., "Always show", or conditional on product purchased)
- Each trail has its own **Revenue** and **AOV** tracking
- Trails can be **Active** or inactive
- Multiple trails can exist (priority/ordering TBD)
- Each trail can be edited or deleted (pencil/trash icons)

### What We Need to Build
- Visual flow builder (or simplified config UI)
- Rule engine: map product purchases → upsell funnels
- Trail management: create, edit, delete, activate/deactivate
- Order bump support on checkout page
- A/B test framework for checkout page variants

---

## 10. Confirmation / Thank You Page

### Current Setup
- Named "Thank You Page" in LassoCart
- Marked as **Required** in the flow
- Has edit/delete options
- **This is where post-purchase tracking pixels fire**

> _TODO: Need screenshot of the thank you page editor — what fields/blocks are configurable?_

### What We Need
- Customizable thank you page
- Order confirmation details display
- Post-purchase pixel placement (Meta, TW, etc.)
- Optional custom messaging/branding

---

## 11. Tracking Integrations

### Required Integrations (MVP)

| Integration | Purpose | Setup |
|-------------|---------|-------|
| **Shopify** | Product sync, order creation | API key / OAuth |
| **Meta Pixel** | Purchase tracking, CAPI | Pixel ID + access token |
| **Klaviyo** | Email/SMS marketing events | API key |
| **Google Ads** | Conversion tracking | Conversion ID + label |

> _TODO: Need screenshots of each integration settings page in LassoCart_
> _TODO: Document exactly what data each integration sends and when_

### Tracking Event Map (Preliminary)
| Event | When | Sent To |
|-------|------|---------|
| InitiateCheckout | Checkout page loads | Meta, TW |
| Purchase | Payment succeeds | Meta, TW, Klaviyo, GAds |
| Upsell Purchase | Upsell accepted | Meta, TW, Klaviyo, GAds |
| Abandoned Checkout | Started but not completed | Klaviyo |

---

## 12. Admin Dashboard (MVP)

### Pages Needed

| # | Page | Purpose | LassoCart Equivalent |
|---|------|---------|---------------------|
| 1 | Orders | View/search all orders with status | Store > Orders |
| 2 | Inventory | View synced Shopify products | Store > Inventory |
| 3 | Payments | Whop connection status | Payments |
| 4 | Flow Builder | Configure checkout → upsell → thank you flow | Flows > Flow Builder |
| 5 | Checkout Designer | Design + configure payment page | Flows > Payment Pages |
| 6 | Upsell Builder | Create post-purchase offer pages | Flows > Optimizers |
| 7 | Thank You Page | Configure confirmation page | Flows > Confirmation Pages |
| 8 | Integrations | Connect Shopify, Meta, Klaviyo, GAds | Integrations |

### Order Management Page
- **Summary cards:** Total Orders, Total Revenue, Total Discounts (with % change indicators)
- **Search** by order number or payment ID
- **Filter** button (filters TBD)
- **Orders table columns:** Order ID, Amount, Date, Status
- **Order ID format:** LSO-YYYYMMDD-XXXX (we'd use our own prefix)
- **Status values:** Paid (others TBD — Refunded? Pending? Failed?)
- **Pagination:** configurable rows per page (10 default), page navigation
- **Row selection:** checkbox selection with count indicator

---

## 13. Database Schema (Preliminary)

```sql
-- Products synced from Shopify
products (
  id, shopify_product_id, name, price, variants_count,
  collection, status, buy_now_url, synced_at
)

-- Orders processed through our checkout
orders (
  id, order_number, shopify_order_id, whop_transaction_id,
  customer_email, customer_phone, amount, discount_amount,
  shipping_method, shipping_cost, status, created_at
)

-- Order line items
order_items (
  id, order_id, product_id, variant_id, quantity, price
)

-- Payment tokens for one-click upsells
payment_tokens (
  id, order_id, customer_email, whop_token (encrypted),
  created_at, expires_at, used
)

-- Checkout page configurations
checkout_configs (
  id, name, logo_url, logo_size, colors (JSON),
  shipping_methods (JSON), field_toggles (JSON),
  payment_methods_image_url, is_active, created_at
)

-- Post-purchase upsell funnels
upsell_funnels (
  id, name, trigger_rule (JSON), is_active,
  total_revenue, total_orders, created_at
)

-- Individual upsell pages within a funnel
upsell_pages (
  id, funnel_id, sort_order, product_id,
  offer_price, design_config (JSON), created_at
)

-- Flow configuration (which checkout → which funnel → which thank you)
flows (
  id, name, checkout_config_id, confirmation_page_id,
  is_active, created_at
)

-- Flow-to-funnel mapping (many-to-many with rules)
flow_funnels (
  id, flow_id, funnel_id, trigger_rule (JSON), sort_order
)

-- Integration credentials
integrations (
  id, type (shopify|meta|klaviyo|google_ads),
  credentials (encrypted JSON), is_connected, connected_at
)

-- Tracking events log
tracking_events (
  id, order_id, event_type, integration, payload (JSON),
  status (sent|failed), sent_at
)

-- Checkout sessions (for abandoned cart tracking)
checkout_sessions (
  id, session_token, cart_data (JSON), customer_email,
  started_at, completed_at, abandoned
)
```

---

## 14. Security & Compliance

### PCI DSS
- Card data NEVER touches our server
- Whop provides hosted fields or tokenization iframe
- We only store Whop payment tokens (encrypted at rest)
- All communication over HTTPS

### Data Protection
- Customer PII encrypted at rest
- Payment tokens encrypted with AES-256
- Integration API keys stored encrypted

---

## 15. Migration Plan

### Phase 1: Build Core
- Whop payment integration
- Checkout page (design + processing)
- Shopify product sync + order creation
- Basic flow configuration

### Phase 2: Upsells
- Post-purchase funnel engine
- One-click token charging
- Upsell page builder

### Phase 3: Integrations & Tracking
- Meta Pixel + CAPI
- Klaviyo events
- Google Ads conversions
- Triple Whale (if needed beyond Shopify sync)

### Phase 4: Cutover
- Switch Shopify cart redirect to new system
- Parallel run for 48 hours
- Verify all tracking fires correctly
- Decommission LassoCart

---

## 16. Page-by-Page Reverse Engineering

### Page 1: Order Management (Store > Orders)
**URL:** `/edit-store/{storeId}` (Store section)
**Features:**
- 3 summary cards: Total Orders (4,107), Total Revenue ($1,702.18), Total Discounts ($1,057.71)
- All cards show +100% change indicator
- Search bar: "Search by order number or payment ID..."
- Blue "Filter" button
- Data table with columns: Order ID, Amount, Date, Status
- Order ID format: `LSO-YYYYMMDD-XXXX` (sequential within day)
- Amounts range: $100–$320 in visible rows
- All statuses: "Paid" (green text)
- Pagination: rows per page selector (10), page navigation (Page 1 of 411)
- Row selection: "0 of 4107 row(s) selected"
**Notes:** Revenue shown ($1,702.18) appears to be for a filtered view, not all-time (total checkout revenue is $593K per Flow Builder stats)

---

### Page 2: Inventory (Store > Inventory)
**URL:** Store > Inventory
**Features:**
- Header: "Inventory" with Shopify icon, "30 total products" badge
- Search: "Search by product name..."
- Table columns: Name, Price, Products (variants), Collection, Orders, Status
- All products show "Untitled Product", $0.00, 0 Variants, no collection, 0 orders
- Status: all "Active" (green badge)
- Each row has green "Buy Now Link" button
- Pagination: 3 pages, 10 per page, 30 total
**Notes:** Products appear to be placeholder/unlinked. In production, these would have real Shopify product names, prices, and variant counts. The "Buy Now Link" generates a direct-to-checkout URL.

---

### Page 3: Whop Payments (Payments section)
**URL:** Payments section
**Features:**
- Title: "Whop Payments Integration"
- Whop logo + "Connected" green badge
- Success message: "Whop Payments Connected! Your payment account is set up and ready to accept payments."
**Notes:** Very simple — just an OAuth connection status. Our version needs: connect/disconnect Whop, show connection status, store API credentials securely.

---

### Page 4: Flow Builder (Flows section)
**URL:** Flows > Flow Builder
**Features:**
- Title: "Flow Builder" — "Create checkout paths to give customers new experiences through the check out process."
- Visual vertical pipeline with 4 connected stages:

**Stage 1 — Cart (Required):**
- "Shopify Cart Active"
- "Your storefront's native Shopify cart is now being used. All traffic will still be directed to your Lasso payment pages."

**Stage 2 — Payment Page (Required):**
- A/B Test toggle
- "Checkout V1" with stats: $593,299.70 Revenue, 9,152 Impressions, 4,107 Orders, $144.46 AOV
- Edit (pencil) and Delete (trash) icons
- "Split Test" button (add checkout variant)
- "Add Order Bump" button (green border)

**Stage 3 — Post Purchase Trails (Optional):**
- "Default Funnel" — Active badge — "Always show"
- Stats: $28,446.26 Revenue, $122.09 AOV
- Edit/Delete icons, drag handle
- "+ Add new trail" button

**Stage 4 — Confirmation Page (Required):**
- "Thank You Page"
- Edit/Delete icons

**Notes:** This is the core orchestration UI. Each stage links to its editor. The flow is linear: Cart → Checkout → Upsell(s) → Thank You.

---

### Page 5: Payment Page Designer — Design Tab
**URL:** Flows > Payment Pages > Edit > Design tab
**Features:**
- Top nav: Back, Design (active), Configure tabs | Cancel, Save & Next buttons
- **Name field:** "Checkout V1"
- **Use Shopify Theme** toggle (currently ON)
- **Logo upload:** MineBlock logo, JPG/GIF/PNG, max 3MB, "Choose Photo"
- **Logo Size:** slider 20%–80%, presets Tiny/Small/Medium/Large, currently 42%
- **Design colors:**
  - Secondary Text Color (blue swatch)
  - Background color (dark swatch)
  - Button text color (dark swatch)
  - Whop Checkout Button Color (blue swatch)
  - Red "Reset" button
- **Live Preview:** real-time checkout preview on right side
- **Viewport toggles:** desktop/tablet/mobile icons (top-right of preview)

---

### Page 6: Payment Page Designer — Configure Tab (Shipping)
**URL:** Same page, Configure tab, Shipping section expanded
**Features:**
- **Promotions and Incentives** (collapsed, expandable)
- **Rewards** (collapsed, expandable)
- **Shipping** (expanded):
  - Use Shopify Native Shipping Rates toggle (ON)
  - Custom Shipping Methods list:
    - "Free Tracked Shipping" — 6-10 Business Days — FREE (drag/edit/delete)
    - "Premium Shipping" — 5-8 business days — $9.97 (drag/edit/delete)
  - "Add method" blue button
  - Restrict Shipping Countries toggle (OFF)
  - Enable Shipping Protection toggle (OFF)
- **Trust and Credibility** (collapsed)
- **Checkout Fields and Display** (collapsed)
- **Payment Methods Image** (collapsed)

---

### Page 7: Payment Page Designer — Configure Tab (Checkout Fields)
**URL:** Same page, Checkout Fields and Display expanded
**Features:**
- **Enable State Selection** toggle — ON (adds state dropdown to form)
- **Require Phone Number** toggle — OFF
- **Hide Mobile Order Summary** toggle — ON
- **Continue Shopping Button** toggle — OFF

---

### Page 8: Payment Page Designer — Configure Tab (Payment Methods Image)
**URL:** Same page, Payment Methods Image expanded
**Features:**
- **Payment Methods Image Size:** Small / Medium / Large presets
- Current image: Apple Pay, Google Pay, PayPal, Visa, Mastercard, Amex, Discover logos
- JPG or PNG, max 3MB
- "Replace Image" button

---

### Pages Still Needed

| # | Page | Status |
|---|------|--------|
| 9 | Post Purchase Trail / Optimizer editor (upsell page builder) | **Need screenshot** |
| 10 | Confirmation Page editor (Thank You page builder) | **Need screenshot** |
| 11 | Integrations > Shopify settings | **Need screenshot** |
| 12 | Integrations > Meta Pixel settings | **Need screenshot** |
| 13 | Integrations > Klaviyo settings | **Need screenshot** |
| 14 | Integrations > Google Ads settings | **Need screenshot** |
| 15 | Promotions and Incentives (expanded) | **Need screenshot** |
| 16 | Trust and Credibility (expanded) | **Need screenshot** |
| 17 | Rewards (expanded) | **Need screenshot** |

---

_This is a living document. Updated as new screenshots are received._
