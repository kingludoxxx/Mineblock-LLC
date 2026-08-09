// seed — hand-built payloads in Lane 1 / Lane 2's documented shapes
// (NEW FILE, LANE 3, verification only — never imported by the app).
//
// TWO PAYLOADS, and the second one is the point:
//
//   SEED_DASHBOARD    a busy, realistic window that DELIBERATELY carries
//                     withheld cells — two unmeasured days in the series, a
//                     funnel with no visitor spine, a funnel with zero cost
//                     coverage, a funnel with no bound spend, a campaign
//                     bucket with no campaign on the click. Every one of those
//                     must render as an em dash or an honest label, never as a
//                     zero, and the screenshot is inspected for exactly that.
//
//   WITHHELD_DASHBOARD  every measurable quantity null. The whole page must
//                     render with NO fabricated number anywhere — the harness
//                     asserts that no "$0.00" / "0.00%" / "0.00x" appears.
//
// Numbers are internally consistent (gross = net + refunds; gp = net − cogs −
// fees; net_profit = gp − spend; roas = gross ÷ spend) so a wrong formatter
// shows up as a wrong number rather than as plausible noise.

const day = (n) => {
  const d = new Date(Date.UTC(2026, 6, 11 + n)); // 2026-07-11 + n
  return d.toISOString().slice(0, 10);
};

/** 30 daily buckets. Days 9 and 10 are NEVER MEASURED — holes, not zeros. */
const mkSeries = (scale) => Array.from({ length: 30 }).map((_, i) => {
  const unmeasured = i === 9 || i === 10;
  const wave = 1 + 0.45 * Math.sin(i / 2.6) + (i % 7 === 6 ? 0.5 : 0);
  const gross = Math.round(scale * 1000 * wave * 100) / 100;
  const orders = Math.round(scale * 9 * wave);
  const sessions = unmeasured ? null : Math.round(scale * 420 * wave);
  return {
    day: day(i),
    gross_sales: gross,
    net_sales: Math.round(gross * 0.94 * 100) / 100,
    orders,
    // The visitor spine is gone for those two days, so sessions AND every rate
    // over them are withheld — not zeroed.
    sessions,
    conv_pct: sessions ? Math.round((orders / sessions) * 10000) / 100 : null,
    spend: Math.round(scale * 300 * wave * 100) / 100,
    net_profit: Math.round(scale * 240 * wave * 100) / 100,
  };
});

const SERIES = mkSeries(1);
// The compare twin is the equal-length PRECEDING window, so its buckets carry
// their OWN calendar days — the two series are overlaid by INDEX, and the
// dashed line's real dates only exist in the tooltip.
const PREV_SERIES = mkSeries(0.82).map((p, i) => ({ ...p, day: day(i - 30) }));

export const SEED_DASHBOARD = {
  band: {
    live: 23,
    unique_today: 1841,
    today: { orders: 61, revenue: 8214.4, spend: 2410.18, net: 1902.6 },
    yesterday: { orders: 54, revenue: 7106.2, spend: 2288.4, net: 1610.9 },
  },
  kpis: {
    gross_sales: 312_480.55,
    net_sales: 293_731.72,
    refunds: 18_748.83,
    orders: 2_184,
    sessions: 128_940,
    conv_pct: 1.69,
    aov: 134.49,
    aov_pre_upsell: 111.02,
    upsell_revenue: 51_268.4,
    upsell_take_pct: 31.4,
    rev_per_session: 2.28,
    new_customers: 1_612,
    returning_customers: 572,
    abandoned: 391,
    abandoned_rate: 15.2,
    items_sold: 3_042,
    cogs: 96_930.6,
    ship_cost: 14_112.0,
    fees: 10_780.4,
    net_after_cogs: 171_908.72,
    margin_pct: 58.5,
    cost_coverage_pct: 92,
    missing_legs: 148,
    spend: 84_306.19,
    spend_known: true,
    roas: 3.71,
    cpa: 38.6,
    net_profit: 87_602.53,
    previous: {
      gross_sales: 268_112.9,
      net_sales: 252_004.1,
      orders: 1_902,
      sessions: 121_400,
      conv_pct: 1.57,
      aov: 132.5,
      spend: 79_884.0,
      roas: 3.36,
      net_profit: 71_004.2,
      net_after_cogs: 150_888.2,
      new_customers: 1_480,
      returning_customers: 422,
    },
    upsell_lines: {
      aov_post: 134.49,
      aov_pre: 111.02,
      upsell_revenue: 51_268.4,
      take_rate: 31.4,
      upsell_refunds: 2_914.6,
    },
  },
  series: SERIES,
  prev_series: PREV_SERIES,
  breakdown_summary: {
    funnels: {
      basis: 'gross',
      basis_label: 'Gross sales — upsell and rebill legs included',
      total: 312_480.55,
      rows_total: 7,
      rows: [
        {
          id: 'f_lift', name: 'Breast Lift · PDP1',
          sessions: 71_204, orders: 1_284, conv_pct: 1.8,
          gross_sales: 184_902.1, net_sales: 174_118.4, aov: 135.6, rev_per_session: 2.44,
          refunds: 10_783.7, cogs: 57_442.0, fees: 6_402.1,
          gp: 96_162.3, gp_pct: 55.2, cost_coverage_pct: 100, missing_legs: 0,
          spend: 48_112.4, spend_known: true, net_profit: 48_049.9, roas: 3.84, cpa: 37.47,
        },
        {
          id: 'f_oil', name: 'Activator Oil · Ladder',
          sessions: 41_880, orders: 702, conv_pct: 1.68,
          gross_sales: 92_140.0, net_sales: 86_402.2, aov: 123.08, rev_per_session: 2.06,
          refunds: 5_737.8, cogs: 31_204.6, fees: 3_180.4,
          gp: 44_305.2, gp_pct: 51.3, cost_coverage_pct: 88, missing_legs: 84,
          spend: 30_881.3, spend_known: true, net_profit: 13_423.9, roas: 2.98, cpa: 43.99,
        },
        {
          // NO VISITOR SPINE. Sessions, Conv and $/session must be dashes —
          // and Orders, Gross and Net must still print. This row is verbatim
          // the "Sessions 0 · Orders 412 · Conv 0.00%" failure case.
          id: 'f_legacy', name: 'Legacy advertorial (pre-TTL)',
          sessions: null, orders: 141, conv_pct: null,
          gross_sales: 21_448.2, net_sales: 20_112.9, aov: 142.64, rev_per_session: null,
          refunds: 1_335.3, cogs: 6_902.0, fees: 742.1,
          gp: 12_468.8, gp_pct: 62.0, cost_coverage_pct: 96, missing_legs: 12,
          spend: 4_112.0, spend_known: true, net_profit: 8_356.8, roas: 5.22, cpa: 29.16,
        },
        {
          // ZERO COST COVERAGE → GP, GP%, Net profit WITHHELD. A gp equal to
          // net sales here would be the 100%-margin lie.
          id: 'f_bundle', name: 'Winter bundle (uncosted)',
          sessions: 9_204, orders: 41, conv_pct: 0.45,
          gross_sales: 8_240.0, net_sales: 8_240.0, aov: 200.98, rev_per_session: 0.9,
          refunds: 0, cogs: null, fees: 291.4,
          gp: null, gp_pct: null, cost_coverage_pct: 0, missing_legs: 41,
          spend: 1_200.49, spend_known: true, net_profit: null, roas: 6.86, cpa: 29.28,
        },
        {
          // NO BOUND SPEND → Spend, Net profit, ROAS, CPA WITHHELD. A ROAS
          // against a spend nobody recorded is a ratio over nothing.
          id: 'f_organic', name: 'Organic / email only',
          sessions: 5_652, orders: 16, conv_pct: 0.28,
          gross_sales: 5_750.25, net_sales: 4_858.22, aov: 303.64, rev_per_session: 0.86,
          refunds: 892.03, cogs: 1_882.0, fees: 164.4,
          gp: 2_811.82, gp_pct: 57.9, cost_coverage_pct: 100, missing_legs: 0,
          spend: null, spend_known: false, net_profit: null, roas: null, cpa: null,
        },
      ],
    },
    sources: {
      basis: 'captured_base',
      basis_label: 'Captured base only — upsell money carries no UTM',
      total: 261_212.15,
      rows_total: 11,
      rows: [
        { key: 'facebook', label: 'facebook', sales: 148_204.1, orders: 1_042 },
        { key: 'tiktok', label: 'tiktok', sales: 62_118.4, orders: 498 },
        { key: 'google', label: 'google', sales: 31_402.9, orders: 264 },
        { key: 'klaviyo', label: 'klaviyo', sales: 12_884.0, orders: 118 },
        // NO SOURCE ON THE CLICK — a real bucket, labelled honestly.
        { key: '', label: '', sales: 6_602.75, orders: 62 },
      ],
    },
    countries: {
      basis: 'order_shipping_country',
      basis_label: 'Shipping country on the order — not a geolocated visit',
      total: 312_480.55,
      rows_total: 18,
      rows: [
        { country: 'US', sales: 201_884.2 },
        { country: 'GB', sales: 41_022.6 },
        { country: 'DE', sales: 28_114.0 },
        { country: 'ES', sales: 19_882.4 },
        { country: 'FR', sales: 12_408.1 },
        { country: 'IT', sales: 5_112.9 },
        { country: 'NL', sales: 4_056.35 },
      ],
    },
    products: { basis: 'line_items', basis_label: 'Line items', rows: [], rows_total: 0, total: 0 },
    campaigns: { basis: 'captured_base', basis_label: 'Captured base only', rows: [], rows_total: 0, total: 0 },
  },
  waterfall: { steps: [] },
  movers: [],
  window: {
    start: day(0), end: day(29), prev_start: day(-30), prev_end: day(-1),
    timezone: 'Europe/Madrid',
  },
  meta: {
    computed_ms: 418,
    rows_scanned: 184_902,
    basis: 'gross',
    basis_label: 'Gross sales',
    warnings: [
      'Sessions are withheld for 2 days of this window — those days reach past the 90-day touch retention.',
    ],
    sessions_unknown: false,
  },
};

export const SEED_MARKETING = {
  basis: 'captured_base',
  basis_label: 'Captured base only — upsell money has no UTM',
  totals: { orders: 1_984, sales: 261_212.15, rows_total: 34 },
  rows: [
    { key: 'c_lift_uk', label: 'LIFT · UK · BROAD', orders: 412, sales: 61_204.2, bar_pct: 100 },
    { key: 'c_lift_us', label: 'LIFT · US · ADV+', orders: 388, sales: 54_118.9, bar_pct: 88 },
    { key: 'c_oil_us', label: 'OIL · US · RETARGET', orders: 291, sales: 38_402.1, bar_pct: 63 },
    { key: 'c_oil_de', label: 'OIL · DE · LOOKALIKE', orders: 204, sales: 27_884.4, bar_pct: 46 },
    { key: 'c_lift_es', label: 'LIFT · ES · COLD', orders: 168, sales: 21_112.0, bar_pct: 34 },
    { key: 'c_bundle', label: 'BUNDLE · WINTER', orders: 96, sales: 14_208.6, bar_pct: 23 },
    // NO CAMPAIGN ON THE CLICK — kept, labelled, and inside the footer total.
    { key: '', label: '', orders: 141, sales: 18_402.55, bar_pct: 30 },
  ],
};

/** Everything measurable withheld. NOT ONE NUMBER may render. */
export const WITHHELD_DASHBOARD = {
  band: {
    live: null,
    unique_today: null,
    today: { orders: null, revenue: null, spend: null, net: null },
  },
  kpis: {
    gross_sales: null, net_sales: null, refunds: null, orders: null, sessions: null,
    conv_pct: null, aov: null, aov_pre_upsell: null, upsell_revenue: null,
    rev_per_session: null, new_customers: null, returning_customers: null,
    abandoned: null, abandoned_rate: null, items_sold: null,
    cogs: null, fees: null, net_after_cogs: null, margin_pct: null,
    cost_coverage_pct: null, spend: null, spend_known: false, roas: null,
    cpa: null, net_profit: null,
    previous: null,
    upsell_lines: {
      aov_post: null, aov_pre: null, upsell_revenue: null, take_rate: null, upsell_refunds: null,
    },
  },
  series: Array.from({ length: 8 }).map((_, i) => ({
    day: day(i), gross_sales: null, net_sales: null, orders: null, sessions: null, conv_pct: null,
  })),
  prev_series: [],
  breakdown_summary: {
    funnels: {
      basis: 'gross',
      basis_label: 'Gross sales — upsell and rebill legs included',
      total: null,
      rows_total: 1,
      rows: [{
        id: 'f_dark', name: 'Everything withheld',
        sessions: null, orders: null, conv_pct: null, gross_sales: null, net_sales: null,
        aov: null, rev_per_session: null, refunds: null, cogs: null, fees: null,
        gp: null, gp_pct: null, cost_coverage_pct: null, missing_legs: null,
        spend: null, spend_known: false, net_profit: null, roas: null, cpa: null,
      }],
    },
  },
  window: {
    start: day(0), end: day(7), prev_start: day(-8), prev_end: day(-1),
    timezone: 'Europe/Madrid',
  },
  meta: {
    computed_ms: 96,
    warnings: ['Sessions withheld: this window crosses the 90-day touch retention.'],
    sessions_unknown: true,
  },
};
