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

/**
 * Get all configured ad account IDs
 */
export function getAllAdAccountIds() {
  return META_AD_ACCOUNT_IDS;
}

/**
 * Fetch ad account details (name, currency, etc.)
 */
export async function getAdAccounts() {
  const results = [];
  for (const accountId of META_AD_ACCOUNT_IDS) {
    try {
      const res = await fetch(
        `${META_GRAPH_URL}/${accountId}?fields=name,account_id,currency,account_status,business_name&access_token=${META_ACCESS_TOKEN}`
      );
      if (res.ok) {
        const data = await res.json();
        results.push({ id: accountId, name: data.name || accountId, currency: data.currency, status: data.account_status, business_name: data.business_name });
      }
    } catch (err) {
      results.push({ id: accountId, name: accountId, error: err.message });
    }
  }
  return results;
}

/**
 * Fetch Facebook Pages for an ad account
 */
export async function getPages(adAccountId) {
  const res = await fetch(
    `${META_GRAPH_URL}/${adAccountId}/promote_pages?fields=id,name,picture&access_token=${META_ACCESS_TOKEN}`
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Meta pages error ${res.status}: ${err.slice(0, 300)}`);
  }
  const data = await res.json();
  return (data.data || []).map(p => ({ id: p.id, name: p.name, picture: p.picture?.data?.url }));
}

/**
 * Fetch Pixels for an ad account
 */
export async function getPixels(adAccountId) {
  const res = await fetch(
    `${META_GRAPH_URL}/${adAccountId}/adspixels?fields=id,name,is_unavailable&access_token=${META_ACCESS_TOKEN}`
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Meta pixels error ${res.status}: ${err.slice(0, 300)}`);
  }
  const data = await res.json();
  return (data.data || []).map(p => ({ id: p.id, name: p.name }));
}

/**
 * Fetch campaigns for an ad account
 */
export async function getCampaigns(adAccountId) {
  const res = await fetch(
    `${META_GRAPH_URL}/${adAccountId}/campaigns?fields=id,name,status,objective,daily_budget,lifetime_budget&limit=100&effective_status=["ACTIVE","PAUSED"]&access_token=${META_ACCESS_TOKEN}`
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Meta campaigns error ${res.status}: ${err.slice(0, 300)}`);
  }
  const data = await res.json();
  return (data.data || []).map(c => ({
    id: c.id, name: c.name, status: c.status, objective: c.objective,
    daily_budget: c.daily_budget, lifetime_budget: c.lifetime_budget
  }));
}

/**
 * Fetch ad sets for a campaign
 */
export async function getAdSets(campaignId) {
  const res = await fetch(
    `${META_GRAPH_URL}/${campaignId}/adsets?fields=id,name,status,daily_budget,targeting,optimization_goal,billing_event&limit=100&effective_status=["ACTIVE","PAUSED"]&access_token=${META_ACCESS_TOKEN}`
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Meta adsets error ${res.status}: ${err.slice(0, 300)}`);
  }
  const data = await res.json();
  return (data.data || []).map(a => ({
    id: a.id, name: a.name, status: a.status, daily_budget: a.daily_budget,
    optimization_goal: a.optimization_goal
  }));
}

/**
 * Fetch custom audiences for an ad account
 */
export async function getCustomAudiences(adAccountId) {
  const res = await fetch(
    `${META_GRAPH_URL}/${adAccountId}/customaudiences?fields=id,name,approximate_count,subtype&limit=200&access_token=${META_ACCESS_TOKEN}`
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Meta audiences error ${res.status}: ${err.slice(0, 300)}`);
  }
  const data = await res.json();
  return (data.data || []).map(a => ({ id: a.id, name: a.name, size: a.approximate_count, subtype: a.subtype }));
}

/**
 * Create an ad set under a campaign
 */
export async function createAdSet(adAccountId, params) {
  const {
    name, campaignId, dailyBudget, optimizationGoal = 'OFFSITE_CONVERSIONS',
    billingEvent = 'IMPRESSIONS', bidStrategy = 'LOWEST_COST_WITHOUT_CAP',
    targetRoas, pixelId, conversionEvent = 'PURCHASE', conversionLocation = 'WEBSITE',
    targeting = {}, status = 'PAUSED', attributionWindow = '7d_click',
    pageId
  } = params;

  const body = {
    access_token: META_ACCESS_TOKEN,
    name,
    campaign_id: campaignId,
    optimization_goal: optimizationGoal,
    billing_event: billingEvent,
    bid_strategy: bidStrategy,
    status,
    targeting: {
      geo_locations: targeting.countries ? { countries: targeting.countries } : { countries: ['US'] },
      age_min: targeting.age_min || 18,
      age_max: targeting.age_max || 65,
      ...(targeting.gender && targeting.gender !== 'all' ? { genders: [targeting.gender === 'male' ? 1 : 2] } : {}),
      ...(targeting.include_audiences?.length ? { custom_audiences: targeting.include_audiences.map(a => ({ id: a.id || a })) } : {}),
      ...(targeting.exclude_audiences?.length ? { excluded_custom_audiences: targeting.exclude_audiences.map(a => ({ id: a.id || a })) } : {}),
    },
    promoted_object: {
      pixel_id: pixelId,
      custom_event_type: conversionEvent,
    },
  };

  if (dailyBudget) body.daily_budget = Math.round(dailyBudget * 100); // cents
  if (targetRoas && bidStrategy === 'LOWEST_COST_WITH_MIN_ROAS') {
    body.bid_constraints = { roas_average_floor: Math.round(targetRoas * 10000) };
  }
  if (attributionWindow === '7d_click') {
    body.attribution_spec = [{ event_type: 'CLICK_THROUGH', window_days: 7 }];
  } else if (attributionWindow === '1d_click') {
    body.attribution_spec = [{ event_type: 'CLICK_THROUGH', window_days: 1 }];
  }

  const res = await fetch(`${META_GRAPH_URL}/${adAccountId}/adsets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Meta adset create error ${res.status}: ${err.slice(0, 500)}`);
  }

  const data = await res.json();
  return data.id;
}

/**
 * Create ad creative with flexible ad format (multiple texts/headlines/descriptions)
 */
export async function createFlexibleAdCreative(adAccountId, params) {
  const {
    name, imageHashes = [], videoId, primaryTexts = [], headlines = [],
    descriptions = [], cta = 'SHOP_NOW', link, pageId, utmParameters
  } = params;

  const finalLink = utmParameters ? `${link}${link.includes('?') ? '&' : '?'}${utmParameters}` : link;

  const assetFeedSpec = {
    bodies: primaryTexts.map(t => ({ text: t })),
    titles: headlines.map(h => ({ text: h })),
    descriptions: descriptions.length ? descriptions.map(d => ({ text: d })) : [{ text: '' }],
    call_to_action_types: [cta],
    link_urls: [{ website_url: finalLink }],
    ad_formats: ['SINGLE_IMAGE'],
  };

  if (imageHashes.length) {
    assetFeedSpec.images = imageHashes.map(hash => ({ hash }));
  }
  if (videoId) {
    assetFeedSpec.videos = [{ video_id: videoId }];
    assetFeedSpec.ad_formats = ['SINGLE_VIDEO'];
  }

  const body = {
    access_token: META_ACCESS_TOKEN,
    name,
    asset_feed_spec: assetFeedSpec,
    object_story_spec: {
      page_id: pageId,
    },
    degrees_of_freedom_spec: {
      creative_features_spec: {
        standard_enhancements: { enroll_status: 'OPT_OUT' },
      },
    },
  };

  const res = await fetch(`${META_GRAPH_URL}/${adAccountId}/adcreatives`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Meta flexible creative error ${res.status}: ${err.slice(0, 500)}`);
  }

  const data = await res.json();
  return data.id;
}

/**
 * Upload video to Meta ad account
 */
export async function uploadAdVideo(adAccountId, videoUrl, title) {
  const res = await fetch(`${META_GRAPH_URL}/${adAccountId}/advideos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      access_token: META_ACCESS_TOKEN,
      file_url: videoUrl,
      title: title || 'Ad Video',
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Meta video upload error ${res.status}: ${err.slice(0, 300)}`);
  }

  const data = await res.json();
  return data.id;
}
