import { query } from '../db.js';
import { clientForShop } from '../shopify/shops.js';
import { ShopifyError } from '../shopify/client.js';
import {
  COLLECTION_PRODUCTS,
  COLLECTION_PRODUCTS_BY_SORT_KEY,
  REORDER_PRODUCTS,
  JOB_STATUS,
  SET_SORT_ORDER,
} from '../shopify/queries.js';
import { planMoves, applyMoves, ordersEqual } from './planner.js';
import { evaluate, describeStrategy, REMOTE_BASES } from './rules.js';

// Shopify accepts large move lists, but keeping batches bounded means a
// throttle or timeout costs us one batch instead of the whole collection.
const MOVES_PER_BATCH = 200;
const MAX_PRODUCTS = 10_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * MoveInput.newPosition is an UnsignedInt64, which the GraphQL Admin API
 * requires to be JSON-encoded as a *string*. Sending a JSON number is rejected
 * with "UnsignedInt64 '5' must be encoded as a string". The planner works in
 * real numbers; this is the only place that converts, right at the wire.
 */
export function toMoveInput({ id, newPosition }) {
  if (!Number.isInteger(newPosition) || newPosition < 0) {
    throw new Error(`Invalid newPosition ${newPosition} for ${id}`);
  }
  return { id, newPosition: String(newPosition) };
}

export async function fetchCollectionProducts(client, collectionId) {
  const products = [];
  let cursor = null;
  let sortOrder = null;
  let title = '';

  for (;;) {
    const data = await client.request(COLLECTION_PRODUCTS, { id: collectionId, cursor });
    const collection = data?.collection;
    if (!collection) throw new ShopifyError('Collection not found. It may have been deleted.');

    sortOrder = collection.sortOrder;
    title = collection.title;
    products.push(...(collection.products?.nodes || []));

    const pageInfo = collection.products?.pageInfo;
    if (!pageInfo?.hasNextPage) break;
    cursor = pageInfo.endCursor;

    if (products.length >= MAX_PRODUCTS) {
      throw new ShopifyError(
        `Collection has more than ${MAX_PRODUCTS} products, which this app does not sort.`
      );
    }
  }

  return { products, sortOrder, title };
}

async function fetchRemoteOrder(client, collectionId, base) {
  const spec = REMOTE_BASES[base];
  if (!spec) return null;

  const ids = [];
  let cursor = null;
  for (;;) {
    const data = await client.request(COLLECTION_PRODUCTS_BY_SORT_KEY, {
      id: collectionId,
      cursor,
      sortKey: spec.sortKey,
      reverse: spec.reverse,
    });
    const page = data?.collection?.products;
    if (!page) break;
    ids.push(...page.nodes.map((n) => n.id));
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
    if (ids.length >= MAX_PRODUCTS) break;
  }
  return ids;
}

async function waitForJob(client, jobId, { timeoutMs = 60_000 } = {}) {
  if (!jobId) return true;
  const deadline = Date.now() + timeoutMs;
  let delay = 400;
  while (Date.now() < deadline) {
    const data = await client.request(JOB_STATUS, { id: jobId });
    if (data?.job?.done) return true;
    await sleep(delay);
    delay = Math.min(delay * 1.5, 3000);
  }
  return false;
}

/**
 * Executes one rule.
 * @param {object} opts
 * @param {object} opts.shop    row from `shops`
 * @param {object} opts.rule    row from `rules`
 * @param {'schedule'|'manual'} opts.trigger
 * @param {boolean} opts.dryRun when true, computes the plan but changes nothing
 */
export async function runRule({ shop, rule, trigger = 'manual', dryRun = false }) {
  const client = clientForShop(shop);
  const startedAt = new Date();

  let runId = null;
  if (!dryRun) {
    const { rows } = await query(
      `INSERT INTO runs (rule_id, shop_id, trigger, status, started_at)
       VALUES ($1, $2, $3, 'running', $4) RETURNING id`,
      [rule.id, shop.id, trigger, startedAt]
    );
    runId = rows[0].id;
  }

  const finish = async (status, message, extra = {}) => {
    if (!dryRun && runId) {
      await query(
        `UPDATE runs SET status=$2, finished_at=now(), message=$3,
                         products_count=$4, moves_count=$5, details=$6
           WHERE id=$1`,
        [
          runId,
          status,
          message ? String(message).slice(0, 2000) : null,
          extra.productsCount || 0,
          extra.movesCount || 0,
          JSON.stringify(extra.details || {}),
        ]
      );
      await query(`UPDATE rules SET last_run_at=now(), last_status=$2 WHERE id=$1`, [rule.id, status]);
    }
    return {
      runId,
      status,
      message,
      productsCount: extra.productsCount || 0,
      movesCount: extra.movesCount || 0,
      ...extra,
    };
  };

  try {
    const strategy = rule.strategy || { base: 'current', groups: [] };
    const { products, sortOrder, title } = await fetchCollectionProducts(client, rule.collection_id);

    if (products.length === 0) {
      return finish('skipped', 'Collection is empty.', { details: { collectionTitle: title } });
    }

    // Reordering is only meaningful on a MANUAL collection; Shopify rejects the
    // mutation otherwise.
    if (sortOrder !== 'MANUAL') {
      if (!rule.force_manual_sort) {
        return finish(
          'skipped',
          `Collection sort order is ${sortOrder}, not MANUAL. Enable "set collection to manual sorting" on this rule, or change it in Shopify.`,
          { details: { sortOrder } }
        );
      }
      if (!dryRun) {
        await client.mutate(
          SET_SORT_ORDER,
          { input: { id: rule.collection_id, sortOrder: 'MANUAL' } },
          'collectionUpdate'
        );
      }
    }

    const remoteOrder = await fetchRemoteOrder(client, rule.collection_id, strategy.base);
    const { order: targetProducts, matchCounts } = evaluate(products, strategy, remoteOrder);

    const currentIds = products.map((p) => p.id);
    const targetIds = targetProducts.map((p) => p.id);

    if (ordersEqual(currentIds, targetIds)) {
      return finish('no_change', 'Collection was already in the desired order.', {
        productsCount: products.length,
        movesCount: 0,
        details: { collectionTitle: title, matchCounts, strategy: describeStrategy(strategy) },
      });
    }

    const allMoves = planMoves(currentIds, targetIds);

    // Sanity check the plan locally before sending it. If the replay doesn't
    // land on the target we abort rather than scramble a live collection.
    const replayed = applyMoves(currentIds, allMoves);
    if (!ordersEqual(replayed, targetIds)) {
      throw new Error('Internal error: computed move plan did not reproduce the target order.');
    }

    const preview = targetProducts.slice(0, 10).map((p) => ({ id: p.id, title: p.title }));

    if (dryRun) {
      return {
        status: 'dry_run',
        message: `${allMoves.length} product${allMoves.length === 1 ? '' : 's'} would move.`,
        productsCount: products.length,
        movesCount: allMoves.length,
        details: { collectionTitle: title, matchCounts, preview },
        preview,
      };
    }

    // Batches are re-planned against freshly fetched state so a concurrent edit
    // in the Shopify admin can't make later batches apply at stale positions.
    let applied = 0;
    let workingIds = currentIds;
    let batches = 0;

    while (applied < allMoves.length) {
      const remaining = planMoves(workingIds, targetIds);
      if (remaining.length === 0) break;

      const batch = remaining.slice(0, MOVES_PER_BATCH);
      const payload = await client.mutate(
        REORDER_PRODUCTS,
        { id: rule.collection_id, moves: batch.map(toMoveInput) },
        'collectionReorderProducts'
      );

      const done = await waitForJob(client, payload?.job?.id);
      if (!done) {
        throw new ShopifyError('Shopify did not finish the reorder job within 60 seconds.');
      }

      applied += batch.length;
      batches += 1;

      if (applied < allMoves.length) {
        const refreshed = await fetchCollectionProducts(client, rule.collection_id);
        workingIds = refreshed.products.map((p) => p.id);
      } else {
        workingIds = applyMoves(workingIds, batch);
      }

      if (batches > 60) throw new Error('Too many reorder batches; aborting to avoid a loop.');
    }

    return finish('success', `Moved ${applied} product${applied === 1 ? '' : 's'}.`, {
      productsCount: products.length,
      movesCount: applied,
      details: { collectionTitle: title, matchCounts, batches, preview },
    });
  } catch (err) {
    console.error(`[runner] rule ${rule.id} failed:`, err);
    if (dryRun) throw err;
    return finish('error', err.message || 'Unknown error');
  }
}
