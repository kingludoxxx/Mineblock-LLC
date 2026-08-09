// The ad-network DIRECTORY — one pure data module, server-side, so the card
// grid, the per-network detail page, the ad-URL builder and the custom-network
// PRESETS all read the same facts. Nothing here touches the database.
//
// Ported from funnel-os lb_s2s_registry.S2S_NETWORKS (card metadata + click
// ids + server channel + setup prose) and lb_wizard_service (NETWORK_MACROS +
// AD_URL_TEMPLATES — the ad-URL macro sets). The postback PRESETS are derived
// from that codebase's per-network senders (lb_tracking_service.send_*_s2s),
// rewritten as {macro} templates for OUR generic custom-S2S adapter.
//
// ── WHAT `wired` MEANS, AND WHY THE HONESTY MATTERS ─────────────────────────
//   wired: 'server'   a real adapter delivers this network today. Only two:
//                     meta_pixel (Conversions API) and ga4 (Measurement
//                     Protocol), both in trackingDelivery.KIND_SENDERS.
//   wired: 'preset'   NO dedicated adapter — but the network's server channel
//                     IS a plain click-id postback, so the operator can run it
//                     through the generic custom-S2S template engine with the
//                     preset below prefilled. It genuinely delivers; it is
//                     just not a bespoke adapter.
//   wired: 'stub'     nothing delivers. The card exists so the directory is
//                     complete; the detail page says so in plain words.
//
// A preset's `postback_template` is a STARTING POINT, not a guarantee. The
// operator saves it as a custom network, test-fires it, and sees the real
// response code before any money rides on it. Where a network needs an account
// credential inside the URL (MGID's postback id, RevContent's api key), the
// template carries a visible ALL-CAPS placeholder the operator must replace —
// never a fake value that would silently 200 against the wrong account.

// The sub-id convention, standardised across every network so a `sub1` means
// the same thing whatever bought the click (funnel-os lb_wizard_service):
//   sub1 = ad / creative id · sub2 = ad set / ad group id · sub3 = platform extra
export const SUB_CONVENTION = 'sub1 = ad / creative id · sub2 = ad set / ad group id · sub3 = the platform’s own extra (placement, site, widget)';

export const NETWORK_DIRECTORY = [
  {
    key: 'meta',
    kind: 'meta_pixel',
    name: 'Meta (Facebook & Instagram)',
    method: 'Conversions API',
    tag: 'S+B',
    accent: '#1877F2',
    click_ids: ['fbclid'],
    wired: 'server',
    id_label: 'Meta Pixel ID',
    setup: 'Events Manager → Settings → Conversions API → Generate access token.',
    // Meta APPENDS fbclid itself on the click — pasting a macro for it would
    // put a literal string in the vault.
    click_id_note: 'Leave fbclid out of the URL — Meta appends it automatically on the click.',
    ad_url_params: 'utm_source=meta&campaignid={{campaign.id}}&sub1={{ad.id}}&sub2={{adset.id}}&sub3={{site_source_name}}',
  },
  {
    key: 'tiktok',
    name: 'TikTok',
    method: 'Events API',
    tag: 'S+B',
    accent: '#00F2EA',
    click_ids: ['ttclid'],
    wired: 'stub',
    id_label: 'TikTok Pixel ID',
    setup: 'TikTok Events Manager → Web Events → Settings → Generate access token.',
    ad_url_params: 'ttclid=__CLICKID__&utm_source=tiktok&campaignid=__CAMPAIGN_ID__&sub1=__CID__&sub2=__AID__',
  },
  {
    key: 'applovin',
    name: 'AppLovin AXON',
    method: 'Browser pixel — no public web S2S yet',
    tag: 'BROWSER',
    accent: '#0AB4FF',
    click_ids: [],
    wired: 'stub',
    id_label: 'AXON SDK Key',
    // Not a "coming soon": AppLovin ships no public server API for web events,
    // so there is nothing to build. Saying so is the honest card.
    setup: 'The AXON web pixel fires in the browser. AppLovin has no public server API for web events, so there is no server channel to connect — this is a limitation of the network, not a missing integration.',
    ad_url_params: '',
  },
  {
    key: 'pinterest',
    name: 'Pinterest',
    method: 'Conversions API v5',
    tag: 'S+B',
    accent: '#E60023',
    click_ids: ['epik'],
    wired: 'stub',
    id_label: 'Pinterest Tag ID',
    setup: 'Pinterest Business → Settings → Conversions → Generate token.',
    ad_url_params: 'epik={{epik}}&utm_source=pinterest',
  },
  {
    key: 'snapchat',
    name: 'Snapchat',
    method: 'Conversions API v3',
    tag: 'S+B',
    accent: '#FFFC00',
    click_ids: ['sccid'],
    wired: 'stub',
    id_label: 'Snap Pixel ID',
    setup: 'Snap Ads Manager → Business settings → Conversions API tokens.',
    ad_url_params: 'sccid={{click_id}}&utm_source=snapchat',
  },
  {
    key: 'taboola',
    name: 'Taboola',
    method: 'S2S postback (click id)',
    tag: 'S+B',
    accent: '#3D5AFE',
    click_ids: ['tblci'],
    wired: 'preset',
    id_label: 'Taboola Account ID',
    setup: 'No account credential is needed — the conversion rides the visitor’s tblci click id. Create a conversion in Taboola named exactly as you set `name=` below, append the click-id macro to your campaign URL, then save and test-fire the preset.',
    ad_url_params: 'tblci={click_id}&utm_source=taboola&campaignid={campaign}&site={site}&sub3={site}&cpc={cpc}',
    preset: {
      label: 'Taboola S2S',
      click_id_param: 'tblci',
      method: 'GET',
      // trc.taboola.com/actions-handler/log/3/s2s-action — click-id, name,
      // revenue, currency, orderid (funnel-os send_taboola_s2s).
      postback_template: 'https://trc.taboola.com/actions-handler/log/3/s2s-action?click-id={click_id}&name={event}&revenue={payout}&currency={currency}&orderid={order_id}',
      event_names: ['Purchase'],
      needs_credential: false,
    },
  },
  {
    key: 'outbrain',
    name: 'Outbrain',
    method: 'S2S postback (click id)',
    tag: 'S+B',
    accent: '#F18421',
    click_ids: ['obclid', 'ob_click_id', 'dicbo'],
    wired: 'preset',
    id_label: 'Outbrain Marketer ID',
    setup: 'No account credential is needed — the conversion rides the visitor’s obclid. Create conversions named purchase / lead / … in Amplify (Outbrain matches by NAME), append the macro to your campaign URLs, then test-fire.',
    ad_url_params: 'obclid={{ob_click_id}}&utm_source=outbrain&campaignid={{campaign_id}}&site={{publisher_name}}&sub3={{publisher_name}}&cpc={{cpc}}',
    preset: {
      label: 'Outbrain S2S',
      click_id_param: 'obclid',
      method: 'GET',
      // tr.outbrain.com/pixel — ob_click_id, name, orderValue, currency, orderId.
      postback_template: 'https://tr.outbrain.com/pixel?ob_click_id={click_id}&name={event}&orderValue={payout}&currency={currency}&orderId={order_id}',
      event_names: ['Purchase'],
      needs_credential: false,
    },
  },
  {
    key: 'newsbreak',
    name: 'NewsBreak Ads',
    method: 'S2S postback / server events',
    tag: 'SERVER',
    accent: '#D1372C',
    click_ids: ['nb_click_id'],
    wired: 'preset',
    id_label: 'NewsBreak Pixel ID',
    setup: 'The nvss_ callback id captured as the click id IS the credential. Set `event_type` to the value you configured in NewsBreak Event Management — the preset leaves it as a placeholder because a wrong value is accepted silently.',
    // NewsBreak documents no cost macro. Leaving cpc out is deliberate — a
    // guessed macro lands the literal string in the vault and corrupts spend.
    ad_url_params: 'nb_click_id=__CALLBACK_PARAM__&utm_source=newsbreak',
    preset: {
      label: 'NewsBreak S2S',
      click_id_param: 'nb_click_id',
      method: 'GET',
      postback_template: 'https://business.newsbreak.com/tracking/attribute?callback={click_id}&event_type=YOUR_EVENT_TYPE&nb_value={payout}',
      event_names: ['Purchase'],
      needs_credential: true,
      credential_note: 'Replace YOUR_EVENT_TYPE with the event_type from NewsBreak → Event Management before saving.',
    },
  },
  {
    key: 'revcontent',
    name: 'RevContent',
    method: 'S2S postback (click id)',
    tag: 'SERVER',
    accent: '#00A4E4',
    click_ids: ['rc_uuid'],
    wired: 'preset',
    id_label: 'RevContent ID',
    setup: 'RevContent’s own docs forbid running the browser pixel and S2S together — there is no dedup between them. Pick one; this preset is the S2S half.',
    ad_url_params: 'rc_uuid={{widget_clickid}}&utm_source=revcontent&site={{widget_id}}&sub3={{widget_id}}&cpc={{cpc}}',
    preset: {
      label: 'RevContent S2S',
      click_id_param: 'rc_uuid',
      method: 'GET',
      postback_template: 'https://trends.revcontent.com/api/v1/conversion.php?api_key=YOUR_API_KEY&rc_uuid={click_id}&amount={payout}',
      event_names: ['Purchase'],
      needs_credential: true,
      credential_note: 'Replace YOUR_API_KEY with your RevContent API access key. Note RevContent expects a non-zero INTEGER amount — a sub-$1 order rounds to 0 and is rejected.',
    },
  },
  {
    key: 'mgid',
    name: 'MGID',
    method: 'S2S postback (click id)',
    tag: 'SERVER',
    accent: '#1E88E5',
    click_ids: ['mgid_click'],
    wired: 'preset',
    id_label: 'MGID Client ID',
    setup: 'MGID’s postback id sits in the URL PATH and is the credential — paste yours in place of YOUR_POSTBACK_ID.',
    ad_url_params: 'mgid_click={click_id}&utm_source=mgid&campaignid={campaign_id}&site={widget_id}&sub3={widget_id}&cpc={price}',
    preset: {
      label: 'MGID S2S',
      click_id_param: 'mgid_click',
      method: 'GET',
      postback_template: 'https://a.mgid.com/postback/YOUR_POSTBACK_ID?c={click_id}&e={event}&r={payout}',
      event_names: ['Purchase'],
      needs_credential: true,
      credential_note: 'Replace YOUR_POSTBACK_ID with the postback id from your MGID account.',
    },
  },
  {
    key: 'google_ads',
    kind: 'google_ads',
    name: 'Google Ads (incl. YouTube)',
    method: 'Ads API click-conversion upload',
    tag: 'S+B',
    accent: '#4285F4',
    click_ids: ['gclid', 'wbraid', 'gbraid'],
    // Registered in TRACKING_NETWORKS but DORMANT — credentials store, nothing
    // delivers. The card must never imply otherwise.
    wired: 'stub',
    id_label: 'Google Ads customer ID (10 digits)',
    setup: 'One connection covers Search, Display, Shopping and YouTube. Turn Google Ads auto-tagging ON — gclid arrives via auto-tagging, never from the URL; without it a server conversion has nothing to match.',
    click_id_note: 'Turn auto-tagging ON in Google Ads. `{gclid}` is not a real ValueTrack macro — pasting it sends the literal string.',
    ad_url_params: 'utm_source=google&campaignid={campaignid}&sub1={creative}&sub2={adgroupid}&sub3={network}',
  },
  {
    key: 'reddit',
    name: 'Reddit Ads',
    method: 'Conversions API',
    tag: 'S+B',
    accent: '#FF4500',
    click_ids: ['rdt_cid'],
    wired: 'stub',
    id_label: 'Reddit Pixel ID',
    setup: 'Reddit Ads → Events Manager → Conversions API → generate an access token.',
    ad_url_params: 'rdt_cid={{RDT_CID}}&utm_source=reddit',
  },
];

// GA4 is not a card in the grid — it belongs to the Google foundation layer,
// which the directory pins above the grid. It IS server-wired.
export const FOUNDATION = {
  key: 'gtm',
  name: 'Google Tag Manager',
  sublabel: 'GTM · GA4 · first-party tagging server',
  badge: 'Recommended base layer',
  accent: '#8AB4F8',
  members: [
    {
      key: 'ga4',
      kind: 'ga4',
      name: 'Google Analytics 4',
      method: 'Measurement Protocol',
      wired: 'server',
      id_label: 'Measurement ID (G-…)',
      setup: 'Admin → Data streams → Measurement Protocol API secrets.',
    },
    {
      key: 'gtm_container',
      name: 'Google Tag Manager container',
      method: 'Browser container (dataLayer)',
      wired: 'stub',
      id_label: 'Container ID (GTM-…)',
      setup: 'The browser container loader ships with the tag-manager phase; nothing is injected today.',
    },
  ],
  note: 'Optional but recommended. GTM fires the browser tags and a first-party tagging server keeps them alive under ad-blockers. S2S postbacks work WITHOUT this — conversions still send server-side.',
};

const BY_KEY = new Map(NETWORK_DIRECTORY.map((n) => [n.key, n]));
export const networkByKey = (key) => BY_KEY.get(String(key || '')) || null;

// The ready-to-paste ad URL for one network on one funnel. `base` is the
// funnel's public serving URL; the caller owns resolving it (custom domain vs
// /f/<slug>), because only the caller knows the funnel row.
export function adUrlFor(key, base) {
  const net = networkByKey(key);
  if (!net || !net.ad_url_params) return '';
  const b = String(base || '').trim();
  if (!b) return '';
  return `${b}${b.includes('?') ? '&' : '?'}${net.ad_url_params}`;
}

// The preset payload for creating a custom S2S network from a directory card —
// exactly the body shape POST /custom-networks accepts, so the client posts it
// unmodified.
export function presetBodyFor(key) {
  const net = networkByKey(key);
  if (!net || !net.preset) return null;
  const p = net.preset;
  return {
    label: p.label,
    url_template: p.postback_template,
    click_id_param: p.click_id_param,
    method: p.method,
    event_names: p.event_names,
    // A preset that still carries an ALL-CAPS credential placeholder lands
    // DISABLED: saving it enabled would start firing postbacks at a URL that
    // is guaranteed to be wrong, and some networks answer 200 to anything.
    enabled: !p.needs_credential,
  };
}

export default {
  NETWORK_DIRECTORY, FOUNDATION, SUB_CONVENTION, networkByKey, adUrlFor, presetBodyFor,
};
