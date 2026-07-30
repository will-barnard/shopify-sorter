import express from 'express';
import { config, scopeString } from '../config.js';
import { normalizeShop, verifyOAuthHmac, randomToken } from '../shopify/verify.js';
import { AdminClient, ShopifyError } from '../shopify/client.js';
import { SHOP_INFO, CREATE_WEBHOOK } from '../shopify/queries.js';
import { upsertShop } from '../shopify/shops.js';

export const authRouter = express.Router();

const STATE_COOKIE = 'sorter_oauth_state';

// The app is framed inside the Shopify admin, so the state cookie has to be
// SameSite=None; Secure for the browser to send it back on the callback.
const stateCookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'none',
  path: '/',
  maxAge: 10 * 60 * 1000,
};

/** Kicks off OAuth. Must be reached at the top level, not inside the iframe. */
authRouter.get('/auth', (req, res) => {
  const shop = normalizeShop(req.query.shop);
  if (!shop) return res.status(400).send('Missing or invalid `shop` parameter.');

  // Shopify only signs this request when it originates from Shopify (e.g. the
  // install link). Our own frontend bounces here unsigned, which is fine.
  if (req.query.hmac && !verifyOAuthHmac(req.query)) {
    return res.status(401).send('HMAC validation failed.');
  }

  const state = randomToken();
  res.cookie(STATE_COOKIE, state, stateCookieOptions);

  const authorizeUrl = new URL(`https://${shop}/admin/oauth/authorize`);
  authorizeUrl.searchParams.set('client_id', config.apiKey);
  authorizeUrl.searchParams.set('scope', scopeString);
  authorizeUrl.searchParams.set('redirect_uri', `${config.appUrl}/auth/callback`);
  authorizeUrl.searchParams.set('state', state);

  res.redirect(authorizeUrl.toString());
});

authRouter.get('/auth/callback', async (req, res) => {
  const shop = normalizeShop(req.query.shop);
  const { code, state } = req.query;

  if (!shop || !code) return res.status(400).send('Missing `shop` or `code`.');
  if (!verifyOAuthHmac(req.query)) return res.status(401).send('HMAC validation failed.');

  const expectedState = req.cookies?.[STATE_COOKIE];
  if (!expectedState || expectedState !== state) {
    return res.status(403).send('OAuth state mismatch. Please retry the installation.');
  }
  res.clearCookie(STATE_COOKIE, { ...stateCookieOptions, maxAge: undefined });

  try {
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: config.apiKey,
        client_secret: config.apiSecret,
        code,
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text().catch(() => '');
      throw new ShopifyError(`Token exchange failed (HTTP ${tokenRes.status}): ${text.slice(0, 300)}`);
    }

    const { access_token: accessToken, scope } = await tokenRes.json();
    if (!accessToken) throw new ShopifyError('Token exchange returned no access_token.');

    const client = new AdminClient(shop, accessToken);
    let shopInfo = null;
    try {
      shopInfo = (await client.request(SHOP_INFO))?.shop;
    } catch (err) {
      console.warn('[auth] could not read shop info:', err.message);
    }

    await upsertShop({
      domain: shop,
      accessToken,
      scope,
      name: shopInfo?.name,
      ianaTimezone: shopInfo?.ianaTimezone,
    });

    await registerWebhooks(client);

    // Land the merchant back inside the embedded admin.
    res.redirect(`https://${shop}/admin/apps/${config.apiKey}`);
  } catch (err) {
    console.error('[auth] callback failed', err);
    res.status(500).send(`Installation failed: ${err.message}`);
  }
});

async function registerWebhooks(client) {
  const topics = [
    ['APP_UNINSTALLED', `${config.appUrl}/webhooks/app/uninstalled`],
    ['SHOP_REDACT', `${config.appUrl}/webhooks/shop/redact`],
  ];

  for (const [topic, callbackUrl] of topics) {
    try {
      await client.mutate(
        CREATE_WEBHOOK,
        { topic, sub: { callbackUrl, format: 'JSON' } },
        'webhookSubscriptionCreate'
      );
    } catch (err) {
      // Re-registering an existing subscription is a userError, not a failure.
      if (/already exists|taken/i.test(err.message)) continue;
      console.warn(`[auth] webhook ${topic} registration failed:`, err.message);
    }
  }
}
