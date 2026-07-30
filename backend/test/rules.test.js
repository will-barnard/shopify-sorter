import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluate,
  validateStrategy,
  describeStrategy,
  applyBaseOrder,
  productMatchesGroup,
} from '../src/engine/rules.js';
import { planMoves, applyMoves } from '../src/engine/planner.js';

const product = (id, overrides = {}) => ({
  id: `gid://shopify/Product/${id}`,
  title: `Product ${id}`,
  tags: [],
  status: 'ACTIVE',
  totalInventory: 10,
  createdAt: '2024-01-01T00:00:00Z',
  priceRangeV2: { minVariantPrice: { amount: '10.00', currencyCode: 'USD' } },
  ...overrides,
});

const idsOf = (list) => list.map((p) => p.id);

test('primary use case: tagged products move to the top, others keep order', () => {
  const products = [
    product(1),
    product(2, { tags: ['New', 'sale'] }),
    product(3),
    product(4, { tags: ['new'] }),
    product(5),
  ];

  const strategy = {
    base: 'current',
    groups: [{ type: 'tag', tags: ['new'], match: 'any', position: 'top' }],
  };

  const { order, matchCounts } = evaluate(products, strategy);

  assert.equal(matchCounts[0], 2);
  assert.deepEqual(idsOf(order), idsOf([products[1], products[3], products[0], products[2], products[4]]));

  // And it costs exactly two moves on the wire.
  const moves = planMoves(idsOf(products), idsOf(order));
  assert.equal(moves.length, 2);
  assert.deepEqual(applyMoves(idsOf(products), moves), idsOf(order));
});

test('tag matching is case-insensitive and trims whitespace', () => {
  const p = product(1, { tags: ['Best Seller'] });
  assert.ok(productMatchesGroup(p, { type: 'tag', tags: ['  best seller '], match: 'any' }));
});

test('match: all requires every tag', () => {
  const p = product(1, { tags: ['new'] });
  assert.ok(!productMatchesGroup(p, { type: 'tag', tags: ['new', 'sale'], match: 'all' }));
  assert.ok(productMatchesGroup(p, { type: 'tag', tags: ['new', 'sale'], match: 'any' }));
});

test('out-of-stock detection covers zero and negative inventory', () => {
  assert.ok(productMatchesGroup(product(1, { totalInventory: 0 }), { type: 'out_of_stock' }));
  assert.ok(productMatchesGroup(product(2, { totalInventory: -3 }), { type: 'out_of_stock' }));
  assert.ok(!productMatchesGroup(product(3, { totalInventory: 1 }), { type: 'out_of_stock' }));
});

test('first matching group wins, and earlier groups outrank later ones', () => {
  const products = [
    product(1, { tags: ['clearance'] }),
    product(2, { tags: ['featured'] }),
    product(3),
    // Matches BOTH groups; group 1 is listed first so it goes to the top.
    product(4, { tags: ['featured', 'clearance'] }),
  ];

  const strategy = {
    base: 'current',
    groups: [
      { type: 'tag', tags: ['featured'], match: 'any', position: 'top' },
      { type: 'tag', tags: ['clearance'], match: 'any', position: 'bottom' },
    ],
  };

  const { order } = evaluate(products, strategy);
  assert.deepEqual(idsOf(order), idsOf([products[1], products[3], products[2], products[0]]));
});

test('combined rule: featured to top, out-of-stock to bottom', () => {
  const products = [
    product(1),
    product(2, { totalInventory: 0 }),
    product(3, { tags: ['featured'] }),
    product(4, { tags: ['featured'], totalInventory: 0 }),
    product(5),
  ];

  const strategy = {
    base: 'current',
    groups: [
      { type: 'tag', tags: ['featured'], match: 'any', position: 'top' },
      { type: 'out_of_stock', position: 'bottom' },
    ],
  };

  const { order } = evaluate(products, strategy);
  // Product 4 is featured AND sold out; featured is listed first, so it wins.
  assert.deepEqual(
    idsOf(order),
    idsOf([products[2], products[3], products[0], products[4], products[1]])
  );
});

test('base sorts are stable and correct', () => {
  const products = [
    product(1, { createdAt: '2024-03-01T00:00:00Z', priceRangeV2: { minVariantPrice: { amount: '30' } } }),
    product(2, { createdAt: '2024-01-01T00:00:00Z', priceRangeV2: { minVariantPrice: { amount: '10' } } }),
    product(3, { createdAt: '2024-02-01T00:00:00Z', priceRangeV2: { minVariantPrice: { amount: '20' } } }),
  ];

  assert.deepEqual(idsOf(applyBaseOrder(products, 'newest')), idsOf([products[0], products[2], products[1]]));
  assert.deepEqual(idsOf(applyBaseOrder(products, 'oldest')), idsOf([products[1], products[2], products[0]]));
  assert.deepEqual(idsOf(applyBaseOrder(products, 'price_asc')), idsOf([products[1], products[2], products[0]]));
  assert.deepEqual(idsOf(applyBaseOrder(products, 'price_desc')), idsOf([products[0], products[2], products[1]]));
  assert.deepEqual(idsOf(applyBaseOrder(products, 'current')), idsOf(products));
});

test('best_selling uses the order Shopify returns and appends unranked products', () => {
  const products = [product(1), product(2), product(3)];
  const remote = [products[2].id, products[0].id]; // product 2 not ranked
  const ordered = applyBaseOrder(products, 'best_selling', remote);
  assert.deepEqual(idsOf(ordered), [products[2].id, products[0].id, products[1].id]);
});

test('best_selling falls back to current order when Shopify returns nothing', () => {
  const products = [product(1), product(2)];
  assert.deepEqual(idsOf(applyBaseOrder(products, 'best_selling', [])), idsOf(products));
});

test('base sort plus a tag group composes correctly', () => {
  const products = [
    product(1, { createdAt: '2024-01-01T00:00:00Z' }),
    product(2, { createdAt: '2024-03-01T00:00:00Z', tags: ['pinned'] }),
    product(3, { createdAt: '2024-02-01T00:00:00Z' }),
  ];
  const strategy = {
    base: 'oldest',
    groups: [{ type: 'tag', tags: ['pinned'], match: 'any', position: 'top' }],
  };
  const { order } = evaluate(products, strategy);
  assert.deepEqual(idsOf(order), idsOf([products[1], products[0], products[2]]));
});

test('evaluate always returns a permutation of the input', () => {
  const products = Array.from({ length: 60 }, (_, i) =>
    product(i, {
      tags: i % 7 === 0 ? ['new'] : i % 5 === 0 ? ['clearance'] : [],
      totalInventory: i % 11 === 0 ? 0 : 5,
    })
  );
  const strategy = {
    base: 'title_asc',
    groups: [
      { type: 'tag', tags: ['new'], match: 'any', position: 'top' },
      { type: 'out_of_stock', position: 'bottom' },
      { type: 'tag', tags: ['clearance'], match: 'any', position: 'bottom' },
    ],
  };
  const { order } = evaluate(products, strategy);
  assert.equal(order.length, products.length);
  assert.deepEqual(new Set(idsOf(order)), new Set(idsOf(products)));

  // The full pipeline must round-trip.
  const moves = planMoves(idsOf(products), idsOf(order));
  assert.deepEqual(applyMoves(idsOf(products), moves), idsOf(order));
});

test('validateStrategy rejects malformed input', () => {
  assert.throws(() => validateStrategy(null), /must be an object/);
  assert.throws(() => validateStrategy({ base: 'nonsense', groups: [] }), /Unknown base order/);
  assert.throws(() => validateStrategy({ base: 'current', groups: [] }), /would not change anything/);
  assert.throws(
    () => validateStrategy({ base: 'current', groups: [{ type: 'nope', position: 'top' }] }),
    /unknown type/
  );
  assert.throws(
    () => validateStrategy({ base: 'current', groups: [{ type: 'tag', tags: ['a'], position: 'middle' }] }),
    /must be "top" or "bottom"/
  );
  assert.throws(
    () => validateStrategy({ base: 'current', groups: [{ type: 'tag', tags: [], position: 'top' }] }),
    /at least one tag/
  );
});

test('validateStrategy normalises and strips unknown keys', () => {
  const clean = validateStrategy({
    base: 'newest',
    groups: [{ type: 'tag', tags: [' New ', '', 'sale'], match: 'weird', position: 'top', evil: 1 }],
  });
  assert.deepEqual(clean, {
    base: 'newest',
    groups: [{ type: 'tag', position: 'top', tags: ['New', 'sale'], match: 'any' }],
  });
});

test('a base-only strategy with no groups is allowed', () => {
  assert.doesNotThrow(() => validateStrategy({ base: 'best_selling', groups: [] }));
});

test('describeStrategy reads like a sentence', () => {
  const text = describeStrategy({
    base: 'current',
    groups: [{ type: 'tag', tags: ['new'], match: 'any', position: 'top' }],
  });
  assert.equal(text, 'Keep current order, then move products tagged "new" to the top');
});
