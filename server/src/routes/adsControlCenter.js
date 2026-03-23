import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { pgQuery } from '../db/pg.js';

const router = Router();

// ── Config ──────────────────────────────────────────────────────────────
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || '';
const META_AD_ACCOUNT_IDS = (process.env.META_AD_ACCOUNT_IDS || '').split(',').filter(Boolean);
const META_GRAPH_URL = 'https://graph.facebook.com/v21.0';
const TW_API_KEY = process.env.TRIPLEWHALE_API_KEY || '';
const TW_SHOP_ID = process.env.TRIPLEWHALE_SHOP_ID || '17cca0-2.myshopify.com';
const TW_SQL_URL = 'https://api.triplewhale.com/api/v2/orcabase/api/sql';
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || '';
const SLACK_PNL_CHANNEL = 'C0AF724MJPR';

const ACCOUNT_NAMES = {
  'act_938489175321542': 'Mineblock X8',
  'act_1972517213693373': 'Mineblock CC 4',
  'act_1238893338181787': 'Mineblock CC 5',
  'act_25781501541499027': 'Mineblock X6',
  'act_1363888491879561': 'Luvora CC',
  'act_1417689703203647': 'Luvora CC 2',
  'act_642819725560039': 'Luvora CC 3',
};

// ── Helpers ─────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function formatDate(d) {
  // Use Berlin timezone to match store/TW data
  return d.toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' }); // YYYY-MM-DD
}

function getDateRange(timeWindow) {
  const now = new Date();
  const today = formatDate(now);
  switch (timeWindow) {
    case 'yesterday': {
      const y = new Date(now); y.setDate(y.getDate() - 1);
      return { start: formatDate(y), end: formatDate(y) };
    }
    case 'last_3_days': {
      const d = new Date(now); d.setDate(d.getDate() - 2);
      return { start: formatDate(d), end: today };
    }
    case 'last_7_days': {
      const d = new Date(now); d.setDate(d.getDate() - 6);
      return { start: formatDate(d), end: today };
    }
    case 'last_14_days': {
      const d = new Date(now); d.setDate(d.getDate() - 13);
      return { start: formatDate(d), end: today };
    }
    case 'last_30_days': {
      const d = new Date(now); d.setDate(d.getDate() - 29);
      return { start: formatDate(d), end: today };
    }
    case 'today':
    default:
      return { start: today, end: today };
  }
}

// ── Database Tables ─────────────────────────────────────────────────────
let tablesReady = false;

async function ensureTables() {
  if (tablesReady) return;

  await pgQuery(`
    CREATE TABLE IF NOT EXISTS ad_automation_rules (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      rule_type TEXT NOT NULL DEFAULT 'kill',
      entity_level TEXT NOT NULL DEFAULT 'ad',
      conditions JSONB NOT NULL DEFAULT '[]',
      logic_operator TEXT NOT NULL DEFAULT 'AND',
      time_window TEXT NOT NULL DEFAULT 'today',
      action TEXT NOT NULL DEFAULT 'pause_ad',
      action_value NUMERIC(10,2) DEFAULT 0,
      min_spend NUMERIC(10,2) DEFAULT 0,
      cooldown_minutes INTEGER DEFAULT 60,
      max_executions_per_day INTEGER DEFAULT 50,
      dry_run BOOLEAN DEFAULT false,
      enabled BOOLEAN DEFAULT true,
      priority INTEGER DEFAULT 0,
      scope_type TEXT DEFAULT 'all',
      scope_ids TEXT[] DEFAULT '{}',
      times_triggered INTEGER DEFAULT 0,
      last_triggered_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pgQuery(`
    CREATE TABLE IF NOT EXISTS ad_automation_log (
      id SERIAL PRIMARY KEY,
      rule_id INTEGER,
      rule_name TEXT,
      ad_id TEXT,
      ad_name TEXT,
      adset_name TEXT,
      campaign_name TEXT,
      entity_level TEXT DEFAULT 'ad',
      account_id TEXT,
      account_name TEXT,
      action TEXT NOT NULL,
      reason TEXT,
      metrics_snapshot JSONB DEFAULT '{}',
      old_value TEXT,
      new_value TEXT,
      execution_status TEXT DEFAULT 'success',
      execution_error TEXT,
      meta_response TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  tablesReady = true;
  console.log('[Ads Control] Tables ensured');
}

// ── Triple Whale Data Fetcher ───────────────────────────────────────────
async function fetchTWAdPerformance(startDate, endDate) {
  if (!TW_API_KEY) {
    console.error('[Ads Control] TRIPLEWHALE_API_KEY not set');
    return [];
  }

  const revenueColumns = ['order_revenue', 'pixel_revenue', 'revenue'];
  const purchaseColumns = [
    'website_purchases', 'orders_quantity', 'pixel purchases', 'pixel_purchases',
    'purchases', 'pixel_capi_purchases', 'total_purchases', 'conversions',
  ];

  async function twQuery(sql) {
    const res = await fetch(TW_SQL_URL, {
      method: 'POST',
      headers: {
        'x-api-key': TW_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        shopId: TW_SHOP_ID,
        query: sql.trim(),
        period: { startDate, endDate },
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (res.status === 401 || res.status === 403) {
      const text = await res.text();
      console.error(`[Ads Control] TW auth error ${res.status}: ${text.slice(0, 200)}`);
      return { ok: false, fatal: true };
    }
    if (res.status >= 500) {
      const text = await res.text();
      console.error(`[Ads Control] TW server error ${res.status}: ${text.slice(0, 200)}`);
      return { ok: false, fatal: true };
    }
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, fatal: false, errorText: text.slice(0, 100) };
    }
    const data = await res.json();
    const rows = Array.isArray(data) ? data : (data?.data || data?.rows || []);
    return { ok: true, rows };
  }

  // Step 1: Find the working revenue column
  let workingRevenueCol = null;
  for (const revenueCol of revenueColumns) {
    const revRef = revenueCol.includes(' ') ? `\`${revenueCol}\`` : revenueCol;
    const sql = `
      SELECT ad_name, SUM(spend) as total_spend, SUM(${revRef}) as total_revenue,
             SUM(impressions) as total_impressions, SUM(clicks) as total_clicks
      FROM pixel_joined_tvf
      WHERE event_date BETWEEN @startDate AND @endDate
      GROUP BY ad_name
      HAVING SUM(spend) > 0.01
      ORDER BY SUM(spend) DESC
      LIMIT 2000
    `;
    const result = await twQuery(sql);
    if (result.fatal) return [];
    if (result.ok) {
      workingRevenueCol = revenueCol;
      console.log(`[Ads Control] TW revenue column found: "${revenueCol}"`);

      // Step 2: Try adding purchase columns to the working query
      for (const purchaseCol of purchaseColumns) {
        const colRef = purchaseCol.includes(' ') ? `\`${purchaseCol}\`` : purchaseCol;
        const sqlWithPurchases = `
          SELECT ad_name, SUM(spend) as total_spend, SUM(${revRef}) as total_revenue,
                 SUM(${colRef}) as total_purchases,
                 SUM(impressions) as total_impressions, SUM(clicks) as total_clicks
          FROM pixel_joined_tvf
          WHERE event_date BETWEEN @startDate AND @endDate
          GROUP BY ad_name
          HAVING SUM(spend) > 0.01
          ORDER BY SUM(spend) DESC
          LIMIT 2000
        `;
        const purchaseResult = await twQuery(sqlWithPurchases);
        if (purchaseResult.ok) {
          console.log(`[Ads Control] TW purchase column found: "${purchaseCol}"`);
          return purchaseResult.rows.map((r) => {
            const spend = Number(r.total_spend) || 0;
            const revenue = Number(r.total_revenue) || 0;
            const purchases = Number(r.total_purchases) || 0;
            const impressions = Number(r.total_impressions) || 0;
            const clicks = Number(r.total_clicks) || 0;
            return {
              ad_name: r.ad_name,
              total_spend: spend,
              total_revenue: revenue,
              total_purchases: purchases,
              total_impressions: impressions,
              total_clicks: clicks,
              roas: spend > 0 ? revenue / spend : 0,
              cpa: purchases > 0 ? spend / purchases : 0,
              ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
              cpc: clicks > 0 ? spend / clicks : 0,
            };
          });
        }
      }

      // Fallback: revenue-only (no purchase column worked)
      console.warn('[Ads Control] No purchase column found, returning without purchases');
      return result.rows.map((r) => {
        const spend = Number(r.total_spend) || 0;
        const revenue = Number(r.total_revenue) || 0;
        const impressions = Number(r.total_impressions) || 0;
        const clicks = Number(r.total_clicks) || 0;
        return {
          ad_name: r.ad_name,
          total_spend: spend,
          total_revenue: revenue,
          total_purchases: 0,
          total_impressions: impressions,
          total_clicks: clicks,
          roas: spend > 0 ? revenue / spend : 0,
          cpa: 0,
          ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
          cpc: clicks > 0 ? spend / clicks : 0,
        };
      });
    }
  }

  console.error('[Ads Control] No working TW revenue column found');
  return [];
}

// ── Meta API Functions ──────────────────────────────────────────────────
async function findAdByName(adName) {
  if (!META_ACCESS_TOKEN || META_AD_ACCOUNT_IDS.length === 0) return null;

  for (const accountId of META_AD_ACCOUNT_IDS) {
    try {
      const filtering = JSON.stringify([{ field: 'name', operator: 'CONTAIN', value: adName }]);
      const params = new URLSearchParams({
        fields: 'id,name,effective_status,configured_status,adset_id,adset{daily_budget,name},campaign{name}',
        filtering,
        limit: '5',
        access_token: META_ACCESS_TOKEN,
      });
      const url = `${META_GRAPH_URL}/${accountId}/ads?${params}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        // Detect rate limiting (Meta error codes 32, 17, or HTTP 429)
        if (res.status === 429 || errBody.includes('"code":32') || errBody.includes('"code":17')) {
          console.warn(`[Ads Control] Meta rate limited on ${accountId}, backing off`);
          await sleep(5000);
          continue;
        }
        console.warn(`[Ads Control] Meta search failed for ${accountId}: ${res.status}`);
        await sleep(300);
        continue;
      }
      const data = await res.json();
      const ads = data?.data || [];
      if (ads.length > 0) {
        // Prefer exact name match over partial CONTAIN match
        const ad = ads.find(a => a.name === adName) || ads[0];
        return {
          adId: ad.id,
          adName: ad.name,
          effectiveStatus: ad.effective_status,
          configuredStatus: ad.configured_status,
          adsetId: ad.adset_id,
          adsetName: ad.adset?.name || null,
          adsetBudget: ad.adset?.daily_budget ? Number(ad.adset.daily_budget) : null,
          campaignName: ad.campaign?.name || null,
          accountId,
          accountName: ACCOUNT_NAMES[accountId] || accountId,
        };
      }
    } catch (err) {
      console.error(`[Ads Control] Meta search error for ${accountId}:`, err.message);
    }
    await sleep(300);
  }

  return null;
}

async function pauseAd(adId) {
  const res = await fetch(`${META_GRAPH_URL}/${adId}?status=PAUSED&access_token=${META_ACCESS_TOKEN}`, {
    method: 'POST', signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Failed to pause ad ${adId}`);
  return data;
}

async function resumeAd(adId) {
  const res = await fetch(`${META_GRAPH_URL}/${adId}?status=ACTIVE&access_token=${META_ACCESS_TOKEN}`, {
    method: 'POST', signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Failed to resume ad ${adId}`);
  return data;
}

async function updateAdsetBudget(adsetId, newBudgetCents) {
  const res = await fetch(`${META_GRAPH_URL}/${adsetId}?daily_budget=${Math.round(newBudgetCents)}&access_token=${META_ACCESS_TOKEN}`, {
    method: 'POST', signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Failed to update adset budget ${adsetId}`);
  return data;
}

// ── Slack Alert ─────────────────────────────────────────────────────────
async function sendSlackAlert(logEntry) {
  if (!SLACK_BOT_TOKEN) return;
  const actionEmoji = logEntry.action === 'pause_ad' ? ':octagonal_sign:' : logEntry.action === 'resume_ad' ? ':arrow_forward:' : logEntry.action.includes('budget') ? ':chart_with_upwards_trend:' : ':bell:';
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `${actionEmoji} Ad Automation Action`, emoji: true } },
    { type: 'section', fields: [
      { type: 'mrkdwn', text: `*Ad:*\n${logEntry.ad_name || 'N/A'}` },
      { type: 'mrkdwn', text: `*Action:*\n${logEntry.action}` },
    ]},
    { type: 'section', fields: [
      { type: 'mrkdwn', text: `*Rule:*\n${logEntry.rule_name || 'N/A'}` },
      { type: 'mrkdwn', text: `*Account:*\n${logEntry.account_name || 'N/A'}` },
    ]},
    { type: 'section', text: { type: 'mrkdwn', text: `*Reason:*\n${logEntry.reason || 'N/A'}` } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `Status: ${logEntry.execution_status} | ${new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' })}` }] },
  ];
  await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: SLACK_PNL_CHANNEL, text: `Ad Automation: ${logEntry.action} - ${logEntry.ad_name}`, blocks, username: 'Mineblock Bot', icon_url: 'https://mineblock-dashboard.onrender.com/logo-white.png' }),
  }).catch(err => console.error('[Ads Control] Slack error:', err.message));
}

// ── Rule Condition Evaluator ────────────────────────────────────────────
function evaluateCondition(condition, ad) {
  const { metric, operator, value } = condition;
  const adValue = ad[metric];
  if (adValue === undefined || adValue === null) return false;

  const numValue = Number(value);
  const numAdValue = Number(adValue);

  switch (operator) {
    case '>':  return numAdValue > numValue;
    case '>=': return numAdValue >= numValue;
    case '<':  return numAdValue < numValue;
    case '<=': return numAdValue <= numValue;
    case '=': case '==': return numAdValue === numValue;
    case '!=': return numAdValue !== numValue;
    default:   return false;
  }
}

function buildConditionReason(conditions, ad) {
  return conditions.map((c) => {
    const adVal = ad[c.metric] !== undefined ? Number(ad[c.metric]).toFixed(2) : 'N/A';
    return `${c.metric} ${c.operator} ${c.value} (actual: ${adVal})`;
  }).join(', ');
}

// ── Rule Evaluation Engine ──────────────────────────────────────────────
async function evaluateRules() {
  await ensureTables();

  const rules = await pgQuery(
    'SELECT * FROM ad_automation_rules WHERE enabled = true ORDER BY priority DESC'
  );
  if (rules.length === 0) return { rulesEvaluated: 0, adsChecked: 0, actionsTaken: 0, errors: 0 };

  // Group rules by time_window
  const rulesByWindow = {};
  for (const rule of rules) {
    const tw = rule.time_window || 'today';
    if (!rulesByWindow[tw]) rulesByWindow[tw] = [];
    rulesByWindow[tw].push(rule);
  }

  // Fetch TW data per time_window (cache to avoid duplicate calls)
  const twDataCache = {};
  for (const tw of Object.keys(rulesByWindow)) {
    const { start, end } = getDateRange(tw);
    try {
      twDataCache[tw] = await fetchTWAdPerformance(start, end);
    } catch (err) {
      console.error(`[Ads Control] Failed to fetch TW data for ${tw}:`, err.message);
      twDataCache[tw] = [];
    }
  }

  let actionsTaken = 0;
  let errorsCount = 0;
  let totalAdsChecked = 0;

  // Cross-rule dedup: track which ads have been acted on this cycle
  const actedAdsThisCycle = new Set();

  for (const rule of rules) {
    const tw = rule.time_window || 'today';
    const ads = twDataCache[tw] || [];
    totalAdsChecked += ads.length;

    // Check max executions per day for this rule
    const todayStr = formatDate(new Date());
    const todayExecRows = await pgQuery(
      `SELECT COUNT(*) as cnt FROM ad_automation_log
       WHERE rule_id = $1 AND DATE(created_at AT TIME ZONE 'Europe/Berlin') = $2
       AND execution_status != 'dry_run'`,
      [rule.id, todayStr]
    );
    const todayExecCount = parseInt(todayExecRows[0]?.cnt || 0, 10);
    if (todayExecCount >= (rule.max_executions_per_day || 50)) {
      console.log(`[Ads Control] Rule "${rule.name}" hit daily max (${todayExecCount}/${rule.max_executions_per_day})`);
      continue;
    }

    for (const ad of ads) {
      // Cross-rule dedup: skip ads already acted on this cycle (except alerts)
      if (actedAdsThisCycle.has(ad.ad_name) && !['send_alert', 'flag_promising'].includes(rule.action)) continue;

      // Check min_spend
      if (ad.total_spend < Number(rule.min_spend || 0)) continue;

      // Check cooldown
      const cooldownMinutes = rule.cooldown_minutes || 60;
      const recentActions = await pgQuery(
        `SELECT id FROM ad_automation_log
         WHERE rule_id = $1 AND ad_name = $2
         AND created_at > NOW() - INTERVAL '1 minute' * $3
         AND execution_status != 'dry_run'
         LIMIT 1`,
        [rule.id, ad.ad_name, cooldownMinutes]
      );
      if (recentActions.length > 0) continue;

      // Evaluate conditions
      let conditions = rule.conditions;
      if (typeof conditions === 'string') try { conditions = JSON.parse(conditions); } catch { conditions = []; }
      conditions = Array.isArray(conditions) ? conditions : [];
      if (conditions.length === 0) continue;

      const logicOp = (rule.logic_operator || 'AND').toUpperCase();
      let conditionsMet;
      if (logicOp === 'OR') {
        conditionsMet = conditions.some((c) => evaluateCondition(c, ad));
      } else {
        conditionsMet = conditions.every((c) => evaluateCondition(c, ad));
      }

      if (!conditionsMet) continue;

      // Conditions passed — execute action
      const reason = buildConditionReason(conditions, ad);
      const metricsSnapshot = {
        total_spend: ad.total_spend,
        total_revenue: ad.total_revenue,
        total_purchases: ad.total_purchases,
        roas: ad.roas,
        cpa: ad.cpa,
        ctr: ad.ctr,
        cpc: ad.cpc,
        total_impressions: ad.total_impressions,
        total_clicks: ad.total_clicks,
      };

      const logEntry = {
        rule_id: rule.id,
        rule_name: rule.name,
        ad_id: null,
        ad_name: ad.ad_name,
        adset_name: null,
        campaign_name: null,
        entity_level: rule.entity_level || 'ad',
        account_id: null,
        account_name: null,
        action: rule.action,
        reason,
        metrics_snapshot: metricsSnapshot,
        old_value: null,
        new_value: null,
        execution_status: 'success',
        execution_error: null,
        meta_response: null,
      };

      if (rule.dry_run) {
        logEntry.execution_status = 'dry_run';
        await pgQuery(
          `INSERT INTO ad_automation_log
           (rule_id, rule_name, ad_id, ad_name, adset_name, campaign_name, entity_level,
            account_id, account_name, action, reason, metrics_snapshot,
            old_value, new_value, execution_status, execution_error, meta_response)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [logEntry.rule_id, logEntry.rule_name, logEntry.ad_id, logEntry.ad_name,
           logEntry.adset_name, logEntry.campaign_name, logEntry.entity_level,
           logEntry.account_id, logEntry.account_name, logEntry.action, logEntry.reason,
           JSON.stringify(logEntry.metrics_snapshot), logEntry.old_value,
           logEntry.new_value, logEntry.execution_status, logEntry.execution_error,
           logEntry.meta_response]
        );
        await sendSlackAlert(logEntry);
        actionsTaken++;
        continue;
      }

      // Execute the real action
      try {
        const action = rule.action;

        if (action === 'pause_ad') {
          const metaAd = await findAdByName(ad.ad_name);
          if (!metaAd) {
            logEntry.execution_status = 'error';
            logEntry.execution_error = 'Ad not found in Meta';
          } else {
            logEntry.ad_id = metaAd.adId;
            logEntry.ad_name = metaAd.adName;
            logEntry.adset_name = metaAd.adsetName;
            logEntry.campaign_name = metaAd.campaignName;
            logEntry.account_id = metaAd.accountId;
            logEntry.account_name = metaAd.accountName;
            logEntry.old_value = metaAd.effectiveStatus;
            logEntry.new_value = 'PAUSED';
            const metaRes = await pauseAd(metaAd.adId);
            logEntry.meta_response = JSON.stringify(metaRes).slice(0, 500);
          }
        } else if (action === 'resume_ad') {
          const metaAd = await findAdByName(ad.ad_name);
          if (!metaAd) {
            logEntry.execution_status = 'error';
            logEntry.execution_error = 'Ad not found in Meta';
          } else {
            logEntry.ad_id = metaAd.adId;
            logEntry.ad_name = metaAd.adName;
            logEntry.adset_name = metaAd.adsetName;
            logEntry.campaign_name = metaAd.campaignName;
            logEntry.account_id = metaAd.accountId;
            logEntry.account_name = metaAd.accountName;
            logEntry.old_value = metaAd.effectiveStatus;
            logEntry.new_value = 'ACTIVE';
            const metaRes = await resumeAd(metaAd.adId);
            logEntry.meta_response = JSON.stringify(metaRes).slice(0, 500);
          }
        } else if (action === 'increase_budget_pct' || action === 'decrease_budget_pct' ||
                   action === 'increase_budget_fixed' || action === 'decrease_budget_fixed') {
          const metaAd = await findAdByName(ad.ad_name);
          if (!metaAd) {
            logEntry.execution_status = 'error';
            logEntry.execution_error = 'Ad not found in Meta';
          } else if (!metaAd.adsetId || !metaAd.adsetBudget) {
            logEntry.execution_status = 'error';
            logEntry.execution_error = 'Adset or budget not found';
          } else {
            logEntry.ad_id = metaAd.adId;
            logEntry.ad_name = metaAd.adName;
            logEntry.adset_name = metaAd.adsetName;
            logEntry.campaign_name = metaAd.campaignName;
            logEntry.account_id = metaAd.accountId;
            logEntry.account_name = metaAd.accountName;

            const currentBudgetCents = metaAd.adsetBudget; // Meta returns budget in cents
            const actionValue = Math.abs(Number(rule.action_value) || 0); // Always positive
            let newBudgetCents;

            if (action === 'increase_budget_pct') {
              newBudgetCents = Math.round(currentBudgetCents * (1 + actionValue / 100));
            } else if (action === 'decrease_budget_pct') {
              newBudgetCents = Math.round(currentBudgetCents * (1 - actionValue / 100));
            } else if (action === 'increase_budget_fixed') {
              newBudgetCents = Math.round(currentBudgetCents + actionValue * 100);
            } else {
              newBudgetCents = Math.round(currentBudgetCents - actionValue * 100);
            }

            // Enforce max 50% change cap
            const maxChange = Math.round(currentBudgetCents * 0.5);
            const diff = Math.abs(newBudgetCents - currentBudgetCents);
            if (diff > maxChange) {
              newBudgetCents = action.includes('increase')
                ? currentBudgetCents + maxChange
                : currentBudgetCents - maxChange;
            }

            // Enforce min $5 budget (500 cents)
            if (newBudgetCents < 500) newBudgetCents = 500;

            logEntry.old_value = `$${(currentBudgetCents / 100).toFixed(2)}`;
            logEntry.new_value = `$${(newBudgetCents / 100).toFixed(2)}`;

            const metaRes = await updateAdsetBudget(metaAd.adsetId, newBudgetCents);
            logEntry.meta_response = JSON.stringify(metaRes).slice(0, 500);
          }
        } else if (action === 'send_alert') {
          // Alert-only, no Meta API call needed
          logEntry.execution_status = 'success';
        } else if (action === 'flag_promising') {
          logEntry.execution_status = 'success';
        } else {
          logEntry.execution_status = 'error';
          logEntry.execution_error = `Unknown action: ${action}`;
        }
      } catch (err) {
        logEntry.execution_status = 'error';
        logEntry.execution_error = err.message;
        errorsCount++;
      }

      // Log to DB
      await pgQuery(
        `INSERT INTO ad_automation_log
         (rule_id, rule_name, ad_name, adset_name, campaign_name, entity_level,
          account_id, account_name, action, reason, metrics_snapshot,
          old_value, new_value, execution_status, execution_error, meta_response)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [logEntry.rule_id, logEntry.rule_name, logEntry.ad_name, logEntry.adset_name,
         logEntry.campaign_name, logEntry.entity_level, logEntry.account_id,
         logEntry.account_name, logEntry.action, logEntry.reason,
         JSON.stringify(logEntry.metrics_snapshot), logEntry.old_value,
         logEntry.new_value, logEntry.execution_status, logEntry.execution_error,
         logEntry.meta_response]
      );

      // Send Slack alert
      await sendSlackAlert(logEntry);

      // Update rule stats
      await pgQuery(
        `UPDATE ad_automation_rules SET times_triggered = times_triggered + 1, last_triggered_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [rule.id]
      );

      actedAdsThisCycle.add(ad.ad_name);
      actionsTaken++;
    }
  }

  return { rulesEvaluated: rules.length, adsChecked: totalAdsChecked, actionsTaken, errors: errorsCount };
}

// ── Scheduler ───────────────────────────────────────────────────────────
let evaluationRunning = false;
let lastEvaluatedAt = null;
let evaluationCount = 0;

async function scheduledEvaluation() {
  if (evaluationRunning || !TW_API_KEY || !META_ACCESS_TOKEN) return;
  evaluationRunning = true;
  try {
    const result = await evaluateRules();
    lastEvaluatedAt = new Date().toISOString();
    evaluationCount++;
    console.log(`[Ads Control] Evaluation #${evaluationCount}: ${result.actionsTaken} actions, ${result.errors} errors`);
  } catch (err) {
    console.error('[Ads Control] Evaluation error:', err.message);
  } finally {
    evaluationRunning = false;
  }
}

// Start scheduler: first run after 2 minutes, then every 30 minutes
if (TW_API_KEY && META_ACCESS_TOKEN) {
  setTimeout(() => {
    scheduledEvaluation();
    setInterval(scheduledEvaluation, 30 * 60 * 1000);
  }, 2 * 60 * 1000);
  console.log('[Ads Control] Scheduler active — evaluating every 30 minutes');
}

// ── API Endpoints ───────────────────────────────────────────────────────

// POST /rules — Create rule
router.post('/rules', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const {
      name, description, rule_type, entity_level, conditions, logic_operator,
      time_window, action, action_value, min_spend, cooldown_minutes,
      max_executions_per_day, dry_run, priority, scope_type, scope_ids,
    } = req.body;

    if (!name) return res.status(400).json({ success: false, error: { message: 'name is required' } });

    const rows = await pgQuery(
      `INSERT INTO ad_automation_rules
       (name, description, rule_type, entity_level, conditions, logic_operator,
        time_window, action, action_value, min_spend, cooldown_minutes,
        max_executions_per_day, dry_run, priority, scope_type, scope_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [
        name,
        description || '',
        rule_type || 'kill',
        entity_level || 'ad',
        JSON.stringify(typeof conditions === 'string' ? JSON.parse(conditions) : (conditions || [])),
        logic_operator || 'AND',
        time_window || 'today',
        action || 'pause_ad',
        action_value ?? 0,
        min_spend ?? 0,
        cooldown_minutes ?? 60,
        max_executions_per_day ?? 50,
        dry_run ?? false,
        priority || 0,
        scope_type || 'all',
        scope_ids || [],
      ]
    );

    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('[Ads Control] POST /rules error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// GET /rules — List all rules
router.get('/rules', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const rows = await pgQuery(
      'SELECT * FROM ad_automation_rules ORDER BY priority DESC, created_at DESC'
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('[Ads Control] GET /rules error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// PUT /rules/:id — Update rule (partial)
router.put('/rules/:id', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const { id } = req.params;
    const body = req.body;

    const allowedFields = [
      'name', 'description', 'rule_type', 'entity_level', 'conditions', 'logic_operator',
      'time_window', 'action', 'action_value', 'min_spend', 'cooldown_minutes',
      'max_executions_per_day', 'dry_run', 'enabled', 'priority', 'scope_type', 'scope_ids',
    ];

    const setClauses = [];
    const values = [];
    let idx = 1;

    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        let val = body[field];
        if (field === 'conditions') {
          const parsed = typeof val === 'string' ? JSON.parse(val) : val;
          val = JSON.stringify(parsed || []);
        }
        setClauses.push(`${field} = $${idx}`);
        values.push(val);
        idx++;
      }
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ success: false, error: { message: 'No fields to update' } });
    }

    setClauses.push(`updated_at = NOW()`);
    values.push(id);

    const rows = await pgQuery(
      `UPDATE ad_automation_rules SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: { message: 'Rule not found' } });
    }

    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('[Ads Control] PUT /rules/:id error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// DELETE /rules/:id — Delete rule
router.delete('/rules/:id', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const { id } = req.params;
    const rows = await pgQuery('DELETE FROM ad_automation_rules WHERE id = $1 RETURNING id', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: { message: 'Rule not found' } });
    }
    res.json({ success: true, data: { deleted: true, id: Number(id) } });
  } catch (err) {
    console.error('[Ads Control] DELETE /rules/:id error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// POST /rules/:id/toggle — Toggle enabled
router.post('/rules/:id/toggle', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const { id } = req.params;
    const rows = await pgQuery(
      `UPDATE ad_automation_rules SET enabled = NOT enabled, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: { message: 'Rule not found' } });
    }
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('[Ads Control] POST /rules/:id/toggle error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// GET /activity — Get activity log
router.get('/activity', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const offset = parseInt(req.query.offset) || 0;

    const [rows, countRows] = await Promise.all([
      pgQuery(
        'SELECT * FROM ad_automation_log ORDER BY created_at DESC LIMIT $1 OFFSET $2',
        [limit, offset]
      ),
      pgQuery('SELECT COUNT(*) as total FROM ad_automation_log'),
    ]);

    res.json({
      success: true,
      data: {
        total: parseInt(countRows[0]?.total || 0),
        limit,
        offset,
        entries: rows,
      },
    });
  } catch (err) {
    console.error('[Ads Control] GET /activity error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// GET /promising — Get promising ads
router.get('/promising', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const dateStr = req.query.date || formatDate(new Date());
    const ads = await fetchTWAdPerformance(dateStr, dateStr);

    const promising = ads
      .filter((ad) => ad.roas > 2.0 && ad.total_spend > 20)
      .sort((a, b) => b.roas - a.roas)
      .slice(0, 20)
      .map((ad) => {
        const reasons = [];
        if (ad.roas >= 5) reasons.push(`Exceptional ROAS of ${ad.roas.toFixed(2)}x`);
        else if (ad.roas >= 3) reasons.push(`Strong ROAS of ${ad.roas.toFixed(2)}x`);
        else reasons.push(`Profitable ROAS of ${ad.roas.toFixed(2)}x`);
        if (ad.cpa > 0 && ad.cpa < 30) reasons.push(`Low CPA of $${ad.cpa.toFixed(2)}`);
        if (ad.ctr > 2) reasons.push(`High CTR of ${ad.ctr.toFixed(2)}%`);
        if (ad.total_spend > 100) reasons.push(`Proven at $${ad.total_spend.toFixed(2)} spend`);
        return { ...ad, reason: reasons.join('; ') };
      });

    res.json({ success: true, data: promising, date: dateStr });
  } catch (err) {
    console.error('[Ads Control] GET /promising error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// POST /evaluate — Manual trigger
router.post('/evaluate', authenticate, async (req, res) => {
  try {
    if (evaluationRunning) {
      return res.status(409).json({ success: false, error: { message: 'Evaluation already in progress' } });
    }
    evaluationRunning = true;
    const result = await evaluateRules();
    lastEvaluatedAt = new Date().toISOString();
    evaluationCount++;
    evaluationRunning = false;
    res.json({ success: true, data: result });
  } catch (err) {
    evaluationRunning = false;
    console.error('[Ads Control] POST /evaluate error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// GET /status — System status
router.get('/status', authenticate, async (req, res) => {
  try {
    await ensureTables();
    const todayStr = formatDate(new Date());

    const [activeRulesRows, actionsTodayRows, pausedTodayRows, budgetTodayRows, errorsTodayRows] = await Promise.all([
      pgQuery('SELECT COUNT(*) as cnt FROM ad_automation_rules WHERE enabled = true'),
      pgQuery(
        `SELECT COUNT(*) as cnt FROM ad_automation_log WHERE DATE(created_at AT TIME ZONE 'Europe/Berlin') = $1 AND execution_status != 'dry_run'`,
        [todayStr]
      ),
      pgQuery(
        `SELECT COUNT(*) as cnt FROM ad_automation_log WHERE DATE(created_at AT TIME ZONE 'Europe/Berlin') = $1 AND action = 'pause_ad' AND execution_status = 'success'`,
        [todayStr]
      ),
      pgQuery(
        `SELECT COUNT(*) as cnt FROM ad_automation_log WHERE DATE(created_at AT TIME ZONE 'Europe/Berlin') = $1 AND action LIKE '%budget%' AND execution_status = 'success'`,
        [todayStr]
      ),
      pgQuery(
        `SELECT COUNT(*) as cnt FROM ad_automation_log WHERE DATE(created_at AT TIME ZONE 'Europe/Berlin') = $1 AND execution_status = 'error'`,
        [todayStr]
      ),
    ]);

    res.json({
      success: true,
      data: {
        lastEvaluatedAt,
        nextEvaluation: lastEvaluatedAt ? new Date(new Date(lastEvaluatedAt).getTime() + 30 * 60000).toISOString() : null,
        evaluationRunning,
        activeRules: parseInt(activeRulesRows[0]?.cnt || 0),
        actionsToday: parseInt(actionsTodayRows[0]?.cnt || 0),
        pausedToday: parseInt(pausedTodayRows[0]?.cnt || 0),
        budgetChangesToday: parseInt(budgetTodayRows[0]?.cnt || 0),
        errorsToday: parseInt(errorsTodayRows[0]?.cnt || 0),
        schedulerActive: !!(TW_API_KEY && META_ACCESS_TOKEN),
      },
    });
  } catch (err) {
    console.error('[Ads Control] GET /status error:', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

export default router;
