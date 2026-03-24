// ── Meta Ads API Service ─────────────────────────────────────────────────
// Wraps the Meta Marketing API for launching ads (image upload, creative, ad).

const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || '';
const META_AD_ACCOUNT_IDS = (process.env.META_AD_ACCOUNT_IDS || '').split(',').filter(Boolean);
const META_GRAPH_URL = 'https://graph.facebook.com/v21.0';

/**
 * Upload an ad image to a Meta ad account
 * @param {string} adAccountId - e.g. 'act_123456'
 * @param {Buffer} imageBuffer - Image data
 * @returns {{ hash: string, url: string }}
 */
export async function uploadAdImage(adAccountId, imageBuffer) {
  const formData = new FormData();
  formData.append('access_token', META_ACCESS_TOKEN);
  formData.append('filename', 'creative.png');
  // Image needs to be sent as bytes
  const blob = new Blob([imageBuffer], { type: 'image/png' });
  formData.append('bytes', blob);

  const res = await fetch(`${META_GRAPH_URL}/${adAccountId}/adimages`, {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Meta adimages upload error ${res.status}: ${err.slice(0, 300)}`);
  }

  const data = await res.json();
  // Response: { images: { "filename.png": { hash, url } } }
  const imageData = Object.values(data.images || {})[0];
  if (!imageData?.hash) throw new Error('No image hash returned from Meta');
  return { hash: imageData.hash, url: imageData.url };
}

/**
 * Create an ad creative (flexible ad format)
 * @param {string} adAccountId
 * @param {object} params - { name, imageHashes[], primaryText, headlines[], descriptions[], cta, link }
 * @returns {string} creativeId
 */
export async function createAdCreative(adAccountId, params) {
  const { name, imageHashes, primaryText, headlines, descriptions, cta = 'LEARN_MORE', link } = params;

  // Build asset feed spec for flexible ad
  const assetFeedSpec = {
    images: imageHashes.map(hash => ({ hash })),
    bodies: [{ text: primaryText }],
    titles: headlines.map(h => ({ text: h })),
    descriptions: descriptions.map(d => ({ text: d })),
    call_to_action_types: [cta],
    link_urls: [{ website_url: link }],
  };

  const res = await fetch(`${META_GRAPH_URL}/${adAccountId}/adcreatives`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      access_token: META_ACCESS_TOKEN,
      name,
      asset_feed_spec: assetFeedSpec,
      object_story_spec: {
        page_id: process.env.META_PAGE_ID || '',
        link_data: {
          link: link,
          message: primaryText,
        },
      },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Meta adcreatives error ${res.status}: ${err.slice(0, 300)}`);
  }

  const data = await res.json();
  return data.id;
}

/**
 * Create an ad under an existing adset
 * @param {string} adAccountId
 * @param {object} params - { name, adsetId, creativeId, status }
 * @returns {string} adId
 */
export async function createAd(adAccountId, params) {
  const { name, adsetId, creativeId, status = 'PAUSED' } = params;

  const res = await fetch(`${META_GRAPH_URL}/${adAccountId}/ads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      access_token: META_ACCESS_TOKEN,
      name,
      adset_id: adsetId,
      creative: { creative_id: creativeId },
      status,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Meta ads create error ${res.status}: ${err.slice(0, 300)}`);
  }

  const data = await res.json();
  return data.id;
}

/**
 * Get ad status
 */
export async function getAdStatus(adId) {
  const res = await fetch(`${META_GRAPH_URL}/${adId}?fields=effective_status,name&access_token=${META_ACCESS_TOKEN}`);
  if (!res.ok) throw new Error(`Meta ad status error ${res.status}`);
  const data = await res.json();
  return { status: data.effective_status, name: data.name };
}

/**
 * Get default ad account ID
 */
export function getDefaultAdAccountId() {
  return META_AD_ACCOUNT_IDS[0] || '';
}

/**
 * Check if Meta Ads API is configured
 */
export function isMetaAdsConfigured() {
  return !!(META_ACCESS_TOKEN && META_AD_ACCOUNT_IDS.length > 0);
}
