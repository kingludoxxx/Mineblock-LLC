// Client-side presentation metadata for the payment gateways. The server
// (gatewayConfigs.js) is the source of truth for which fields exist and their
// secret/plain classification; this drives labels, placeholders and dashboard
// links only. `kind` mirrors the server: 'secret' fields are write-only +
// masked, 'plain' fields are public identifiers shown in clear.
export const GATEWAY_META = {
  whop: {
    name: 'Whop',
    accent: '#ff6243',
    hasAdapter: true, // charge adapter exists (the one under test)
    dashboard: { live: 'https://whop.com/dashboard', sandbox: 'https://whop.com/dashboard' },
    fields: [
      { key: 'api_key', kind: 'secret', label: 'API key', placeholder: 'whop API key' },
      { key: 'company_id', kind: 'plain', label: 'Company ID', placeholder: 'biz_…' },
      { key: 'webhook_secret', kind: 'secret', label: 'Webhook signing secret', placeholder: 'ws_… / whsec_…' },
      { key: 'plan_id', kind: 'plain', label: 'Plan ID (optional)', placeholder: 'plan_…', optional: true },
    ],
  },
  paypal: {
    name: 'PayPal',
    accent: '#0070ba',
    hasAdapter: false, // charge adapter NOT built yet
    dashboard: { live: 'https://www.paypal.com/businessmanage/', sandbox: 'https://developer.paypal.com/dashboard/' },
    fields: [
      { key: 'client_id', kind: 'plain', label: 'Client ID', placeholder: 'A…' },
      { key: 'client_secret', kind: 'secret', label: 'Client secret', placeholder: 'client secret' },
      { key: 'webhook_id', kind: 'secret', label: 'Webhook ID', placeholder: 'WH-…' },
    ],
  },
  stripe: {
    name: 'Stripe',
    accent: '#635bff',
    hasAdapter: true,
    dashboard: { live: 'https://dashboard.stripe.com', sandbox: 'https://dashboard.stripe.com/test' },
    fields: [
      { key: 'secret_key', kind: 'secret', label: 'Secret key', placeholder: 'sk_live_… / sk_test_…' },
      { key: 'publishable_key', kind: 'plain', label: 'Publishable key', placeholder: 'pk_live_… / pk_test_…' },
      { key: 'webhook_secret', kind: 'secret', label: 'Webhook signing secret', placeholder: 'whsec_…' },
    ],
  },
  nmi: {
    name: 'NMI',
    accent: '#00a94f',
    hasAdapter: false, // charge adapter NOT built yet
    dashboard: { live: 'https://secure.nmi.com/', sandbox: 'https://secure.nmi.com/' },
    fields: [
      { key: 'security_key', kind: 'secret', label: 'Security key', placeholder: 'private security key' },
      { key: 'tokenization_key', kind: 'plain', label: 'Tokenization key (optional)', placeholder: 'public tokenization key', optional: true },
      { key: 'webhook_secret', kind: 'secret', label: 'Webhook signing secret', placeholder: 'signing secret' },
    ],
  },
};

// 2×2 grid order.
export const GATEWAY_ORDER = ['whop', 'paypal', 'stripe', 'nmi'];

// Maps a status string from the health endpoint to pill presentation.
export const STATUS_PRESENTATION = {
  connected: { label: 'Connected', tone: 'success' },
  configured: { label: 'Configured', tone: 'primary' },
  not_configured: { label: 'Not configured', tone: 'warning' },
  error: { label: 'Connection error', tone: 'danger' },
  unknown: { label: 'Unknown', tone: 'default' },
  checking: { label: 'Checking…', tone: 'default' },
};
