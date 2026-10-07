/**
 * The lead-time notice: pure decision/edit logic, then the runner against a fake
 * Shopify that holds real descriptions, so "idempotent" and "never interleaves"
 * are checked on the wire rather than assumed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://localhost/none';
process.env.SHOPIFY_API_KEY ||= 'test-api-key';
process.env.SHOPIFY_API_SECRET ||= 'test-api-secret';
process.env.APP_URL ||= 'https://example.test';

const { DEFAULT_NOTICE, applyNotice, comparable, decideNotice, noticeParagraph } = await import(
  '../src/engine/leadTime.js'
);
const {
  DEFAULT_SETTINGS,
  enqueueForShop,
  fetchProductByInventoryItem,
  handleInventoryEvent,
  parseSettings,
  reconcileProduct,
  sweepShop,
} = await import('../src/engine/leadTimeRunner.js');
const { ShopifyError } = await import('../src/shopify/client.js');

const NOTICE = noticeParagraph(DEFAULT_NOTICE);
const BODY = '<p>The Mellotron M4000D is the digital Mellotron.</p>\n<p>Features:</p>';

const v = (qty, { policy = 'CONTINUE', tracked = true } = {}) => ({
  id: `gid://shopify/ProductVariant/${Math.random()}`,
  title: 'Standard',
  inventoryQuantity: qty,
  inventoryPolicy: policy,
  inventoryItem: { tracked },
});

// ---- pure ------------------------------------------------------------------

test('comparable ignores markup, entities, case, dashes and spacing', () => {
  assert.equal(
    comparable('<p><strong>Please  allow 1–3 weeks&nbsp;for shipping at this time, thank you!</strong></p>'),
    comparable(DEFAULT_NOTICE)
  );
});

test('applyNotice adds the notice first, once, and is idempotent', () => {
  const a = applyNotice(BODY, DEFAULT_NOTICE, true);
  assert.equal(a.action, 'added');
  assert.ok(a.html.startsWith(`${NOTICE}\n<p>The Mellotron`));
  const b = applyNotice(a.html, DEFAULT_NOTICE, true);
  assert.equal(b.changed, false);
  assert.equal(b.html, a.html);
});

test('applyNotice removes it and restores the original description exactly', () => {
  const withIt = applyNotice(BODY, DEFAULT_NOTICE, true).html;
  const gone = applyNotice(withIt, DEFAULT_NOTICE, false);
  assert.equal(gone.action, 'removed');
  assert.equal(gone.html, BODY);
});

test('applyNotice leaves a notice-free description byte-for-byte alone when hiding', () => {
  const odd = '  <p>x</p>  ';
  const r = applyNotice(odd, DEFAULT_NOTICE, false);
  assert.equal(r.changed, false);
  assert.equal(r.html, odd);
});

test('applyNotice adopts a hand-typed notice rather than duplicating it', () => {
  const typed = `<p>${DEFAULT_NOTICE}</p>\n${BODY}`;
  const r = applyNotice(typed, DEFAULT_NOTICE, true);
  assert.equal(r.action, 'repositioned');
  assert.equal(r.html.match(/Please allow/g).length, 1);
});

test('applyNotice moves a buried notice to the top and swaps legacy wordings', () => {
  const buried = `${BODY}\n<p><strong>Allow 2 weeks.</strong></p>`;
  const r = applyNotice(buried, 'New wording.', true, ['Allow 2 weeks.']);
  assert.ok(r.html.startsWith('<p><strong>New wording.</strong></p>'));
  assert.ok(!r.html.includes('Allow 2 weeks'));
});

test('applyNotice escapes the notice text', () => {
  assert.equal(noticeParagraph('A & B'), '<p><strong>A &amp; B</strong></p>');
});

test('decideNotice: special order shows, in stock hides, sold out hides', () => {
  assert.equal(decideNotice([v(0)]).show, true);
  assert.equal(decideNotice([v(-2)]).show, true);
  assert.equal(decideNotice([v(1)]).show, false);
  assert.equal(decideNotice([v(0, { policy: 'DENY' })]).show, false);
  assert.equal(decideNotice([v(0, { tracked: false })]).show, false);
  assert.equal(decideNotice([]).show, false);
});

test('decideNotice: any colour in stock hides the shared notice', () => {
  assert.equal(decideNotice([v(0), v(3)]).show, false);
  assert.equal(decideNotice([v(0), v(0)]).show, true);
});

// ---- settings --------------------------------------------------------------

test('parseSettings validates and keeps absent keys', () => {
  const r = parseSettings({ enabled: true }, DEFAULT_SETTINGS);
  assert.equal(r.enabled, true);
  assert.equal(r.tag, 'special-order');
  assert.throws(() => parseSettings({ enabled: 'yes' }), /true or false/);
  assert.throws(() => parseSettings({ tag: 'a,b' }), /commas/);
  assert.throws(() => parseSettings({ tag: '"x"' }), /quotes/);
  assert.throws(() => parseSettings({ tag: 'Restoration' }), /reserved/);
  assert.throws(() => parseSettings({ tag: '  ' }), /tag/);
  assert.throws(() => parseSettings({ noticeText: '<b>x</b>' }), /plain text/);
  assert.throws(() => parseSettings({ noticeText: 'x'.repeat(301) }), /300/);
  assert.throws(() => parseSettings({ sweepAt: '25:00' }), /Sweep time/);
  assert.equal(parseSettings({ sweepAt: '4:05' }).sweepAt, '04:05');
});

test('parseSettings remembers the previous wording when the text changes', () => {
  const first = parseSettings({ noticeText: 'Second.' }, DEFAULT_SETTINGS);
  assert.deepEqual(first.legacyNotices, [DEFAULT_NOTICE]);
  const second = parseSettings({ noticeText: 'Third.' }, first);
  assert.deepEqual(second.legacyNotices, ['Second.', DEFAULT_NOTICE]);
  // Changing back removes it from legacy: it's current again.
  const back = parseSettings({ noticeText: DEFAULT_NOTICE }, second);
  assert.deepEqual(back.legacyNotices, ['Third.', 'Second.']);
});

// ---- runner against a fake Shopify -----------------------------------------

class FakeShopify {
  constructor(products, { legacyOnly = false } = {}) {
    this.products = new Map(products.map((p) => [p.id, structuredClone(p)]));
    this.legacyOnly = legacyOnly;
    this.writes = [];
    this.requests = [];
    this.active = 0;
    this.maxActive = 0;
  }

  async #io(fn) {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    await new Promise((r) => setTimeout(r, 2));
    try {
      return fn();
    } finally {
      this.active -= 1;
    }
  }

  itemProduct(itemId) {
    for (const p of this.products.values()) {
      if (p.itemIds?.includes(String(itemId))) return p;
    }
    return null;
  }

  async request(query, vars) {
    this.requests.push(query.match(/(query|mutation) (\w+)/)[2]);
    return this.#io(() => {
      if (query.includes('LeadTimeProductByInventoryItemLegacy')) {
        const id = vars.id.split('/').pop();
        return { inventoryItem: { id: vars.id, variant: { product: this.itemProduct(id) } } };
      }
      if (query.includes('LeadTimeProductByInventoryItem')) {
        if (this.legacyOnly) {
          throw new ShopifyError("Field 'variants' doesn't exist on type 'InventoryItem'", {
            body: { errors: [{ extensions: { code: 'undefinedField' } }] },
          });
        }
        const id = vars.id.split('/').pop();
        const p = this.itemProduct(id);
        return { inventoryItem: { id: vars.id, variants: { nodes: p ? [{ product: p }] : [] } } };
      }
      if (query.includes('LeadTimeProductsByTag')) {
        const tag = /tag:"([^"]+)"/.exec(vars.query)[1].toLowerCase();
        const nodes = [...this.products.values()]
          .filter((p) => p.tags.map((t) => t.toLowerCase()).includes(tag))
          .map((p) => ({ id: p.id }));
        return { products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } };
      }
      if (query.includes('LeadTimeProductState')) return { product: this.products.get(vars.id) || null };
      throw new Error(`unexpected query ${query.slice(0, 40)}`);
    });
  }

  async mutate(query, vars, key) {
    assert.equal(key, 'productUpdate');
    return this.#io(() => {
      const p = this.products.get(vars.product.id);
      p.descriptionHtml = vars.product.descriptionHtml;
      this.writes.push(vars.product.id);
      return { product: { id: p.id, descriptionHtml: p.descriptionHtml } };
    });
  }
}

const product = (over = {}) => ({
  id: 'gid://shopify/Product/1',
  title: 'Mellotron M4000D',
  status: 'DRAFT',
  tags: ['special-order'],
  descriptionHtml: BODY,
  itemIds: ['11'],
  variants: { pageInfo: { hasNextPage: false }, nodes: [v(0), v(0)] },
  ...over,
});

const settings = { ...DEFAULT_SETTINGS, enabled: true, legacyNotices: [] };
const shop = { id: '1', domain: 'demo.myshopify.com', access_token: 't' };

function deps(client) {
  const events = [];
  return {
    events,
    getSettings: async () => settings,
    record: async (e) => events.push(e),
    clientFor: () => client,
  };
}

test('an inventory event adds the notice when the last unit is gone, using one read', async () => {
  const client = new FakeShopify([product()]);
  const d = deps(client);
  const res = await handleInventoryEvent(shop, { inventory_item_id: 11, available: 0 }, 'webhook', d);
  assert.equal(res.outcome, 'changed');
  assert.ok(client.products.get('gid://shopify/Product/1').descriptionHtml.startsWith(NOTICE));
  assert.deepEqual(client.requests, ['LeadTimeProductByInventoryItem']);
  assert.equal(d.events[0].action, 'added');
  assert.equal(d.events[0].trigger, 'webhook');
});

test('a second identical event writes nothing and logs nothing', async () => {
  const client = new FakeShopify([product()]);
  const d = deps(client);
  await handleInventoryEvent(shop, { inventory_item_id: 11 }, 'webhook', d);
  await handleInventoryEvent(shop, { inventory_item_id: 11 }, 'webhook', d);
  assert.equal(client.writes.length, 1);
  assert.equal(d.events.length, 1);
});

test('stock arriving removes the notice', async () => {
  const client = new FakeShopify([product({ descriptionHtml: `${NOTICE}\n${BODY}` })]);
  client.products.get('gid://shopify/Product/1').variants.nodes[0].inventoryQuantity = 2;
  const d = deps(client);
  const res = await handleInventoryEvent(shop, { inventory_item_id: 11 }, 'webhook', d);
  assert.equal(res.action, 'removed');
  assert.equal(client.products.get('gid://shopify/Product/1').descriptionHtml, BODY);
});

test('untagged and restoration products are never touched', async () => {
  const client = new FakeShopify([
    product({ id: 'gid://shopify/Product/2', tags: ['piano'], itemIds: ['22'] }),
    product({ id: 'gid://shopify/Product/3', tags: ['special-order', 'restoration'], itemIds: ['33'] }),
  ]);
  const d = deps(client);
  const a = await handleInventoryEvent(shop, { inventory_item_id: 22 }, 'webhook', d);
  const b = await handleInventoryEvent(shop, { inventory_item_id: 33 }, 'webhook', d);
  assert.equal(a.outcome, 'skipped');
  assert.equal(b.outcome, 'skipped');
  assert.equal(client.writes.length, 0);
});

test('products with more than 100 variants are skipped, not judged on one page', async () => {
  const client = new FakeShopify([
    product({ variants: { pageInfo: { hasNextPage: true }, nodes: [v(0)] } }),
  ]);
  const r = await handleInventoryEvent(shop, { inventory_item_id: 11 }, 'webhook', deps(client));
  assert.equal(r.outcome, 'skipped');
  assert.equal(client.writes.length, 0);
});

test('disabled settings, junk payloads and unknown items are no-ops', async () => {
  const client = new FakeShopify([product()]);
  const off = { ...deps(client), getSettings: async () => ({ ...settings, enabled: false }) };
  assert.equal((await handleInventoryEvent(shop, { inventory_item_id: 11 }, 'webhook', off)).outcome, 'skipped');
  assert.equal((await handleInventoryEvent(shop, {}, 'webhook', deps(client))).outcome, 'skipped');
  assert.equal((await handleInventoryEvent(shop, { inventory_item_id: 'x' }, 'webhook', deps(client))).outcome, 'skipped');
  assert.equal((await handleInventoryEvent(shop, { inventory_item_id: 999 }, 'webhook', deps(client))).outcome, 'skipped');
  assert.equal(client.writes.length, 0);
});

test('falls back to the deprecated InventoryItem.variant only on an undefined-field error', async () => {
  const client = new FakeShopify([product()], { legacyOnly: true });
  const p = await fetchProductByInventoryItem(client, '11');
  assert.equal(p.id, 'gid://shopify/Product/1');
  assert.deepEqual(client.requests, ['LeadTimeProductByInventoryItem', 'LeadTimeProductByInventoryItemLegacy']);

  const failing = {
    request: async () => {
      throw new ShopifyError('Network error calling Shopify: boom');
    },
  };
  await assert.rejects(() => fetchProductByInventoryItem(failing, '11'), /Network error/);
});

test('a Shopify failure is recorded as an error and never thrown', async () => {
  const client = new FakeShopify([product()]);
  client.mutate = async () => {
    throw new Error('productUpdate: description too long');
  };
  const d = deps(client);
  const res = await handleInventoryEvent(shop, { inventory_item_id: 11 }, 'webhook', d);
  assert.equal(res.outcome, 'error');
  assert.equal(d.events[0].action, 'error');
  assert.match(d.events[0].message, /too long/);
});

test('legacy wordings are replaced on the next event', async () => {
  const old = '<p><strong>Allow 2 weeks.</strong></p>';
  const client = new FakeShopify([product({ descriptionHtml: `${old}\n${BODY}` })]);
  const s = { ...settings, legacyNotices: ['Allow 2 weeks.'] };
  const d = { ...deps(client), getSettings: async () => s };
  await handleInventoryEvent(shop, { inventory_item_id: 11 }, 'webhook', d);
  const html = client.products.get('gid://shopify/Product/1').descriptionHtml;
  assert.ok(!html.includes('Allow 2 weeks'));
  assert.equal(html.match(/Please allow/g).length, 1);
});

test('reconcileProduct dryRun reports the change and writes nothing', async () => {
  const client = new FakeShopify([product()]);
  const r = await reconcileProduct({
    client,
    product: client.products.get('gid://shopify/Product/1'),
    settings,
    dryRun: true,
  });
  assert.equal(r.outcome, 'would-change');
  assert.equal(r.action, 'added');
  assert.equal(client.writes.length, 0);
});

test('sweep fixes every tagged product, preview writes and logs nothing, a real run logs changes', async () => {
  const client = new FakeShopify([
    product(),
    product({
      id: 'gid://shopify/Product/2',
      title: 'Mini',
      descriptionHtml: `${NOTICE}\n${BODY}`,
      variants: { pageInfo: { hasNextPage: false }, nodes: [v(4)] },
    }),
    product({ id: 'gid://shopify/Product/9', tags: ['piano'] }),
  ]);
  const d = deps(client);

  const dry = await sweepShop({ shop, settings, dryRun: true, deps: d });
  assert.equal(dry.checked, 2);
  assert.equal(dry.changed, 2);
  assert.equal(client.writes.length, 0);
  assert.equal(d.events.length, 0);

  const real = await sweepShop({ shop, settings, deps: d });
  assert.equal(real.changed, 2);
  assert.equal(d.events.length, 2);

  const again = await sweepShop({ shop, settings, deps: d });
  assert.equal(again.changed, 0);
  assert.equal(again.unchanged, 2);
  assert.equal(client.writes.length, 2);
});

test('a sweep keeps going when one product fails', async () => {
  const client = new FakeShopify([product(), product({ id: 'gid://shopify/Product/2', itemIds: ['22'] })]);
  const realMutate = client.mutate.bind(client);
  client.mutate = async (q, vars, key) => {
    if (vars.product.id.endsWith('/1')) throw new Error('boom');
    return realMutate(q, vars, key);
  };
  const s = await sweepShop({ shop, settings, deps: deps(client) });
  assert.equal(s.errors, 1);
  assert.equal(s.changed, 1);
});

test('enqueueForShop serialises one shop, lets shops run in parallel, and survives failures', async () => {
  const order = [];
  const task = (name, ms, fail = false) => async () => {
    order.push(`start ${name}`);
    await new Promise((r) => setTimeout(r, ms));
    order.push(`end ${name}`);
    if (fail) throw new Error('x');
  };
  const a1 = enqueueForShop('a.myshopify.com', task('a1', 15, true));
  const a2 = enqueueForShop('a.myshopify.com', task('a2', 1));
  const b1 = enqueueForShop('b.myshopify.com', task('b1', 1));
  await assert.rejects(a1);
  await a2;
  await b1;
  assert.ok(order.indexOf('end a1') < order.indexOf('start a2'), 'same shop never overlaps');
  assert.ok(order.indexOf('start b1') < order.indexOf('end a1'), 'other shops are not blocked');
});

test('events for one shop never overlap their Shopify calls', async () => {
  const client = new FakeShopify([product()]);
  const d = deps(client);
  await Promise.all(
    Array.from({ length: 5 }, () =>
      enqueueForShop(shop.domain, () => handleInventoryEvent(shop, { inventory_item_id: 11 }, 'webhook', d))
    )
  );
  assert.equal(client.maxActive, 1);
  assert.equal(client.writes.length, 1);
});
