import { DateTime } from 'luxon';
import { query } from './db.js';
import { runRule } from './engine/runner.js';
import { enqueueForShop, getSettings, sweepShop, sweepAllEnabledShops } from './engine/leadTimeRunner.js';
import { clientForShop } from './shopify/shops.js';

/**
 * Ticks once a minute. A rule fires when the current wall-clock time in the
 * rule's own timezone matches its `run_at`.
 *
 * Double-run protection: `scheduler_claims` holds one row per rule keyed by the
 * slot string (shop-local date + time). The INSERT ... ON CONFLICT DO NOTHING
 * is atomic, so if two backend containers tick simultaneously exactly one of
 * them wins the claim and the other skips.
 */

let timer = null;
let running = false;

export function startScheduler() {
  const tick = () => {
    if (running) return;
    running = true;
    Promise.all([
      runDueRules().catch((err) => console.error('[scheduler] tick failed', err)),
      runDueLeadTimeSweeps().catch((err) => console.error('[scheduler] lead-time tick failed', err)),
    ])
      .finally(() => {
        running = false;
      });
  };

  // Align to the top of the next minute, then run every 60s.
  const msToNextMinute = 60_000 - (Date.now() % 60_000);
  setTimeout(() => {
    tick();
    timer = setInterval(tick, 60_000);
  }, msToNextMinute + 500);

  console.log('[scheduler] started');
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

/**
 * Boot sweep: webhooks missed while the app was down or deploying are caught up
 * shortly after start. Delayed so it never competes with startup. Safe on every
 * replica — the sweep only writes when a description actually differs.
 */
export function scheduleBootLeadTimeSweep(delayMs = 30_000) {
  const t = setTimeout(() => {
    sweepAllEnabledShops('boot').catch((err) => console.error('[lead-time] boot sweep failed', err));
  }, delayMs);
  t.unref();
}

/** Nightly lead-time sweep, at each shop's own local sweep_at, claimed once per day. */
export async function runDueLeadTimeSweeps(now = new Date()) {
  await query(`DELETE FROM lead_time_claims WHERE claimed_at < now() - interval '7 days'`).catch(() => {});
  await query(`DELETE FROM lead_time_events WHERE created_at < now() - interval '90 days'`).catch(() => {});

  const { rows } = await query(
    `SELECT s.id, s.domain, s.access_token, s.iana_timezone, l.sweep_at
       FROM lead_time_settings l JOIN shops s ON s.id = l.shop_id
      WHERE l.enabled = TRUE AND s.uninstalled_at IS NULL`
  );

  for (const row of rows) {
    const zone = isValidZone(row.iana_timezone) ? row.iana_timezone : 'UTC';
    const local = DateTime.fromJSDate(now, { zone });
    const hhmm = local.toFormat('HH:mm');
    if (hhmm !== normalizeTime(row.sweep_at)) continue;

    const slot = `${local.toFormat('yyyy-LL-dd')}T${hhmm}`;
    const { rowCount } = await query(
      `INSERT INTO lead_time_claims (shop_id, slot) VALUES ($1,$2) ON CONFLICT (shop_id, slot) DO NOTHING`,
      [row.id, slot]
    );
    if (!rowCount) continue;

    // Not awaited: one slow shop must not hold up the minute tick.
    enqueueForShop(row.domain, async () => {
      const settings = await getSettings(row.id);
      if (!settings.enabled) return;
      const shop = { id: row.id, domain: row.domain, access_token: row.access_token };
      const s = await sweepShop({ shop, settings, trigger: 'sweep' });
      console.log(`[lead-time] ${row.domain} nightly: ${s.checked} checked, ${s.changed} changed, ${s.errors} errors`);
    }).catch((err) => console.error(`[lead-time] ${row.domain} nightly sweep failed:`, err.message));
  }
}

export async function runDueRules(now = new Date()) {
  await pruneClaims().catch((err) => console.warn('[scheduler] claim prune failed', err.message));

  const { rows: rules } = await query(
    `SELECT r.*, s.domain, s.access_token, s.id AS shop_pk
       FROM rules r
       JOIN shops s ON s.id = r.shop_id
      WHERE r.enabled = TRUE
        AND s.uninstalled_at IS NULL`
  );

  const due = [];
  for (const rule of rules) {
    const zone = isValidZone(rule.timezone) ? rule.timezone : 'UTC';
    const local = DateTime.fromJSDate(now, { zone });
    const hhmm = local.toFormat('HH:mm');
    if (hhmm !== normalizeTime(rule.run_at)) continue;
    due.push({ rule, slot: `${local.toFormat('yyyy-LL-dd')}T${hhmm}` });
  }

  const results = [];
  for (const { rule, slot } of due) {
    const claimed = await claimSlot(rule.id, slot);
    if (!claimed) continue;

    const shop = {
      id: rule.shop_pk,
      domain: rule.domain,
      access_token: rule.access_token,
    };

    console.log(`[scheduler] running rule ${rule.id} (${rule.name}) for ${shop.domain}`);
    const result = await runRule({ shop, rule, trigger: 'schedule' });
    results.push({ ruleId: rule.id, ...result });
  }

  return results;
}

/**
 * Atomically claims a (rule, minute) slot. The composite primary key does the
 * work: whichever container inserts first gets rowCount 1, everyone else
 * conflicts and gets 0.
 */
async function claimSlot(ruleId, slot) {
  const { rowCount } = await query(
    `INSERT INTO scheduler_claims (rule_id, slot, claimed_at)
     VALUES ($1, $2, now())
     ON CONFLICT (rule_id, slot) DO NOTHING`,
    [ruleId, slot]
  );
  return rowCount > 0;
}

async function pruneClaims() {
  await query(`DELETE FROM scheduler_claims WHERE claimed_at < now() - interval '7 days'`);
}

function normalizeTime(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) return '03:00';
  const h = String(Math.min(23, Number(m[1]))).padStart(2, '0');
  const min = String(Math.min(59, Number(m[2]))).padStart(2, '0');
  return `${h}:${min}`;
}

export function isValidZone(zone) {
  if (!zone) return false;
  return DateTime.local().setZone(zone).isValid;
}

export { normalizeTime };
