/**
 * ScrapeCreators API client
 */

import axios from 'axios';

const BASE_URL = 'https://api.scrapecreators.com/v1';
// Fix C2: raise timeout to 60s. /company/ads and /search/ads regularly take
// 20-40s on high-cursor pages; the old 30s cap turned normal slow calls
// into ECONNABORTED aborts, and every abort still burned a credit on SC's
// side (they process/bill the request even if the client stopped waiting).
const DEFAULT_TIMEOUT_MS = 60_000;
// Fix C2: retries reduced to 2. Historic value of 3 could triple-charge
// us on flaky-network days when combined with the retryable timeout bug.
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 1_000;

export class ScrapeCreatorsError extends Error {
  constructor(message, status, code, retryable) {
    super(message);
    this.name = 'ScrapeCreatorsError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export class ScrapeCreatorsClient {
  constructor({ apiKey, timeoutMs, onCreditsUsed }) {
    if (!apiKey) throw new Error('SCRAPECREATORS_API_KEY is required');
    this.onCreditsUsed = onCreditsUsed;
    this.http = axios.create({
      baseURL: BASE_URL,
      timeout: timeoutMs ?? DEFAULT_TIMEOUT_MS,
      headers: { 'x-api-key': apiKey },
    });
  }

  async searchCompanies(q) {
    return this._request('GET', '/facebook/adLibrary/search/companies', { query: q });
  }

  async getAdLibraryDetail(adArchiveId) {
    return this._request('GET', '/facebook/adLibrary/ad', { id: adArchiveId });
  }

  async *iterateCompanyAds({ pageId, country, status, maxPages }) {
    const cap = maxPages ?? 30;
    let cursor = null;
    let fetched = 0;

    do {
      const resp = await this._request('GET', '/facebook/adLibrary/company/ads', {
        pageId,
        country: country ?? 'ALL',
        status: status ?? 'ALL',
        ...(cursor ? { cursor } : {}),
      });

      if (resp.results?.length) yield resp.results;
      cursor = resp.cursor ?? null;
      fetched += 1;
    } while (cursor && fetched < cap);
  }

  async *iterateAdsByDomain({ domain, status, country, maxPages }) {
    const cap = maxPages ?? 50;
    let cursor = null;
    let fetched = 0;

    do {
      const resp = await this._request('GET', '/facebook/adLibrary/search/ads', {
        query: domain,
        search_type: 'keyword_exact_phrase',
        country: country ?? 'US',
        status: status ?? 'ALL',
        sort_by: 'total_impressions',
        ...(cursor ? { cursor } : {}),
      });

      if (resp.searchResults?.length) yield resp.searchResults;
      cursor = resp.cursor ?? null;
      fetched += 1;
    } while (cursor && fetched < cap);
  }

  async getCreditBalance() {
    return this._request('GET', '/account/credit-balance');
  }

  async _request(method, path, params = {}) {
    let lastErr;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await this.http.request({
          method,
          url: path,
          params: method === 'GET' ? params : undefined,
          data: method === 'POST' ? params : undefined,
        });
        this.onCreditsUsed?.(1);
        return res.data;
      } catch (err) {
        lastErr = err;
        const mapped = this._mapError(err);
        if (!mapped.retryable || attempt === MAX_RETRIES) throw mapped;
        const delayMs = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) + Math.random() * 250;
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    throw lastErr;
  }

  _mapError(err) {
    if (axios.isAxiosError(err)) {
      const status = err.response?.status ?? null;
      const body = err.response?.data;
      const message = body?.message ?? body?.error ?? err.message ?? 'ScrapeCreators request failed';
      // Fix C2: DO NOT retry on ECONNABORTED / ETIMEDOUT. When axios aborts a
      // request client-side, SC's server has almost always received and
      // billed the request already — retrying pays a second credit for the
      // same logical call. 429 (rate-limit) is safe to retry because SC
      // doesn't bill rate-limited requests. 5xx (gateway) is retryable
      // because in practice SC's edge rejects before billing.
      const retryable =
        status === 429 ||
        (status !== null && status >= 502 && status <= 504);
      const code =
        status === 401 ? 'AUTH'
          : status === 404 ? 'NOT_FOUND'
          : status === 429 ? 'RATE_LIMIT'
          : status && status >= 500 ? 'UPSTREAM'
          : err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' ? 'TIMEOUT'
          : 'UNKNOWN';
      return new ScrapeCreatorsError(message, status, code, retryable);
    }
    return new ScrapeCreatorsError(
      err instanceof Error ? err.message : 'Unknown error',
      null, 'UNKNOWN', false,
    );
  }
}

let _client = null;

export function getScrapeCreatorsClient() {
  if (!_client) {
    const apiKey = process.env.SCRAPECREATORS_API_KEY;
    if (!apiKey) throw new Error('SCRAPECREATORS_API_KEY env var is not set.');
    _client = new ScrapeCreatorsClient({ apiKey });
  }
  return _client;
}
