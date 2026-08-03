/**
 * End-to-end exercise of the runner's core loop against a fake Shopify that
 * implements the real collectionReorderProducts semantics (sequential moves,
 * newPosition interpreted at apply time). Verifies that a rule actually lands
 * the collection in the intended order over the wire.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://localhost/none';
process.env.SHOPIFY_API_KEY ||= 'test-api-key';
process.env.SHOPIFY_API_SECRET ||= 'test-api-secret';
process.env.APP_URL ||= 'https://example.test';

const { evaluate } = await import('../src/engine/rules.js');
const { planMoves } = await import('../src/engine/planner.js');
const { toMoveInput } = await import('../src/engine/runner.js');

/**
 * A stand-in Shopify store that applies moves exactly as documented, and is as
 * strict about the wire format as the real Admin API. In particular
 * MoveInput.newPosition is an UnsignedInt64, which must arrive as a *string*;
 * a JSON number is rejected. This fake rejects numbers too, so the serialisation
 * bug that broke the first live run can never come back silently.
 */
class FakeShopify {
  constructor(products, sortOrder = 'MANUAL') {
    this.products = products.slice();
    this.sortOrder = sortOrder;
    this.reorderCalls = 0;
    this.movesReceived = 0;
  }

  reorder(moves) {
    this.reorderCalls += 1;
    this.movesReceived += moves.length;
    for (const { id, newPosition } of moves) {
      if (typeof newPosition !== 'string') {
        throw new Error(
          `Variable $moves of type [MoveInput!]! was provided invalid value for newPosition ` +
            `(UnsignedInt64 '${newPosition}' must be encoded as a string)`
        );
      }
      if (!/^\d+$/.test(newPosition)) {
        throw new Error(`Shopify: newPosition '${newPosition}' is not an unsigned integer`);
      }
      const position = Number(newPosition);

      const from = this.products.findIndex((p) => p.id === id);
      if (from === -1) throw new Error(`Shopify: unknown product ${id}`);
      if (position < 0 || position >= this.products.length) {
        throw new Error(`Shopify: newPosition ${position} out of range`);
      }
      const [item] = this.products.splice(from, 1);
      this.products.splice(position, 0, item);
    }
  }

  ids() {
    return this.products.map((p) => p.id);
  }
}

const makeProducts = (specs) =>
  specs.map((s, i) => ({
    id: `gid://shopify/Product/${i + 1}`,
    title: s.title || `Product ${i + 1}`,
    tags: s.tags || [],
    status: s.status || 'ACTIVE',
    totalInventory: s.inventory ?? 10,
    createdAt: s.createdAt || `2024-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    priceRangeV2: { minVariantPrice: { amount: String(s.price ?? 10), currencyCode: 'USD' } },
  }));

/** Mirrors runner.js: fetch -> evaluate -> plan -> serialise -> send -> verify. */
function runAgainst(shopify, strategy) {
  const { order } = evaluate(shopify.products, strategy);
  const currentIds = shopify.ids();
  const targetIds = order.map((p) => p.id);
  const moves = planMoves(currentIds, targetIds);
  if (moves.length) shopify.reorder(moves.map(toMoveInput));
  return { targetIds, moves };
}

test('the primary use case lands correctly over the wire', () => {
  const products = makeProducts([
    { title: 'Alpha' },
    { title: 'Bravo' },
    { title: 'Charlie', tags: ['New'] },
    { title: 'Delta' },
    { title: 'Echo', tags: ['new'] },
    { title: 'Foxtrot' },
  ]);
  const shopify = new FakeShopify(products);

  const { targetIds, moves } = runAgainst(shopify, {
    base: 'current',
    groups: [{ type: 'tag', tags: ['new'], match: 'any', position: 'top' }],
  });

  assert.deepEqual(shopify.ids(), targetIds, 'Shopify ended in the intended order');
  assert.deepEqual(
    shopify.products.map((p) => p.title),
    ['Charlie', 'Echo', 'Alpha', 'Bravo', 'Delta', 'Foxtrot']
  );
  assert.equal(moves.length, 2, 'only the two tagged products moved');
});

test('re-running an already-sorted collection is a no-op', () => {
  const shopify = new FakeShopify(
    makeProducts([{ tags: ['new'] }, { tags: ['new'] }, {}, {}])
  );
  const strategy = {
    base: 'current',
    groups: [{ type: 'tag', tags: ['new'], match: 'any', position: 'top' }],
  };

  runAgainst(shopify, strategy);
  const afterFirst = shopify.ids();
  const callsAfterFirst = shopify.reorderCalls;

  runAgainst(shopify, strategy);
  assert.deepEqual(shopify.ids(), afterFirst, 'order is stable');
  assert.equal(shopify.reorderCalls, callsAfterFirst, 'no second mutation was sent');
});

test('the rule is idempotent across many repeated daily runs', () => {
  const shopify = new FakeShopify(
    makeProducts(
      Array.from({ length: 40 }, (_, i) => ({
        tags: i % 6 === 0 ? ['featured'] : [],
        inventory: i % 9 === 0 ? 0 : 5,
      }))
    )
  );
  const strategy = {
    base: 'current',
    groups: [
      { type: 'tag', tags: ['featured'], match: 'any', position: 'top' },
      { type: 'out_of_stock', position: 'bottom' },
    ],
  };

  runAgainst(shopify, strategy);
  const settled = shopify.ids();

  for (let day = 0; day < 30; day++) {
    const { moves } = runAgainst(shopify, strategy);
    assert.equal(moves.length, 0, `day ${day} should need no moves`);
  }
  assert.deepEqual(shopify.ids(), settled);
});

test('a newly tagged product is pulled up on the next run, at minimum cost', () => {
  const shopify = new FakeShopify(makeProducts(Array.from({ length: 50 }, () => ({}))));
  const strategy = {
    base: 'current',
    groups: [{ type: 'tag', tags: ['featured'], match: 'any', position: 'top' }],
  };

  runAgainst(shopify, strategy);

  // The merchant tags one product near the bottom overnight.
  shopify.products[47].tags = ['featured'];
  const tagged = shopify.products[47].id;

  const { moves } = runAgainst(shopify, strategy);
  assert.equal(moves.length, 1, 'exactly one product moved');
  assert.equal(shopify.ids()[0], tagged, 'and it is now first');
});

test('combined top and bottom groups both land', () => {
  const shopify = new FakeShopify(
    makeProducts([
      { title: 'A' },
      { title: 'B', inventory: 0 },
      { title: 'C', tags: ['featured'] },
      { title: 'D' },
      { title: 'E', inventory: 0 },
      { title: 'F', tags: ['featured'] },
    ])
  );

  runAgainst(shopify, {
    base: 'current',
    groups: [
      { type: 'tag', tags: ['featured'], match: 'any', position: 'top' },
      { type: 'out_of_stock', position: 'bottom' },
    ],
  });

  assert.deepEqual(
    shopify.products.map((p) => p.title),
    ['C', 'F', 'A', 'D', 'B', 'E']
  );
});

test('a full metric re-sort is applied correctly', () => {
  const shopify = new FakeShopify(
    makeProducts([
      { title: 'Cheap', price: 5 },
      { title: 'Pricey', price: 100 },
      { title: 'Mid', price: 50 },
      { title: 'Free', price: 0 },
    ])
  );

  runAgainst(shopify, { base: 'price_desc', groups: [] });

  assert.deepEqual(
    shopify.products.map((p) => p.title),
    ['Pricey', 'Mid', 'Cheap', 'Free']
  );
});

test('every move sent to Shopify is within range as it is applied', () => {
  // A pathological shuffle: reverse a large collection.
  const shopify = new FakeShopify(makeProducts(Array.from({ length: 120 }, () => ({}))));
  const reversed = shopify.ids().slice().reverse();
  const moves = planMoves(shopify.ids(), reversed);

  // FakeShopify throws if any newPosition is out of range at apply time.
  assert.doesNotThrow(() => shopify.reorder(moves.map(toMoveInput)));
  assert.deepEqual(shopify.ids(), reversed);
});

test('newPosition is serialised as a string, because it is an UnsignedInt64', () => {
  // Regression: sending a JSON number gets rejected by the Admin API with
  // "UnsignedInt64 '5' must be encoded as a string".
  assert.deepEqual(toMoveInput({ id: 'gid://shopify/Product/1', newPosition: 5 }), {
    id: 'gid://shopify/Product/1',
    newPosition: '5',
  });

  assert.deepEqual(toMoveInput({ id: 'gid://shopify/Product/2', newPosition: 0 }), {
    id: 'gid://shopify/Product/2',
    newPosition: '0',
  });
});

test('toMoveInput rejects values the API would reject', () => {
  for (const bad of [-1, 1.5, NaN, Infinity, null, undefined, '3']) {
    assert.throws(
      () => toMoveInput({ id: 'gid://shopify/Product/1', newPosition: bad }),
      /Invalid newPosition/,
      `should reject ${String(bad)}`
    );
  }
});

test('the fake rejects raw planner output, proving the guard is live', () => {
  const shopify = new FakeShopify(makeProducts([{}, {}, {}]));
  const moves = planMoves(shopify.ids(), shopify.ids().slice().reverse());

  // Passing planner moves straight through (numbers) must fail the same way
  // the real API failed.
  assert.throws(() => shopify.reorder(moves), /must be encoded as a string/);
});
