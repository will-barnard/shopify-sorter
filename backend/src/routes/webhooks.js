import express from 'express';
import { verifyWebhookHmac, normalizeShop } from '../shopify/verify.js';
import { markUninstalled } from '../shopify/shops.js';

export const webhookRouter = express.Router();

// Webhook HMAC is computed over the raw body, so parse as a Buffer here only.
webhookRouter.use(express.raw({ type: '*/*', limit: '2mb' }));

webhookRouter.use((req, res, next) => {
  const hmac = req.get('X-Shopify-Hmac-Sha256');
  if (!verifyWebhookHmac(req.body, hmac)) {
    return res.status(401).send('Invalid webhook signature');
  }
  req.shopDomain = normalizeShop(req.get('X-Shopify-Shop-Domain'));
  try {
    req.payload = JSON.parse(req.body.toString('utf8') || '{}');
  } catch {
    req.payload = {};
  }
  next();
});

webhookRouter.post('/app/uninstalled', async (req, res) => {
  // Always ack fast; Shopify retries on non-2xx.
  res.status(200).send('ok');
  if (!req.shopDomain) return;
  try {
    await markUninstalled(req.shopDomain);
    console.log(`[webhook] ${req.shopDomain} uninstalled`);
  } catch (err) {
    console.error('[webhook] uninstall handling failed', err);
  }
});

webhookRouter.post('/shop/redact', (req, res) => res.status(200).send('ok'));
webhookRouter.post('/customers/redact', (req, res) => res.status(200).send('ok'));
webhookRouter.post('/customers/data_request', (req, res) => res.status(200).send('ok'));
