import { config } from '../config.js';
import { query } from '../db.js';
import { AdminClient } from './client.js';
import { CREATE_WEBHOOK } from './queries.js';

// inventory_levels/update needs the read_inventory scope; Shopify refuses the
// subscription without it. Subscriptions are skipped (not failed) for a shop
// whose stored token predates that scope, so re-authorising adds it later.
export const SCOPE_FOR_INVENTORY = 'read_inventory';

export const webhookTopics = () => [
  ['APP_UNINSTALLED', `${config.appUrl}/webhooks/app/uninstalled`, null],
  ['SHOP_REDACT', `${config.appUrl}/webhooks/shop/redact`, null],
  ['INVENTORY_LEVELS_UPDATE', `${config.appUrl}/webhooks/inventory_levels/update`, SCOPE_FOR_INVENTORY],
];

export const hasScope = (scopeString, scope) =>
  String(scopeString || '')
    .split(',')
    .map((s) => s.trim())
    .includes(scope);

export async function registerWebhooks(client, grantedScope) {
  for (const [topic, callbackUrl, needsScope] of webhookTopics()) {
    if (needsScope && !hasScope(grantedScope, needsScope)) {
      console.warn(`[webhooks] ${client.shop}: skipping ${topic}, token lacks ${needsScope} (re-authorise the app)`);
      continue;
    }
    try {
      await client.mutate(
        CREATE_WEBHOOK,
        { topic, sub: { callbackUrl, format: 'JSON' } },
        'webhookSubscriptionCreate'
      );
    } catch (err) {
      // Re-registering an existing subscription is a userError, not a failure.
      if (/already exists|taken/i.test(err.message)) continue;
      console.warn(`[webhooks] ${client.shop}: ${topic} registration failed:`, err.message);
    }
  }
}

/**
 * Existing installs only registered webhooks during OAuth, so a topic added
 * later would never arrive for them. Run at boot; duplicates are no-ops.
 */
export async function ensureWebhooksForAllShops() {
  const { rows } = await query(
    `SELECT domain, access_token, scope FROM shops WHERE uninstalled_at IS NULL`
  );
  for (const shop of rows) {
    try {
      await registerWebhooks(new AdminClient(shop.domain, shop.access_token), shop.scope);
    } catch (err) {
      console.warn(`[webhooks] ${shop.domain}: ensure failed:`, err.message);
    }
  }
}
