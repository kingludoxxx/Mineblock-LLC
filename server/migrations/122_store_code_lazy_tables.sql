-- 122_store_code_lazy_tables.sql — Lane C (S1-1). ADDITIVE ONLY (R6).
--
-- The remaining PER-STORE tables of data-map §1b exist only if their owning
-- route/service has been hit at least once (created lazily inside server/src).
-- This sweep adds store_code to each one that IS present and skips, with a
-- NOTICE, each one that is not. A skipped table gets its column when its
-- ensureTable is updated (listed in docs/lanes/lane-c.md) — this file must
-- not fail on an empty database (R6).
DO $$
DECLARE
  sc TEXT := COALESCE(NULLIF(current_setting('app.store_code', true), ''), 'MB');
  t TEXT;
  n_added INT := 0;
  n_skipped INT := 0;
  lazy TEXT[] := ARRAY[
    'crm_order_comments', 'crm_order_events', 'crm_product_images', 'crm_customer_notes',
    'crm_abandoned_checkouts', 'crm_recovery_meta',
    'ad_rejections_notified', 'ad_rejection_history', 'ad_automation_rules', 'ad_automation_log',
    'ads_report_cache', 'creative_meta_insights', 'lb_tracking_custom_code',
    'funnels', 'funnel_pages', 'funnel_redirects',
    'supplier_costs', 'shipping_rates_mr', 'shipping_rates_rig',
    'daily_kpi_snapshots', 'kpi_alerts', 'whop_payment_fees', 'meta_ad_spend_cache',
    'lasso_revenue_shares', 'daily_pnl_reports',
    'co_sessions', 'co_events', 'co_orders', 'co_shopify_refunds', 'co_upsells', 'co_upsell_charges',
    'co_webhook_events', 'co_gateway_configs', 'co_unmatched_payments',
    'co_dunning_queue', 'co_dunning_retry_requests',
    'co_order_edits', 'co_order_edit_pushes', 'co_order_edit_settlements',
    'lb_variant_costs', 'lb_cost_rates', 'lb_cost_items', 'lb_cost_item_members',
    'lb_cost_group_proposals', 'lb_fee_settings', 'lb_ad_spend_daily', 'lb_campaign_map', 'lb_spend_sync_state',
    'lb_health_alerts', 'lb_health_alert_state', 'lb_integrations', 'lb_integration_sends',
    'optin_leads', 'lb_page_versions',
    'lb_split_tests', 'lb_split_arms', 'lb_split_credits', 'lb_split_pending_credits', 'lb_split_views',
    'lb_custom_networks', 'lb_inbound_endpoints', 'lb_inbound_events',
    'lb_touches', 'lb_clicks', 'lb_visitor_firstseen', 'lb_tracking_sent', 'lb_tracking_events',
    'lb_postback_queue', 'lb_postback_breakers', 'lb_pixels', 'lb_consent'
  ];
BEGIN
  IF sc !~ '^[A-Z0-9]{1,8}$' THEN
    RAISE EXCEPTION '122: app.store_code % is not a valid store_code (expected ^[A-Z0-9]{1,8}$)', quote_literal(sc);
  END IF;
  FOREACH t IN ARRAY lazy LOOP
    IF to_regclass(t) IS NULL THEN
      n_skipped := n_skipped + 1;
      RAISE NOTICE '[122] % not present (lazily created) - skipped; its ensureTable must add store_code', t;
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS store_code TEXT NOT NULL DEFAULT %L', t, sc);
    n_added := n_added + 1;
  END LOOP;
  RAISE NOTICE '[122] store_code=% tagged % present table(s), skipped % absent', sc, n_added, n_skipped;
END $$;
