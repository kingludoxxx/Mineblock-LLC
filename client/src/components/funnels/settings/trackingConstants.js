// Non-component exports for the Tracking section — the error-code map, the
// serving-base resolver and the delivery-status colour map.
//
// A SEPARATE .js FILE ON PURPOSE, the same split settingsPatch.js documents:
// react-refresh requires a .jsx module to export ONLY components, so shared
// constants and helpers live here and the .jsx sibling stays pure components.

// Server 400 codes → operator prose. Every code the two tracking routers can
// emit lives here; an unmapped code still renders honestly as `Failed (code)`
// rather than a generic shrug.
export const TRK_ERR = {
  // routes/trackingAdmin.js
  unknown_kind: 'The server does not support this network yet.',
  invalid_mode: 'Invalid tracking mode — pick one of the three options.',
  invalid_pixel_id: 'That does not look like a Meta Pixel ID — it is numeric, 5 to 20 digits.',
  invalid_measurement_id: 'That does not look like a GA4 Measurement ID — it looks like G-XXXXXXX.',
  invalid_customer_id: 'A Google Ads customer ID is 10 digits (dashes are fine).',
  invalid_enabled: 'Enabled must be on or off.',
  invalid_graph_version: 'Graph version must look like v23.0.',
  pixel_id_required: 'Enter a Pixel ID first — the network config is stored keyed to it.',
  measurement_id_required: 'Enter a Measurement ID first.',
  // routes/trackingIntegrations.js
  invalid_funnel_id: 'That funnel id is not valid.',
  funnel_not_found: 'This funnel no longer exists — reload the page.',
  invalid_id: 'That record id is not valid.',
  not_found: 'That record no longer exists — refresh the list.',
  invalid_body: 'The request body was not an object.',
  nothing_to_update: 'Nothing changed.',
  label_required: 'Give this network a name.',
  label_too_long: 'That name is too long (60 characters max).',
  duplicate_label: 'A custom network with that name already exists on this funnel.',
  invalid_method: 'Method must be GET or POST.',
  invalid_event_names: 'Pick the events this network should receive.',
  unknown_event_name: 'That event is not one this system can send.',
  invalid_click_id_param: 'A click-id parameter is letters, digits and underscores only.',
  network_limit: 'You have reached the limit of 25 custom networks on this funnel.',
  endpoint_limit: 'You have reached the limit of 10 inbound endpoints on this funnel.',
  unknown_preset: 'There is no preset for that network.',
  // template validation (services/trackingPostbackTemplate.js)
  template_required: 'Enter the postback URL template.',
  template_too_long: 'That template is too long (2048 characters max).',
  template_not_a_url: 'That is not a valid URL — it must start with https:// and have a host.',
  template_bad_scheme: 'The template must use https:// (http:// is only allowed for a local dev relay).',
  template_userinfo: 'Remove the user:password@ part — credentials in a URL are refused.',
  template_control_chars: 'The template contains control characters. Remove any line breaks.',
  template_macro_in_host: 'A {macro} cannot appear in the hostname or port — only in the path, query or fragment. Otherwise the destination could change on every conversion.',
  template_no_host: 'The template has no hostname.',
  unsafe_template_blocked_host: 'That host resolves to a private, loopback or cloud-metadata address. Postbacks may only be sent to public internet hosts.',
  unsafe_template_scheme: 'That URL scheme is refused — use https://.',
  internal_error: 'Server error — try again.',
};
export const trkErr = (code, fallback = 'Request failed') =>
  TRK_ERR[code] || (code ? `Failed (${code})` : fallback);
export const errOf = (e, fallback) => trkErr(e?.response?.data?.error?.code, fallback);

// The funnel's public serving base — the same model the Domains tab persists:
// custom_domain (primary) serves the funnel root; otherwise /f/<slug> on this
// app's origin. The SERVER also computes this (GET /directory → serving_base)
// but returns '' when PUBLIC_BASE_URL is unset, in which case the browser's own
// origin is the honest answer and the server must not guess one.
export function servingBase(funnel, serverBase) {
  if (serverBase) return serverBase;
  if (funnel?.custom_domain) return `https://${funnel.custom_domain}`;
  return `${window.location.origin}/f/${funnel?.slug || ''}`;
}

export const EVT_STATUS_CLS = {
  sent: 'text-emerald-400',
  error: 'text-red-400',
  skipped: 'text-orange-400', // terminal like error, but a guard refusal — distinct colour
  deduped: 'text-text-faint',
  queued: 'text-amber-400',
};
