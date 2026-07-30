import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;

export function normalizeShop(input) {
  if (!input || typeof input !== 'string') return null;
  const shop = input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return SHOP_RE.test(shop) ? shop : null;
}

function safeEqualHex(a, b) {
  const ab = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Verifies the `hmac` query parameter Shopify attaches to OAuth redirects.
 * Everything except `hmac` and the legacy `signature` is sorted and joined.
 */
export function verifyOAuthHmac(queryObject) {
  const { hmac, signature: _ignored, ...rest } = queryObject || {};
  if (!hmac) return false;
  const message = Object.keys(rest)
    .sort()
    .map((k) => {
      const value = Array.isArray(rest[k]) ? rest[k].join(',') : rest[k];
      return `${k}=${value}`;
    })
    .join('&');
  const digest = crypto.createHmac('sha256', config.apiSecret).update(message, 'utf8').digest('hex');
  return safeEqualHex(digest, hmac);
}

/** Verifies the X-Shopify-Hmac-Sha256 header on a webhook, against the RAW body. */
export function verifyWebhookHmac(rawBody, headerHmac) {
  if (!headerHmac || !rawBody) return false;
  const digest = crypto.createHmac('sha256', config.apiSecret).update(rawBody).digest('base64');
  const a = Buffer.from(digest, 'base64');
  const b = Buffer.from(String(headerHmac), 'base64');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Verifies an App Bridge session token (JWT, HS256, signed with the API secret).
 * Returns the shop domain the token is destined for.
 */
export function verifySessionToken(token) {
  const payload = jwt.verify(token, config.apiSecret, {
    algorithms: ['HS256'],
    audience: config.apiKey,
    clockTolerance: 10,
  });

  // `dest` is the shop this token is scoped to. It is the only trustworthy
  // source of the shop domain — never take the shop from a query param here.
  const shop = normalizeShop(payload.dest);
  if (!shop) throw new Error('Session token has an invalid `dest` claim');

  const issuerShop = normalizeShop(payload.iss);
  if (!issuerShop || issuerShop !== shop) {
    throw new Error('Session token `iss` does not match `dest`');
  }

  return { shop, payload };
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}
