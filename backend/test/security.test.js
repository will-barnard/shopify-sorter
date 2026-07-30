import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

// config.js reads these at import time.
process.env.DATABASE_URL ||= 'postgres://localhost/none';
process.env.SHOPIFY_API_KEY ||= 'test-api-key';
process.env.SHOPIFY_API_SECRET ||= 'test-api-secret';
process.env.APP_URL ||= 'https://example.test';

const { normalizeShop, verifyOAuthHmac, verifyWebhookHmac, verifySessionToken } = await import(
  '../src/shopify/verify.js'
);

const SECRET = process.env.SHOPIFY_API_SECRET;
const API_KEY = process.env.SHOPIFY_API_KEY;

test('normalizeShop accepts valid domains and rejects everything else', () => {
  assert.equal(normalizeShop('my-store.myshopify.com'), 'my-store.myshopify.com');
  assert.equal(normalizeShop('https://My-Store.myshopify.com/admin'), 'my-store.myshopify.com');

  for (const bad of [
    'evil.com',
    'my-store.myshopify.com.evil.com',
    'my-store.myshopify.co',
    '../etc/passwd',
    '',
    null,
    undefined,
    'foo bar.myshopify.com',
  ]) {
    assert.equal(normalizeShop(bad), null, `should reject: ${bad}`);
  }
});

test('OAuth HMAC accepts a correctly signed query and rejects tampering', () => {
  const params = { code: 'abc123', shop: 'my-store.myshopify.com', state: 'xyz', timestamp: '1700000000' };
  const message = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  const hmac = crypto.createHmac('sha256', SECRET).update(message).digest('hex');

  assert.ok(verifyOAuthHmac({ ...params, hmac }));
  assert.ok(!verifyOAuthHmac({ ...params, shop: 'evil.myshopify.com', hmac }), 'tampered shop');
  assert.ok(!verifyOAuthHmac({ ...params, hmac: hmac.replace(/.$/, '0') }), 'tampered hmac');
  assert.ok(!verifyOAuthHmac(params), 'missing hmac');
  assert.ok(!verifyOAuthHmac({ ...params, hmac: 'short' }), 'wrong-length hmac');
});

test('webhook HMAC is computed over the raw body', () => {
  const body = Buffer.from(JSON.stringify({ id: 1, domain: 'my-store.myshopify.com' }));
  const digest = crypto.createHmac('sha256', SECRET).update(body).digest('base64');

  assert.ok(verifyWebhookHmac(body, digest));
  assert.ok(!verifyWebhookHmac(Buffer.from(body.toString() + ' '), digest), 'modified body');
  assert.ok(!verifyWebhookHmac(body, 'notavalidhmac'), 'bad signature');
  assert.ok(!verifyWebhookHmac(body, undefined), 'missing signature');
});

const makeToken = (claims = {}, secret = SECRET) =>
  jwt.sign(
    {
      iss: 'https://my-store.myshopify.com/admin',
      dest: 'https://my-store.myshopify.com',
      aud: API_KEY,
      sub: '42',
      exp: Math.floor(Date.now() / 1000) + 60,
      nbf: Math.floor(Date.now() / 1000) - 10,
      iat: Math.floor(Date.now() / 1000) - 10,
      ...claims,
    },
    secret,
    { algorithm: 'HS256' }
  );

test('a valid session token resolves to the shop in `dest`', () => {
  const { shop } = verifySessionToken(makeToken());
  assert.equal(shop, 'my-store.myshopify.com');
});

test('session tokens signed with the wrong secret are rejected', () => {
  assert.throws(() => verifySessionToken(makeToken({}, 'wrong-secret')), /invalid signature/i);
});

test('session tokens for another app (wrong aud) are rejected', () => {
  assert.throws(() => verifySessionToken(makeToken({ aud: 'someone-elses-key' })), /audience/i);
});

test('expired session tokens are rejected', () => {
  assert.throws(
    () => verifySessionToken(makeToken({ exp: Math.floor(Date.now() / 1000) - 3600 })),
    /expired/i
  );
});

test('an `iss` that disagrees with `dest` is rejected', () => {
  // This is the confused-deputy case: a token minted for one shop being
  // presented as if it belonged to another.
  assert.throws(
    () => verifySessionToken(makeToken({ iss: 'https://other-store.myshopify.com/admin' })),
    /does not match/
  );
});

test('a non-myshopify `dest` is rejected', () => {
  assert.throws(() => verifySessionToken(makeToken({ dest: 'https://evil.com' })), /invalid `dest`/);
});

test('the "none" algorithm is rejected', () => {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ dest: 'https://my-store.myshopify.com', aud: API_KEY })
  ).toString('base64url');
  assert.throws(() => verifySessionToken(`${header}.${payload}.`));
});
