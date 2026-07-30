import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planMoves,
  applyMoves,
  ordersEqual,
  longestIncreasingSubsequence,
} from '../src/engine/planner.js';

const ids = (s) => s.split('');

test('LIS finds a longest strictly increasing subsequence', () => {
  const values = [2, 4, 0, 1, 3];
  const idx = longestIncreasingSubsequence(values);
  const picked = idx.map((i) => values[i]);
  assert.equal(picked.length, 3);
  for (let i = 1; i < picked.length; i++) assert.ok(picked[i] > picked[i - 1]);
});

test('no moves when already in target order', () => {
  const cur = ids('ABCDE');
  assert.deepEqual(planMoves(cur, ids('ABCDE')), []);
});

test('moving one product to the bottom costs exactly one move', () => {
  const cur = ids('ABCDE');
  const target = ids('BCDEA');
  const moves = planMoves(cur, target);
  assert.equal(moves.length, 1);
  assert.deepEqual(moves[0], { id: 'A', newPosition: 4 });
  assert.deepEqual(applyMoves(cur, moves), target);
});

test('primary use case: pull tagged products to the top', () => {
  // C and E are tagged; everything else keeps its relative order.
  const cur = ids('ABCDE');
  const target = ids('CEABD');
  const moves = planMoves(cur, target);
  assert.equal(moves.length, 2, 'only the tagged products should move');
  assert.deepEqual(applyMoves(cur, moves), target);
});

test('handles an interleaved reshuffle', () => {
  const cur = ids('ABCDE');
  const target = ids('BDACE');
  const moves = planMoves(cur, target);
  assert.deepEqual(applyMoves(cur, moves), target);
});

test('full reversal still produces a correct plan', () => {
  const cur = ids('ABCDEFGH');
  const target = ids('HGFEDCBA');
  const moves = planMoves(cur, target);
  assert.deepEqual(applyMoves(cur, moves), target);
});

test('throws when the target is not a permutation of the collection', () => {
  assert.throws(() => planMoves(ids('ABC'), ids('AB')), /target order/);
});

test('empty collection is a no-op', () => {
  assert.deepEqual(planMoves([], []), []);
});

test('fuzz: 2000 random permutations replay exactly, with minimal move counts', () => {
  // Deterministic PRNG so a failure is reproducible.
  let seed = 0x2f6e2b1;
  const rand = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) % 1_000_000) / 1_000_000;
  };

  for (let iter = 0; iter < 2000; iter++) {
    const n = 1 + Math.floor(rand() * 40);
    const cur = Array.from({ length: n }, (_, i) => `gid://shopify/Product/${i}`);

    const target = cur.slice();
    for (let i = target.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [target[i], target[j]] = [target[j], target[i]];
    }

    const moves = planMoves(cur, target);
    const replayed = applyMoves(cur, moves);

    assert.ok(
      ordersEqual(replayed, target),
      `iteration ${iter} (n=${n}) replayed to the wrong order`
    );

    // The LIS bound: anything outside a longest increasing subsequence must
    // move, so this is the theoretical minimum number of single-item moves.
    const currentIndex = new Map(cur.map((id, i) => [id, i]));
    const lisLength = longestIncreasingSubsequence(target.map((id) => currentIndex.get(id))).length;
    assert.equal(
      moves.length,
      n - lisLength,
      `iteration ${iter}: expected ${n - lisLength} moves, got ${moves.length}`
    );

    // Every position Shopify receives must be in range at the time it applies.
    for (const m of moves) {
      assert.ok(m.newPosition >= 0 && m.newPosition < n, `position out of range: ${m.newPosition}`);
    }
  }
});

test('fuzz: sparse "tag to top" shuffles stay cheap', () => {
  let seed = 991;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  for (let iter = 0; iter < 500; iter++) {
    const n = 50 + Math.floor(rand() * 200);
    const cur = Array.from({ length: n }, (_, i) => `p${i}`);

    const tagged = cur.filter(() => rand() < 0.05);
    const rest = cur.filter((id) => !tagged.includes(id));
    const target = [...tagged, ...rest];

    const moves = planMoves(cur, target);
    assert.deepEqual(applyMoves(cur, moves), target);
    assert.ok(
      moves.length <= tagged.length,
      `expected at most ${tagged.length} moves, got ${moves.length}`
    );
  }
});
