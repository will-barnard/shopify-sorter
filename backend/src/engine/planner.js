/**
 * Turns a desired final ordering into the minimal-ish list of moves that
 * `collectionReorderProducts` needs.
 *
 * Shopify's semantics (from the Admin API docs):
 *   - Only send products that actually moved.
 *   - Moves are applied SEQUENTIALLY, in the order given.
 *   - `newPosition` is a zero-based index in the collection AT THE MOMENT
 *     that move is applied (i.e. after all preceding moves).
 *
 * Strategy: find the longest increasing subsequence of the current positions
 * of the target list. Those products are already in the right relative order
 * and never need to move. Every other product is moved exactly once, inserted
 * immediately after its predecessor in the target order (which is always
 * already settled by the time we get to it).
 *
 * This is what keeps "move one product to the bottom" a 1-move operation
 * instead of an N-move rewrite of the whole collection.
 */

/** Indices (into `values`) of a longest strictly-increasing subsequence. */
export function longestIncreasingSubsequence(values) {
  if (values.length === 0) return [];

  // tails[k] = index into `values` of the smallest tail of an increasing
  // subsequence of length k+1. prev[] reconstructs the chain.
  const tails = [];
  const prev = new Array(values.length).fill(-1);

  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (values[tails[mid]] < v) lo = mid + 1;
      else hi = mid;
    }
    prev[i] = lo > 0 ? tails[lo - 1] : -1;
    tails[lo] = i;
  }

  const result = [];
  let k = tails[tails.length - 1];
  while (k !== -1) {
    result.push(k);
    k = prev[k];
  }
  return result.reverse();
}

/**
 * @param {string[]} currentIds Product GIDs in their present collection order.
 * @param {string[]} targetIds  Product GIDs in the desired order. Must be a
 *                              permutation of currentIds.
 * @returns {{id: string, newPosition: number}[]}
 */
export function planMoves(currentIds, targetIds) {
  const n = currentIds.length;
  if (n === 0 || targetIds.length === 0) return [];

  const currentIndex = new Map();
  for (let i = 0; i < n; i++) currentIndex.set(currentIds[i], i);

  // Ignore anything in the target that isn't actually in the collection.
  const target = targetIds.filter((id) => currentIndex.has(id));
  if (target.length !== n) {
    throw new Error(
      `planMoves: target order has ${target.length} known products but the collection has ${n}`
    );
  }

  const positions = target.map((id) => currentIndex.get(id));

  // Products that keep their relative order for free.
  const keepTargetIdx = new Set(longestIncreasingSubsequence(positions));

  const work = currentIds.slice();
  const moves = [];

  for (let t = 0; t < target.length; t++) {
    if (keepTargetIdx.has(t)) continue;

    const id = target[t];
    const from = work.indexOf(id);
    work.splice(from, 1);

    // Insert directly after whichever product precedes it in the target order.
    // That product is always settled already: it is either an LIS keeper or a
    // mover with a lower target index, which we processed earlier.
    let insertAt = 0;
    if (t > 0) {
      const predecessor = target[t - 1];
      insertAt = work.indexOf(predecessor) + 1;
    }

    work.splice(insertAt, 0, id);
    moves.push({ id, newPosition: insertAt });
  }

  return moves;
}

/** Replays a move list the way Shopify does, for tests and dry runs. */
export function applyMoves(currentIds, moves) {
  const work = currentIds.slice();
  for (const { id, newPosition } of moves) {
    const from = work.indexOf(id);
    if (from === -1) continue;
    work.splice(from, 1);
    const to = Math.min(Math.max(newPosition, 0), work.length);
    work.splice(to, 0, id);
  }
  return work;
}

export function ordersEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
