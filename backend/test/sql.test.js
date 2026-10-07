/**
 * Exercises the real SQL against an in-memory Postgres so schema and query
 * mistakes surface here rather than on first deploy.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Pull the DDL straight out of db.js so the test can never drift from the app.
const dbSource = readFileSync(fileURLToPath(new URL('../src/db.js', import.meta.url)), 'utf8');
const SCHEMA = dbSource.match(/const SCHEMA = `([\s\S]*?)`;/)[1];

// pg-mem's direct API has no parameter binding, so drive it through its pg
// adapter — the same client interface the app uses.
async function freshDb() {
  const mem = newDb();
  const { Client } = mem.adapters.createPg();
  const client = new Client();
  await client.connect();
  await client.query(SCHEMA);
  return {
    rows: async (sql, args) => (await client.query(sql, args)).rows,
    row: async (sql, args) => (await client.query(sql, args)).rows[0],
    count: async (sql, args) => (await client.query(sql, args)).rows.length,
  };
}

test('the schema creates cleanly', async () => {
  await freshDb();
});

test('shops upsert refreshes the token and clears an uninstall', async () => {
  const db = await freshDb();

  const upsert = (token, name) =>
    db.row(
      `INSERT INTO shops (domain, access_token, scope, name, iana_timezone, installed_at, uninstalled_at)
       VALUES ('demo.myshopify.com', $1, 'read_products', $2, COALESCE($3, 'UTC'), now(), NULL)
       ON CONFLICT (domain) DO UPDATE SET
         access_token   = EXCLUDED.access_token,
         scope          = EXCLUDED.scope,
         name           = COALESCE(EXCLUDED.name, shops.name),
         iana_timezone  = COALESCE(EXCLUDED.iana_timezone, shops.iana_timezone),
         uninstalled_at = NULL
       RETURNING *`,
      [token, name, 'America/New_York']
    );

  const first = await upsert('token-1', 'Demo Store');
  assert.equal(first.access_token, 'token-1');
  assert.equal(first.iana_timezone, 'America/New_York');

  await db.rows(`UPDATE shops SET uninstalled_at = now() WHERE domain = 'demo.myshopify.com'`);

  // Reinstalling must revive the row rather than create a duplicate.
  const second = await upsert('token-2', null);
  assert.equal(second.access_token, 'token-2');
  assert.equal(second.uninstalled_at, null);
  assert.equal(second.name, 'Demo Store', 'existing name should be preserved');
  assert.equal(await db.count('SELECT id FROM shops'), 1);
});

async function seed(db) {
  const shop = await db.row(
    `INSERT INTO shops (domain, access_token) VALUES ('demo.myshopify.com', 't') RETURNING *`
  );
  const rule = await db.row(
    `INSERT INTO rules (shop_id, name, collection_id, collection_title, run_at, timezone, strategy)
     VALUES ($1, 'New arrivals', 'gid://shopify/Collection/1', 'Home page', '03:00', 'America/New_York', $2)
     RETURNING *`,
    [
      shop.id,
      JSON.stringify({
        base: 'current',
        groups: [{ type: 'tag', tags: ['new'], match: 'any', position: 'top' }],
      }),
    ]
  );
  return { shop, rule };
}

test('a rule round-trips its jsonb strategy and column defaults', async () => {
  const db = await freshDb();
  const { rule } = await seed(db);

  const strategy = typeof rule.strategy === 'string' ? JSON.parse(rule.strategy) : rule.strategy;
  assert.equal(strategy.base, 'current');
  assert.equal(strategy.groups[0].tags[0], 'new');
  assert.equal(rule.enabled, true, 'rules default to enabled');
  assert.equal(rule.force_manual_sort, true, 'manual-sort fix-up defaults on');
  assert.equal(rule.run_at, '03:00');
});

/**
 * NOTE: the app decides "did I win this slot?" from `rowCount`. Real Postgres
 * reports 0 when ON CONFLICT DO NOTHING skips the insert; pg-mem incorrectly
 * reports 1 while still (correctly) not writing the row. So these assertions
 * check the resulting table state, which is the thing the primary key actually
 * guarantees, rather than pg-mem's unreliable rowCount.
 */
test('the scheduler claim is idempotent per (rule, minute)', async () => {
  const db = await freshDb();
  const { rule, shop } = await seed(db);

  const claim = (ruleId, slot) =>
    db.rows(
      `INSERT INTO scheduler_claims (rule_id, slot, claimed_at)
       VALUES ($1, $2, now())
       ON CONFLICT (rule_id, slot) DO NOTHING`,
      [ruleId, slot]
    );

  await claim(rule.id, '2026-07-30T03:00');
  await claim(rule.id, '2026-07-30T03:00');
  await claim(rule.id, '2026-07-30T03:00');

  assert.equal(
    await db.count(`SELECT * FROM scheduler_claims WHERE rule_id=$1`, [rule.id]),
    1,
    'repeated ticks in the same minute leave exactly one claim'
  );

  await claim(rule.id, '2026-07-31T03:00');
  assert.equal(
    await db.count(`SELECT * FROM scheduler_claims WHERE rule_id=$1`, [rule.id]),
    2,
    'the next day is a separate slot'
  );

  // A second rule claiming the same minute must not be blocked by the first.
  const other = await db.row(
    `INSERT INTO rules (shop_id, name, collection_id)
     VALUES ($1, 'Other', 'gid://shopify/Collection/9') RETURNING *`,
    [shop.id]
  );
  await claim(other.id, '2026-07-30T03:00');
  assert.equal(
    await db.count(`SELECT * FROM scheduler_claims WHERE rule_id=$1`, [other.id]),
    1,
    'claims are per-rule, not global'
  );
});

test('old scheduler claims are pruned', async () => {
  const db = await freshDb();
  const { rule } = await seed(db);

  await db.rows(
    `INSERT INTO scheduler_claims (rule_id, slot, claimed_at)
     VALUES ($1, 'old', now() - interval '30 days'), ($1, 'recent', now())`,
    [rule.id]
  );

  await db.rows(`DELETE FROM scheduler_claims WHERE claimed_at < now() - interval '7 days'`);

  const left = await db.rows(`SELECT slot FROM scheduler_claims WHERE rule_id=$1`, [rule.id]);
  assert.deepEqual(
    left.map((r) => r.slot),
    ['recent']
  );
});

test('the due-rules query skips paused rules and uninstalled shops', async () => {
  const db = await freshDb();
  const { shop } = await seed(db);

  await db.rows(
    `INSERT INTO rules (shop_id, name, collection_id, enabled)
     VALUES ($1, 'Paused rule', 'gid://shopify/Collection/2', FALSE)`,
    [shop.id]
  );

  const gone = await db.row(
    `INSERT INTO shops (domain, access_token, uninstalled_at)
     VALUES ('gone.myshopify.com', 't', now()) RETURNING *`
  );
  await db.rows(
    `INSERT INTO rules (shop_id, name, collection_id, enabled)
     VALUES ($1, 'Orphan rule', 'gid://shopify/Collection/3', TRUE)`,
    [gone.id]
  );

  const rows = await db.rows(
    `SELECT r.*, s.domain, s.access_token, s.id AS shop_pk
       FROM rules r
       JOIN shops s ON s.id = r.shop_id
      WHERE r.enabled = TRUE AND s.uninstalled_at IS NULL`
  );

  assert.equal(rows.length, 1, 'only the one live, enabled rule');
  assert.equal(rows[0].name, 'New arrivals');
  assert.equal(rows[0].domain, 'demo.myshopify.com');
});

test('run rows record their outcome and read back newest first', async () => {
  const db = await freshDb();
  const { shop, rule } = await seed(db);

  const started = await db.row(
    `INSERT INTO runs (rule_id, shop_id, trigger, status, started_at)
     VALUES ($1, $2, 'schedule', 'running', now()) RETURNING id`,
    [rule.id, shop.id]
  );

  await db.rows(
    `UPDATE runs SET status=$2, finished_at=now(), message=$3,
                     products_count=$4, moves_count=$5, details=$6
       WHERE id=$1`,
    [started.id, 'success', 'Moved 3 products.', 120, 3, JSON.stringify({ batches: 1 })]
  );

  await db.rows(
    `INSERT INTO runs (rule_id, shop_id, trigger, status, started_at, message)
     VALUES ($1, $2, 'manual', 'no_change', now(), 'Already sorted.')`,
    [rule.id, shop.id]
  );

  const rows = await db.rows(
    `SELECT r.*, ru.name AS rule_name
       FROM runs r JOIN rules ru ON ru.id = r.rule_id
      WHERE r.shop_id = $1
      ORDER BY r.id DESC LIMIT 100`,
    [shop.id]
  );

  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, 'no_change', 'newest first');
  assert.equal(rows[1].status, 'success');
  assert.equal(rows[1].moves_count, 3);
  assert.equal(rows[1].products_count, 120);
  assert.equal(rows[1].rule_name, 'New arrivals');
});

test('deleting a shop cascades to its rules and runs', async () => {
  const db = await freshDb();
  const { shop, rule } = await seed(db);
  await db.rows(`INSERT INTO runs (rule_id, shop_id, status) VALUES ($1, $2, 'success')`, [
    rule.id,
    shop.id,
  ]);

  await db.rows(`DELETE FROM shops WHERE id = $1`, [shop.id]);

  assert.equal(await db.count('SELECT id FROM rules'), 0);
  assert.equal(await db.count('SELECT id FROM runs'), 0);
});

test('rule mutations are scoped to the owning shop', async () => {
  const db = await freshDb();
  const { rule } = await seed(db);
  const other = await db.row(
    `INSERT INTO shops (domain, access_token) VALUES ('other.myshopify.com','t') RETURNING *`
  );

  // Another shop must not be able to touch this rule, even knowing its id.
  const updated = await db.rows(
    `UPDATE rules SET name='hijacked' WHERE id=$1 AND shop_id=$2 RETURNING *`,
    [rule.id, other.id]
  );
  assert.equal(updated.length, 0);

  const deleted = await db.rows(`DELETE FROM rules WHERE id=$1 AND shop_id=$2 RETURNING *`, [
    rule.id,
    other.id,
  ]);
  assert.equal(deleted.length, 0);

  const still = await db.row(`SELECT name FROM rules WHERE id=$1`, [rule.id]);
  assert.equal(still.name, 'New arrivals', 'the rule is untouched');
});

test('marking a shop uninstalled also pauses its rules', async () => {
  const db = await freshDb();
  const { rule } = await seed(db);

  await db.rows(
    `UPDATE shops SET uninstalled_at = now() WHERE domain = $1 AND uninstalled_at IS NULL`,
    ['demo.myshopify.com']
  );
  await db.rows(
    `UPDATE rules SET enabled = FALSE
      WHERE shop_id IN (SELECT id FROM shops WHERE domain = $1)`,
    ['demo.myshopify.com']
  );

  const row = await db.row(`SELECT enabled FROM rules WHERE id=$1`, [rule.id]);
  assert.equal(row.enabled, false);
});

test('lead-time settings upsert, legacy notices round-trip, and events list newest first', async () => {
  const db = await freshDb();
  const { shop } = await seed(db);

  const upsert = (enabled, notice, legacy) =>
    db.row(
      `INSERT INTO lead_time_settings (shop_id, enabled, tag, notice_text, sweep_at, legacy_notices, updated_at)
       VALUES ($1,$2,'special-order',$3,'04:00',$4,now())
       ON CONFLICT (shop_id) DO UPDATE SET
         enabled = EXCLUDED.enabled, tag = EXCLUDED.tag, notice_text = EXCLUDED.notice_text,
         sweep_at = EXCLUDED.sweep_at, legacy_notices = EXCLUDED.legacy_notices, updated_at = now()
       RETURNING *`,
      [shop.id, enabled, notice, JSON.stringify(legacy)]
    );

  const defaults = await db.row(`INSERT INTO lead_time_settings (shop_id) VALUES ($1) RETURNING *`, [shop.id]);
  assert.equal(defaults.enabled, false, 'off until a merchant turns it on');
  assert.equal(defaults.tag, 'special-order');
  assert.deepEqual(defaults.legacy_notices, []);

  const saved = await upsert(true, 'New wording.', ['Old wording.']);
  assert.equal(saved.enabled, true);
  assert.deepEqual(saved.legacy_notices, ['Old wording.']);
  assert.equal(await db.count('SELECT 1 FROM lead_time_settings'), 1);

  for (const action of ['added', 'removed']) {
    await db.rows(
      `INSERT INTO lead_time_events (shop_id, product_id, product_title, trigger, action, message)
       VALUES ($1,'gid://shopify/Product/1','Mellotron M4000D','webhook',$2,NULL)`,
      [shop.id, action]
    );
  }
  const events = await db.rows(
    `SELECT * FROM lead_time_events WHERE shop_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
    [shop.id, 50]
  );
  assert.deepEqual(events.map((e) => e.action), ['removed', 'added']);
});

test('lead-time nightly claim is taken exactly once per shop per day', async () => {
  const db = await freshDb();
  const { shop } = await seed(db);
  // pg-mem misreports rowCount/RETURNING for DO NOTHING (see the scheduler_claims
  // test above), so assert on the rows left behind instead.
  const claim = (slot) =>
    db.rows(
      `INSERT INTO lead_time_claims (shop_id, slot) VALUES ($1,$2) ON CONFLICT (shop_id, slot) DO NOTHING`,
      [shop.id, slot]
    );
  const slots = async () => (await db.rows(`SELECT slot FROM lead_time_claims WHERE shop_id=$1`, [shop.id])).length;
  await claim('2026-10-08T04:00');
  await claim('2026-10-08T04:00');
  assert.equal(await slots(), 1, 'the second replica adds nothing');
  await claim('2026-10-09T04:00');
  assert.equal(await slots(), 2, 'next day is a new slot');
});

test('deleting a shop removes its lead-time rows', async () => {
  const db = await freshDb();
  const { shop } = await seed(db);
  await db.rows(`INSERT INTO lead_time_settings (shop_id) VALUES ($1)`, [shop.id]);
  await db.rows(
    `INSERT INTO lead_time_events (shop_id, product_id, trigger, action) VALUES ($1,'p','webhook','added')`,
    [shop.id]
  );
  await db.rows(`INSERT INTO lead_time_claims (shop_id, slot) VALUES ($1,'s')`, [shop.id]);
  await db.rows(`DELETE FROM shops WHERE id = $1`, [shop.id]);
  assert.equal(await db.count('SELECT 1 FROM lead_time_settings'), 0);
  assert.equal(await db.count('SELECT 1 FROM lead_time_events'), 0);
  assert.equal(await db.count('SELECT 1 FROM lead_time_claims'), 0);
});
