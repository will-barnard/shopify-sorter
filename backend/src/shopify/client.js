import { config } from '../config.js';

export class ShopifyError extends Error {
  constructor(message, { status, body, userErrors } = {}) {
    super(message);
    this.name = 'ShopifyError';
    this.status = status;
    this.body = body;
    this.userErrors = userErrors;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Thin Admin GraphQL client with retry on 429 / 5xx and on GraphQL
 * THROTTLED errors (Shopify's cost-based rate limiter).
 */
export class AdminClient {
  constructor(shop, accessToken) {
    this.shop = shop;
    this.accessToken = accessToken;
    this.endpoint = `https://${shop}/admin/api/${config.apiVersion}/graphql.json`;
  }

  async request(query, variables = {}, { attempt = 0 } = {}) {
    let res;
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': this.accessToken,
          Accept: 'application/json',
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      if (attempt < 3) {
        await sleep(500 * 2 ** attempt);
        return this.request(query, variables, { attempt: attempt + 1 });
      }
      throw new ShopifyError(`Network error calling Shopify: ${err.message}`);
    }

    if (res.status === 401 || res.status === 403) {
      throw new ShopifyError('Shopify rejected the access token (app may have been uninstalled)', {
        status: res.status,
      });
    }

    if (res.status === 429 || res.status >= 500) {
      if (attempt < 5) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
        await sleep(wait);
        return this.request(query, variables, { attempt: attempt + 1 });
      }
      throw new ShopifyError(`Shopify returned HTTP ${res.status}`, { status: res.status });
    }

    const json = await res.json().catch(() => null);
    if (!json) throw new ShopifyError('Shopify returned a non-JSON response', { status: res.status });

    if (json.errors?.length) {
      const throttled = json.errors.some((e) => e.extensions?.code === 'THROTTLED');
      if (throttled && attempt < 5) {
        await sleep(2000 * 2 ** attempt);
        return this.request(query, variables, { attempt: attempt + 1 });
      }
      throw new ShopifyError(json.errors.map((e) => e.message).join('; '), {
        status: res.status,
        body: json,
      });
    }

    return json.data;
  }

  /** Runs a mutation and throws if the payload carries userErrors. */
  async mutate(query, variables, payloadKey) {
    const data = await this.request(query, variables);
    const payload = data?.[payloadKey];
    if (payload?.userErrors?.length) {
      throw new ShopifyError(
        payload.userErrors.map((e) => `${(e.field || []).join('.')}: ${e.message}`).join('; '),
        { userErrors: payload.userErrors }
      );
    }
    return payload;
  }
}
