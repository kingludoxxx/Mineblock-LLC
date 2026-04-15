// Lightweight Slack alert helper used for operational notifications
// (Frame.io OAuth health, stray project checks, createFrameFolder failures, etc.).
// Reuses the same SLACK_BOT_TOKEN as metaWebhook's rejection alerts; target
// channel is SLACK_ALERTS_CHANNEL (falls back to SLACK_REJECTION_CHANNEL so
// we don't silently drop alerts if the dedicated channel isn't configured).
import logger from './logger.js';

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || '';
const SLACK_ALERTS_CHANNEL =
  process.env.SLACK_ALERTS_CHANNEL ||
  process.env.SLACK_REJECTION_CHANNEL ||
  '';

/**
 * Post an alert to Slack. No-ops (returns {ok:false, skipped:true}) if
 * credentials are missing so callers don't need to null-check env vars.
 *
 * @param {string} text      - Primary message text (used in notifications).
 * @param {object} [opts]
 * @param {string} [opts.level=warn] - 'info' | 'warn' | 'error' (prefixes emoji).
 * @param {object} [opts.fields]     - Key/value pairs shown as Slack section fields.
 * @param {string} [opts.source]     - Short string identifying the caller.
 */
export async function sendSlackAlert(text, opts = {}) {
  const { level = 'warn', fields, source } = opts;
  if (!SLACK_BOT_TOKEN || !SLACK_ALERTS_CHANNEL) {
    logger.warn(
      `[slackAlert] skipped (missing SLACK_BOT_TOKEN or SLACK_ALERTS_CHANNEL) — would have sent: ${text}`,
    );
    return { ok: false, skipped: true };
  }

  const prefix = level === 'error' ? ':rotating_light:' : level === 'info' ? ':information_source:' : ':warning:';
  const blocks = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `${prefix} *${source || 'Alert'}* — ${text}` },
    },
  ];
  if (fields && Object.keys(fields).length > 0) {
    blocks.push({
      type: 'section',
      fields: Object.entries(fields).slice(0, 10).map(([k, v]) => ({
        type: 'mrkdwn',
        text: `*${k}:*\n${typeof v === 'string' ? v : JSON.stringify(v)}`,
      })),
    });
  }

  try {
    const resp = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        channel: SLACK_ALERTS_CHANNEL,
        text: `${prefix} ${source ? `[${source}] ` : ''}${text}`,
        username: 'Mineblock Bot',
        icon_url: 'https://i.imgur.com/PJCRE4g.png',
        blocks,
      }),
    });
    const data = await resp.json();
    if (!data.ok) {
      logger.error(`[slackAlert] Slack returned error: ${data.error}`);
    }
    return data;
  } catch (err) {
    logger.error(`[slackAlert] fetch failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

export default sendSlackAlert;
