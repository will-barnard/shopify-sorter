/**
 * Exercises the real webhook router over HTTP: signature checking, the
 * inventory route's ack-then-handle behaviour, and that the raw-body parser is
 * mounted before any JSON parser (the HMAC is over the raw bytes).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.DATABASE_URL ||= 'postgres://localhost/none';
process.env.SHOPIFY_API_KEY ||= 'test-api-key';
process.env.SHOPIFY_API_SECRET ||= 'test-api-secret';
process.env.APP_URL ||= 'https://example.test';

const { webhookRouter, hooks } = await import('../src/routes/webhooks.js');
const SECRET = process.env.SHOPIFY_API_SECRET;

async function withServer(fn) {
  // Mirrors index.js: webhooks first, JSON parser after.
  const app = express();
  app.use('/webhooks', webhookRouter);
  app.use(express.json());
  const server = await new Promise((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const sign = (body) => crypto.createHmac('sha256', SECRET).update(body).digest('base64');

const post = (base, path, body, { hmac = sign(body), shop = 'demo.myshopify.com' } = {}) =>
  fetch(`${base}/webhooks${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Hmac-Sha256': hmac,
      'X-Shopify-Shop-Domain': shop,
    },
    body,
  });

test('a signed inventory event is acked and handed to the handler with shop and payload', async () => {
  const seen = [];
  const original = hooks.inventory;
  hooks.inventory = async (shop, payload) => seen.push({ shop, payload });
  try {
    await withServer(async (base) => {
      const body = JSON.stringify({ inventory_item_id: 42, location_id: 7, available: 0 });
      const res = await post(base, '/inventory_levels/update', body);
      assert.equal(res.status, 200);
      await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(seen, [
        { shop: 'demo.myshopify.com', payload: { inventory_item_id: 42, location_id: 7, available: 0 } },
      ]);
    });
  } finally {
    hooks.inventory = original;
  }
});

test('bad or missing signatures are rejected and the handler never runs', async () => {
  let calls = 0;
  const original = hooks.inventory;
  hooks.inventory = async () => {
    calls += 1;
  };
  try {
    await withServer(async (base) => {
      const body = JSON.stringify({ inventory_item_id: 42 });
      assert.equal((await post(base, '/inventory_levels/update', body, { hmac: sign('other') })).status, 401);
      assert.equal((await post(base, '/inventory_levels/update', body, { hmac: '' })).status, 401);
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(calls, 0);
    });
  } finally {
    hooks.inventory = original;
  }
});

test('a handler that throws still gets a 200 ack (Shopify would otherwise retry)', async () => {
  const original = hooks.inventory;
  const origError = console.error;
  console.error = () => {};
  hooks.inventory = async () => {
    throw new Error('boom');
  };
  try {
    await withServer(async (base) => {
      const res = await post(base, '/inventory_levels/update', '{}');
      assert.equal(res.status, 200);
      await new Promise((r) => setTimeout(r, 20));
    });
  } finally {
    hooks.inventory = original;
    console.error = origError;
  }
});

test('index.js mounts /webhooks before the cookie and JSON parsers', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/index.js', import.meta.url)), 'utf8');
  const webhooks = src.indexOf("app.use('/webhooks'");
  assert.ok(webhooks > 0, 'webhooks are mounted');
  assert.ok(webhooks < src.indexOf('cookieParser()'), 'before cookieParser');
  assert.ok(webhooks < src.indexOf("app.use('/api'"), 'before the API (which parses JSON)');
});
