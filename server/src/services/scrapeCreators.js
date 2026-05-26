/**
 * ScrapeCreators API client
 */

import axios from 'axios';

const BASE_URL = 'https://api.scrapecreators.com/v1';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
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
        country: country ?? 'ALL',
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
      const retryable =
        err.code === 'ECONNABORTED' ||
        err.code === 'ETIMEDOUT' ||
        status === 429 ||
        (status !== null && status >= 500);
      const code =
        status === 401 ? 'AUTH'
          : status === 404 ? 'NOT_FOUND'
          : status === 429 ? 'RATE_LIMIT'
          : status && status >= 500 ? 'UPSTREAM'
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
