import pg from 'pg';
import { config } from './config.js';

// Shopify returns numeric-ish IDs as strings; keep bigint as string, not float.
pg.types.setTypeParser(20, (v) => (v === null ? null : String(v)));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 8,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  console.error('[db] idle client error', err);
});

export const query = (text, params) => pool.query(text, params);

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS shops (
  id             BIGSERIAL PRIMARY KEY,
  domain         TEXT NOT NULL UNIQUE,
  access_token   TEXT NOT NULL,
  scope          TEXT NOT NULL DEFAULT '',
  iana_timezone  TEXT NOT NULL DEFAULT 'UTC',
  name           TEXT,
  installed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  uninstalled_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS rules (
  id                BIGSERIAL PRIMARY KEY,
  shop_id           BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  collection_id     TEXT NOT NULL,
  collection_title  TEXT NOT NULL DEFAULT '',
  enabled           BOOLEAN NOT NULL DEFAULT TRUE,
  run_at            TEXT NOT NULL DEFAULT '03:00',
  timezone          TEXT NOT NULL DEFAULT 'UTC',
  strategy          JSONB NOT NULL DEFAULT '{"base":"current","groups":[]}'::jsonb,
  force_manual_sort BOOLEAN NOT NULL DEFAULT TRUE,
  last_run_at       TIMESTAMPTZ,
  last_status       TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rules_shop_idx ON rules(shop_id);

CREATE TABLE IF NOT EXISTS runs (
  id             BIGSERIAL PRIMARY KEY,
  rule_id        BIGINT NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  shop_id        BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  trigger        TEXT NOT NULL DEFAULT 'schedule',
  status         TEXT NOT NULL DEFAULT 'running',
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ,
  products_count INTEGER NOT NULL DEFAULT 0,
  moves_count    INTEGER NOT NULL DEFAULT 0,
  message        TEXT,
  details        JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS runs_rule_idx ON runs(rule_id, started_at DESC);
CREATE INDEX IF NOT EXISTS runs_shop_idx ON runs(shop_id, started_at DESC);

-- Serialises the scheduler tick so two backend replicas never double-run a rule.
-- One row per (rule, scheduled minute); the composite primary key means the
-- claim is just an INSERT that either succeeds or conflicts. Old rows are
-- pruned on each tick.
CREATE TABLE IF NOT EXISTS scheduler_claims (
  rule_id    BIGINT NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  slot       TEXT NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (rule_id, slot)
);

-- Lead-time notice (see engine/leadTime.js). One settings row per shop; the
-- notice is OFF until a merchant enables it. legacy_notices holds earlier
-- wordings so editing the text replaces the old sentence instead of stacking.
CREATE TABLE IF NOT EXISTS lead_time_settings (
  shop_id        BIGINT PRIMARY KEY REFERENCES shops(id) ON DELETE CASCADE,
  enabled        BOOLEAN NOT NULL DEFAULT FALSE,
  tag            TEXT NOT NULL DEFAULT 'special-order',
  notice_text    TEXT NOT NULL DEFAULT 'Please allow 1-3 weeks for shipping at this time, thank you!',
  sweep_at       TEXT NOT NULL DEFAULT '04:00',
  legacy_notices JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Only real changes (and errors) are logged, never "checked, nothing to do".
-- Every inventory movement in the shop reaches the webhook; logging them all
-- would bury the few rows that matter.
CREATE TABLE IF NOT EXISTS lead_time_events (
  id            BIGSERIAL PRIMARY KEY,
  shop_id       BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  product_id    TEXT NOT NULL,
  product_title TEXT NOT NULL DEFAULT '',
  trigger       TEXT NOT NULL,
  action        TEXT NOT NULL,
  message       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lead_time_events_shop_idx ON lead_time_events(shop_id, created_at DESC);

-- Same double-run guard as scheduler_claims, keyed by shop for the nightly sweep.
CREATE TABLE IF NOT EXISTS lead_time_claims (
  shop_id    BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  slot       TEXT NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, slot)
);
`;

export async function migrate() {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      await pool.query('SELECT 1');
      break;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      console.log('[db] waiting for postgres…');
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  await pool.query(SCHEMA);
  console.log('[db] schema ready');
}
