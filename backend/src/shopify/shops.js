import { query } from '../db.js';
import { AdminClient } from './client.js';

export async function upsertShop({ domain, accessToken, scope, name, ianaTimezone }) {
  const { rows } = await query(
    `INSERT INTO shops (domain, access_token, scope, name, iana_timezone, installed_at, uninstalled_at)
     VALUES ($1, $2, $3, $4, COALESCE($5, 'UTC'), now(), NULL)
     ON CONFLICT (domain) DO UPDATE SET
       access_token   = EXCLUDED.access_token,
       scope          = EXCLUDED.scope,
       name           = COALESCE(EXCLUDED.name, shops.name),
       iana_timezone  = COALESCE(EXCLUDED.iana_timezone, shops.iana_timezone),
       uninstalled_at = NULL
     RETURNING *`,
    [domain, accessToken, scope || '', name || null, ianaTimezone || null]
  );
  return rows[0];
}

export async function getShop(domain) {
  const { rows } = await query(
    `SELECT * FROM shops WHERE domain = $1 AND uninstalled_at IS NULL`,
    [domain]
  );
  return rows[0] || null;
}

export async function markUninstalled(domain) {
  await query(
    `UPDATE shops SET uninstalled_at = now() WHERE domain = $1 AND uninstalled_at IS NULL`,
    [domain]
  );
  await query(
    `UPDATE rules SET enabled = FALSE
      WHERE shop_id IN (SELECT id FROM shops WHERE domain = $1)`,
    [domain]
  );
}

export function clientForShop(shop) {
  return new AdminClient(shop.domain, shop.access_token);
}
