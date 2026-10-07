/**
 * Lead-time notice — the half that talks to Shopify and Postgres.
 *
 * Two entry points keep descriptions correct:
 *   - handleInventoryEvent: one inventory_levels/update webhook -> one product.
 *   - sweepShop: every product carrying the tag; nightly, at boot, and on demand.
 * The sweep exists because webhooks can be missed (downtime, a deploy) and
 * because the webhook only says "a level changed", not what the product now
 * looks like; both paths read live state and converge on the same answer.
 *
 * All Shopify work for a shop goes through enqueueForShop so a burst of events
 * can never interleave read-modify-write cycles on the same description.
 */
import { query } from '../db.js';
import { clientForShop } from '../shopify/shops.js';
import {
  LEAD_TIME_PRODUCT_BY_ITEM,
  LEAD_TIME_PRODUCT_BY_ITEM_LEGACY,
  LEAD_TIME_PRODUCT_STATE,
  LEAD_TIME_PRODUCTS_BY_TAG,
  LEAD_TIME_SET_DESCRIPTION,
} from '../shopify/queries.js';
import {
  DEFAULT_NOTICE,
  DEFAULT_TAG,
  RESTORATION_TAG,
  applyNotice,
  comparable,
  decideNotice,
} from './leadTime.js';

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  tag: DEFAULT_TAG,
  noticeText: DEFAULT_NOTICE,
  sweepAt: '04:00',
  legacyNotices: [],
});

const MAX_SWEEP_PAGES = 20; // 2,000 tagged products is far beyond a special-order shelf.
const MAX_LEGACY = 10;

// ---- settings --------------------------------------------------------------

const rowToSettings = (row) =>
  row
    ? {
        enabled: row.enabled,
        tag: row.tag,
        noticeText: row.notice_text,
        sweepAt: row.sweep_at,
        legacyNotices: Array.isArray(row.legacy_notices) ? row.legacy_notices : [],
      }
    : { ...DEFAULT_SETTINGS, legacyNotices: [] };

export async function getSettings(shopId) {
  const { rows } = await query(`SELECT * FROM lead_time_settings WHERE shop_id = $1`, [shopId]);
  return rowToSettings(rows[0]);
}

export async function saveSettings(shopId, s) {
  const { rows } = await query(
    `INSERT INTO lead_time_settings (shop_id, enabled, tag, notice_text, sweep_at, legacy_notices, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,now())
     ON CONFLICT (shop_id) DO UPDATE SET
       enabled = EXCLUDED.enabled, tag = EXCLUDED.tag, notice_text = EXCLUDED.notice_text,
       sweep_at = EXCLUDED.sweep_at, legacy_notices = EXCLUDED.legacy_notices, updated_at = now()
     RETURNING *`,
    [shopId, s.enabled, s.tag, s.noticeText, s.sweepAt, JSON.stringify(s.legacyNotices)]
  );
  return rowToSettings(rows[0]);
}

const bad = (message) => Object.assign(new Error(message), { status: 400 });

/**
 * Validates a settings body against the current settings. Absent keys keep
 * their current value. When the notice text changes, the old wording is kept in
 * legacyNotices so existing descriptions get it replaced, not duplicated.
 */
export function parseSettings(body, current = DEFAULT_SETTINGS) {
  const b = body && typeof body === 'object' ? body : {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);

  let enabled = current.enabled;
  if (has('enabled')) {
    if (typeof b.enabled !== 'boolean') throw bad('`enabled` must be true or false.');
    enabled = b.enabled;
  }

  let tag = current.tag;
  if (has('tag')) {
    tag = String(b.tag ?? '').trim();
    if (!tag) throw bad('Enter the product tag that marks special-order items.');
    if (tag.length > 255 || /[,"'\\]/.test(tag)) {
      throw bad('The tag can\'t contain commas, quotes or backslashes.');
    }
    if (tag.toLowerCase() === RESTORATION_TAG) {
      throw bad(`"${RESTORATION_TAG}" is reserved: those listings keep their own disclaimer first.`);
    }
  }

  let noticeText = current.noticeText;
  if (has('noticeText')) {
    noticeText = String(b.noticeText ?? '').trim().replace(/\s+/g, ' ');
    if (!noticeText) throw bad('The notice text can\'t be empty.');
    if (noticeText.length > 300) throw bad('Keep the notice under 300 characters.');
    if (/[<>]/.test(noticeText)) throw bad('Use plain text in the notice; the app adds the formatting.');
  }

  let sweepAt = current.sweepAt;
  if (has('sweepAt')) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(b.sweepAt ?? '').trim());
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw bad('Sweep time must look like 04:00.');
    sweepAt = `${m[1].padStart(2, '0')}:${m[2]}`;
  }

  let legacyNotices = [...(current.legacyNotices || [])];
  if (comparable(noticeText) !== comparable(current.noticeText)) {
    legacyNotices.unshift(current.noticeText);
  }
  const seen = new Set([comparable(noticeText)]);
  legacyNotices = legacyNotices
    .filter((t) => {
      const key = comparable(t);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_LEGACY);

  return { enabled, tag, noticeText, sweepAt, legacyNotices };
}

// ---- event log -------------------------------------------------------------

export async function logEvent({ shopId, productId, productTitle, trigger, action, message }) {
  await query(
    `INSERT INTO lead_time_events (shop_id, product_id, product_title, trigger, action, message)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [shopId, productId, productTitle || '', trigger, action, message || null]
  );
}

export async function recentEvents(shopId, limit = 50) {
  const { rows } = await query(
    `SELECT * FROM lead_time_events WHERE shop_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
    [shopId, limit]
  );
  return rows.map((r) => ({
    id: String(r.id),
    productId: r.product_id,
    productTitle: r.product_title,
    trigger: r.trigger,
    action: r.action,
    message: r.message,
    createdAt: r.created_at,
  }));
}

// ---- per-shop serialisation ------------------------------------------------

const chains = new Map();

/** Runs tasks for one shop strictly one after another; a failure never blocks the next. */
export function enqueueForShop(domain, task) {
  const prev = chains.get(domain) || Promise.resolve();
  const next = prev.catch(() => {}).then(task);
  chains.set(domain, next);
  const cleanup = () => {
    if (chains.get(domain) === next) chains.delete(domain);
  };
  next.then(cleanup, cleanup);
  return next;
}

// ---- core ------------------------------------------------------------------

const isUndefinedField = (err) =>
  err?.body?.errors?.some((e) => e.extensions?.code === 'undefinedField') ||
  /doesn't exist on type|Cannot query field/i.test(err?.message || '');

/** One call: inventory item -> its product (with variants and description). */
export async function fetchProductByInventoryItem(client, inventoryItemId) {
  const id = `gid://shopify/InventoryItem/${inventoryItemId}`;
  try {
    const data = await client.request(LEAD_TIME_PRODUCT_BY_ITEM, { id });
    return data?.inventoryItem?.variants?.nodes?.[0]?.product || null;
  } catch (err) {
    if (!isUndefinedField(err)) throw err;
    const data = await client.request(LEAD_TIME_PRODUCT_BY_ITEM_LEGACY, { id });
    return data?.inventoryItem?.variant?.product || null;
  }
}

/**
 * Decides and (unless dryRun) writes the notice for one already-fetched product.
 * Outcomes: skipped | unchanged | would-change | changed. Never throws on a
 * "not for me" product; write failures propagate to the caller.
 */
export async function reconcileProduct({ client, product, settings, dryRun = false }) {
  if (!product) return { outcome: 'skipped', reason: 'Product not found.' };

  const base = { productId: product.id, title: product.title };
  const tags = (product.tags || []).map((t) => String(t).toLowerCase());

  if (!tags.includes(settings.tag.toLowerCase())) {
    return { ...base, outcome: 'skipped', reason: `Not tagged "${settings.tag}".` };
  }
  if (tags.includes(RESTORATION_TAG)) {
    return { ...base, outcome: 'skipped', reason: 'Restoration listing: its disclaimer must stay first.' };
  }
  if (product.variants?.pageInfo?.hasNextPage) {
    return { ...base, outcome: 'skipped', reason: 'More than 100 variants; stock can\'t be judged from one page.' };
  }

  const decision = decideNotice(product.variants?.nodes || []);
  const result = applyNotice(product.descriptionHtml, settings.noticeText, decision.show, settings.legacyNotices);
  const detail = { ...base, show: decision.show, reason: decision.reason };

  if (!result.changed) return { ...detail, outcome: 'unchanged' };
  if (dryRun) return { ...detail, outcome: 'would-change', action: result.action };

  await client.mutate(
    LEAD_TIME_SET_DESCRIPTION,
    { product: { id: product.id, descriptionHtml: result.html } },
    'productUpdate'
  );
  return { ...detail, outcome: 'changed', action: result.action };
}

const defaultDeps = () => ({ getSettings, record: logEvent, clientFor: clientForShop });

async function recordOutcome(deps, shop, trigger, res) {
  if (res.outcome !== 'changed' && res.outcome !== 'error') return;
  try {
    await deps.record({
      shopId: shop.id,
      productId: res.productId || 'unknown',
      productTitle: res.title,
      trigger,
      action: res.outcome === 'error' ? 'error' : res.action,
      message: res.outcome === 'error' ? res.message : res.reason,
    });
  } catch (err) {
    console.warn('[lead-time] could not record event:', err.message);
  }
}

/** Handles one inventory_levels/update payload. Never throws. */
export async function handleInventoryEvent(shop, payload, trigger = 'webhook', deps = defaultDeps()) {
  const itemId = String(payload?.inventory_item_id ?? '');
  if (!/^\d+$/.test(itemId)) return { outcome: 'skipped', reason: 'Payload had no inventory_item_id.' };

  let res;
  try {
    const settings = await deps.getSettings(shop.id);
    if (!settings.enabled) return { outcome: 'skipped', reason: 'Lead-time notice is disabled.' };
    const client = deps.clientFor(shop);
    const product = await fetchProductByInventoryItem(client, itemId);
    res = await reconcileProduct({ client, product, settings });
  } catch (err) {
    console.error(`[lead-time] ${shop.domain}: event for item ${itemId} failed:`, err.message);
    res = { outcome: 'error', message: err.message, productId: `inventoryItem:${itemId}` };
  }
  await recordOutcome(deps, shop, trigger, res);
  return res;
}

async function listTaggedProductIds(client, tag) {
  const ids = [];
  let cursor = null;
  for (let page = 0; page < MAX_SWEEP_PAGES; page++) {
    const data = await client.request(LEAD_TIME_PRODUCTS_BY_TAG, { cursor, query: `tag:"${tag}"` });
    const conn = data?.products;
    if (!conn) break;
    ids.push(...conn.nodes.map((n) => n.id));
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return ids;
}

/**
 * Reconciles every product with the tag. dryRun reports what would change and
 * writes nothing (and logs nothing), so Preview is safe while disabled.
 */
export async function sweepShop({ shop, settings, dryRun = false, trigger = 'sweep', deps = defaultDeps() }) {
  const client = deps.clientFor(shop);
  const ids = await listTaggedProductIds(client, settings.tag);

  const summary = { checked: ids.length, changed: 0, unchanged: 0, skipped: 0, errors: 0, items: [] };
  for (const id of ids) {
    let res;
    try {
      const data = await client.request(LEAD_TIME_PRODUCT_STATE, { id });
      res = await reconcileProduct({ client, product: data?.product, settings, dryRun });
      if (!res.productId) res.productId = id;
    } catch (err) {
      res = { outcome: 'error', message: err.message, productId: id };
    }

    if (res.outcome === 'changed' || res.outcome === 'would-change') summary.changed += 1;
    else if (res.outcome === 'unchanged') summary.unchanged += 1;
    else if (res.outcome === 'skipped') summary.skipped += 1;
    else summary.errors += 1;

    if (!dryRun) await recordOutcome(deps, shop, trigger, res);
    summary.items.push({
      id: res.productId,
      title: res.title || '',
      outcome: res.outcome,
      action: res.action || null,
      reason: res.reason || res.message || null,
    });
  }
  return summary;
}

/** Boot/nightly entry: sweep every enabled, installed shop, one shop at a time. */
export async function sweepAllEnabledShops(trigger = 'sweep') {
  const { rows } = await query(
    `SELECT s.id, s.domain, s.access_token
       FROM shops s JOIN lead_time_settings l ON l.shop_id = s.id
      WHERE l.enabled = TRUE AND s.uninstalled_at IS NULL`
  );
  for (const shop of rows) {
    await enqueueForShop(shop.domain, async () => {
      try {
        const settings = await getSettings(shop.id);
        if (!settings.enabled) return;
        const s = await sweepShop({ shop, settings, trigger });
        console.log(`[lead-time] ${shop.domain} ${trigger}: ${s.checked} checked, ${s.changed} changed, ${s.errors} errors`);
      } catch (err) {
        console.error(`[lead-time] ${shop.domain} ${trigger} failed:`, err.message);
      }
    }).catch(() => {});
  }
}

/** Webhook entry: look the shop up, then queue the event behind that shop's other work. */
export async function onInventoryWebhook(shopDomain, payload) {
  const { rows } = await query(
    `SELECT s.id, s.domain, s.access_token FROM shops s
      JOIN lead_time_settings l ON l.shop_id = s.id
     WHERE s.domain = $1 AND s.uninstalled_at IS NULL AND l.enabled = TRUE`,
    [shopDomain]
  );
  // The common case — most shops/events — ends here with no Shopify call.
  if (!rows[0]) return;
  await enqueueForShop(shopDomain, () => handleInventoryEvent(rows[0], payload, 'webhook'));
}
