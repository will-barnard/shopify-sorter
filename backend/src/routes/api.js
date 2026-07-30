import express from 'express';
import { DateTime } from 'luxon';
import { query } from '../db.js';
import { verifySessionToken } from '../shopify/verify.js';
import { getShop, clientForShop } from '../shopify/shops.js';
import { LIST_COLLECTIONS, COLLECTION_HEADER, PRODUCT_TAGS } from '../shopify/queries.js';
import { fetchCollectionProducts, runRule } from '../engine/runner.js';
import { validateStrategy, describeStrategy, evaluate, BASE_ORDERS } from '../engine/rules.js';
import { isValidZone, normalizeTime } from '../scheduler.js';

export const apiRouter = express.Router();
apiRouter.use(express.json({ limit: '256kb' }));

/** Every /api route requires a valid App Bridge session token. */
apiRouter.use(async (req, res, next) => {
  const header = req.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;

  if (!token) {
    return res
      .status(401)
      .set('X-Shopify-API-Request-Failure-Unauthorized', 'true')
      .json({ error: 'Missing session token.' });
  }

  let shopDomain;
  try {
    ({ shop: shopDomain } = verifySessionToken(token));
  } catch (err) {
    return res
      .status(401)
      .set('X-Shopify-API-Request-Failure-Unauthorized', 'true')
      .json({ error: `Invalid session token: ${err.message}` });
  }

  const shop = await getShop(shopDomain);
  if (!shop) {
    // The frontend reads this header and bounces to the OAuth flow.
    return res
      .status(403)
      .set('X-Shopify-API-Request-Failure-Reauthorize', '1')
      .set('X-Shopify-API-Request-Failure-Reauthorize-Url', `/auth?shop=${shopDomain}`)
      .json({ error: 'App is not installed on this shop.', shop: shopDomain, reauthorize: true });
  }

  req.shop = shop;
  next();
});

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Rule ids are bigints. Reject anything else before it reaches Postgres, so a
// junk path segment is a clean 404 rather than a cast error.
apiRouter.param('id', (req, res, next, value) => {
  if (!/^\d{1,19}$/.test(value)) return res.status(404).json({ error: 'Rule not found.' });
  next();
});

const ruleToJson = (row) => ({
  id: String(row.id),
  name: row.name,
  collectionId: row.collection_id,
  collectionTitle: row.collection_title,
  enabled: row.enabled,
  runAt: row.run_at,
  timezone: row.timezone,
  strategy: row.strategy,
  forceManualSort: row.force_manual_sort,
  lastRunAt: row.last_run_at,
  lastStatus: row.last_status,
  summary: describeStrategy(row.strategy),
});

apiRouter.get(
  '/me',
  asyncRoute(async (req, res) => {
    res.json({
      shop: req.shop.domain,
      name: req.shop.name,
      timezone: req.shop.iana_timezone,
      baseOrders: BASE_ORDERS,
      serverTime: new Date().toISOString(),
    });
  })
);

apiRouter.get(
  '/collections',
  asyncRoute(async (req, res) => {
    const client = clientForShop(req.shop);
    const search = String(req.query.search || '').trim();
    const data = await client.request(LIST_COLLECTIONS, {
      cursor: req.query.cursor || null,
      query: search ? `title:*${search.replace(/[\\"*]/g, '')}*` : null,
    });
    const page = data?.collections;
    res.json({
      collections: (page?.nodes || []).map((c) => ({
        id: c.id,
        title: c.title,
        handle: c.handle,
        sortOrder: c.sortOrder,
        productsCount: c.productsCount?.count ?? 0,
      })),
      hasNextPage: !!page?.pageInfo?.hasNextPage,
      cursor: page?.pageInfo?.endCursor || null,
    });
  })
);

apiRouter.get(
  '/tags',
  asyncRoute(async (req, res) => {
    const client = clientForShop(req.shop);
    const tags = [];
    let cursor = null;
    // Cap at 4 pages (1000 tags) so a huge catalogue can't stall the picker.
    for (let page = 0; page < 4; page++) {
      const data = await client.request(PRODUCT_TAGS, { cursor });
      const conn = data?.productTags;
      if (!conn) break;
      tags.push(...conn.edges.map((e) => e.node));
      if (!conn.pageInfo.hasNextPage) break;
      cursor = conn.pageInfo.endCursor;
    }
    res.json({ tags });
  })
);

apiRouter.get(
  '/rules',
  asyncRoute(async (req, res) => {
    const { rows } = await query(
      `SELECT * FROM rules WHERE shop_id = $1 ORDER BY created_at DESC`,
      [req.shop.id]
    );
    res.json({ rules: rows.map(ruleToJson) });
  })
);

function parseRuleBody(body, shopTimezone) {
  const name = String(body?.name || '').trim().slice(0, 120) || 'Untitled rule';

  const collectionId = String(body?.collectionId || '').trim();
  if (!/^gid:\/\/shopify\/Collection\/\d+$/.test(collectionId)) {
    throw Object.assign(new Error('Pick a collection.'), { status: 400 });
  }

  const runAt = normalizeTime(body?.runAt || '03:00');

  const timezone = body?.timezone || shopTimezone || 'UTC';
  if (!isValidZone(timezone)) {
    throw Object.assign(new Error(`Unknown timezone "${timezone}".`), { status: 400 });
  }

  let strategy;
  try {
    strategy = validateStrategy(body?.strategy);
  } catch (err) {
    throw Object.assign(err, { status: 400 });
  }

  return {
    name,
    collectionId,
    collectionTitle: String(body?.collectionTitle || '').slice(0, 255),
    enabled: body?.enabled !== false,
    runAt,
    timezone,
    strategy,
    forceManualSort: body?.forceManualSort !== false,
  };
}

apiRouter.post(
  '/rules',
  asyncRoute(async (req, res) => {
    const r = parseRuleBody(req.body, req.shop.iana_timezone);

    const { rows: existing } = await query(`SELECT count(*)::int AS n FROM rules WHERE shop_id=$1`, [
      req.shop.id,
    ]);
    if (existing[0].n >= 100) {
      return res.status(400).json({ error: 'Rule limit reached (100 per shop).' });
    }

    const { rows } = await query(
      `INSERT INTO rules (shop_id, name, collection_id, collection_title, enabled, run_at, timezone, strategy, force_manual_sort)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        req.shop.id,
        r.name,
        r.collectionId,
        r.collectionTitle,
        r.enabled,
        r.runAt,
        r.timezone,
        JSON.stringify(r.strategy),
        r.forceManualSort,
      ]
    );
    res.status(201).json({ rule: ruleToJson(rows[0]) });
  })
);

apiRouter.put(
  '/rules/:id',
  asyncRoute(async (req, res) => {
    const r = parseRuleBody(req.body, req.shop.iana_timezone);
    const { rows } = await query(
      `UPDATE rules SET name=$3, collection_id=$4, collection_title=$5, enabled=$6,
                        run_at=$7, timezone=$8, strategy=$9, force_manual_sort=$10, updated_at=now()
        WHERE id=$1 AND shop_id=$2 RETURNING *`,
      [
        req.params.id,
        req.shop.id,
        r.name,
        r.collectionId,
        r.collectionTitle,
        r.enabled,
        r.runAt,
        r.timezone,
        JSON.stringify(r.strategy),
        r.forceManualSort,
      ]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Rule not found.' });
    res.json({ rule: ruleToJson(rows[0]) });
  })
);

apiRouter.patch(
  '/rules/:id/enabled',
  asyncRoute(async (req, res) => {
    const { rows } = await query(
      `UPDATE rules SET enabled=$3, updated_at=now() WHERE id=$1 AND shop_id=$2 RETURNING *`,
      [req.params.id, req.shop.id, req.body?.enabled !== false]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Rule not found.' });
    res.json({ rule: ruleToJson(rows[0]) });
  })
);

apiRouter.delete(
  '/rules/:id',
  asyncRoute(async (req, res) => {
    const { rowCount } = await query(`DELETE FROM rules WHERE id=$1 AND shop_id=$2`, [
      req.params.id,
      req.shop.id,
    ]);
    if (!rowCount) return res.status(404).json({ error: 'Rule not found.' });
    res.status(204).end();
  })
);

async function loadRule(shopId, ruleId) {
  const { rows } = await query(`SELECT * FROM rules WHERE id=$1 AND shop_id=$2`, [ruleId, shopId]);
  return rows[0] || null;
}

apiRouter.post(
  '/rules/:id/run',
  asyncRoute(async (req, res) => {
    const rule = await loadRule(req.shop.id, req.params.id);
    if (!rule) return res.status(404).json({ error: 'Rule not found.' });
    const result = await runRule({ shop: req.shop, rule, trigger: 'manual' });
    res.json({ result });
  })
);

/** Computes what a rule would do without touching the collection. */
apiRouter.post(
  '/preview',
  asyncRoute(async (req, res) => {
    const client = clientForShop(req.shop);
    const collectionId = String(req.body?.collectionId || '');
    if (!/^gid:\/\/shopify\/Collection\/\d+$/.test(collectionId)) {
      return res.status(400).json({ error: 'Pick a collection.' });
    }

    let strategy;
    try {
      strategy = validateStrategy(req.body?.strategy);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const { products, sortOrder, title } = await fetchCollectionProducts(client, collectionId);
    const { order, matchCounts } = evaluate(products, strategy, null);

    const currentIds = products.map((p) => p.id);
    const targetIds = order.map((p) => p.id);
    let movesCount = 0;
    for (let i = 0; i < currentIds.length; i++) if (currentIds[i] !== targetIds[i]) movesCount++;

    const shape = (p) => ({
      id: p.id,
      title: p.title,
      tags: p.tags,
      totalInventory: p.totalInventory,
      image: p.featuredMedia?.preview?.image?.url || null,
    });

    res.json({
      collectionTitle: title,
      sortOrder,
      productsCount: products.length,
      matchCounts,
      changed: movesCount,
      summary: describeStrategy(strategy),
      // best_selling needs a live Shopify sort; the preview approximates with
      // the current order for that base only.
      approximate: strategy.base === 'best_selling',
      before: products.slice(0, 20).map(shape),
      after: order.slice(0, 20).map(shape),
    });
  })
);

apiRouter.get(
  '/runs',
  asyncRoute(async (req, res) => {
    const ruleId = req.query.ruleId ? String(req.query.ruleId) : null;
    const { rows } = await query(
      `SELECT r.*, ru.name AS rule_name
         FROM runs r
         JOIN rules ru ON ru.id = r.rule_id
        WHERE r.shop_id = $1 AND ($2::bigint IS NULL OR r.rule_id = $2::bigint)
        ORDER BY r.started_at DESC
        LIMIT 100`,
      [req.shop.id, ruleId]
    );
    res.json({
      runs: rows.map((r) => ({
        id: String(r.id),
        ruleId: String(r.rule_id),
        ruleName: r.rule_name,
        trigger: r.trigger,
        status: r.status,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        productsCount: r.products_count,
        movesCount: r.moves_count,
        message: r.message,
        details: r.details,
      })),
    });
  })
);

apiRouter.get(
  '/timezones',
  asyncRoute(async (req, res) => {
    const zones =
      typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : ['UTC'];
    res.json({ timezones: zones, shopTimezone: req.shop.iana_timezone });
  })
);

apiRouter.use((err, req, res, _next) => {
  const status = err.status || (err.name === 'ShopifyError' ? 502 : 500);
  if (status >= 500) console.error('[api] error', err);
  res.status(status).json({ error: err.message || 'Unexpected server error.' });
});
