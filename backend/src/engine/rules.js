/**
 * Rule evaluation: turns a strategy + the collection's products into the
 * desired final order.
 *
 * A strategy is:
 *   {
 *     base: 'current' | 'best_selling' | 'newest' | 'oldest' |
 *           'price_asc' | 'price_desc' | 'title_asc' | 'title_desc' |
 *           'inventory_desc' | 'inventory_asc',
 *     groups: [
 *       { type: 'tag',          tags: ['new'], match: 'any'|'all', position: 'top'|'bottom' },
 *       { type: 'out_of_stock', position: 'bottom' },
 *       { type: 'draft',        position: 'bottom' }
 *     ]
 *   }
 *
 * Groups are evaluated in listed order and the FIRST group a product matches
 * wins — so the group at the top of the list has the strongest claim. Within a
 * group, products keep their base order. Products matching nothing sit in the
 * middle, also in base order.
 */

export const BASE_ORDERS = [
  'current',
  'best_selling',
  'newest',
  'oldest',
  'price_asc',
  'price_desc',
  'title_asc',
  'title_desc',
  'inventory_desc',
  'inventory_asc',
];

export const GROUP_TYPES = ['tag', 'out_of_stock', 'draft'];

/** Bases that we cannot derive locally and must ask Shopify to sort for us. */
export const REMOTE_BASES = { best_selling: { sortKey: 'BEST_SELLING', reverse: false } };

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const price = (p) => num(p?.priceRangeV2?.minVariantPrice?.amount);
const inventory = (p) => num(p?.totalInventory);
const created = (p) => (p?.createdAt ? Date.parse(p.createdAt) : 0);
const title = (p) => String(p?.title || '');

/**
 * Applies the base ordering. `remoteOrder` is an optional list of product GIDs
 * returned by Shopify for bases we can't compute locally (best_selling).
 */
export function applyBaseOrder(products, base, remoteOrder) {
  const list = products.slice();

  if (base === 'current' || !base) return list;

  if (REMOTE_BASES[base]) {
    if (!remoteOrder?.length) return list; // fall back to current order
    const rank = new Map(remoteOrder.map((id, i) => [id, i]));
    // Anything Shopify didn't rank goes to the end, keeping its current order.
    return list
      .map((p, i) => ({ p, i, r: rank.has(p.id) ? rank.get(p.id) : Number.MAX_SAFE_INTEGER }))
      .sort((a, b) => a.r - b.r || a.i - b.i)
      .map((x) => x.p);
  }

  const comparators = {
    newest: (a, b) => created(b) - created(a),
    oldest: (a, b) => created(a) - created(b),
    price_asc: (a, b) => price(a) - price(b),
    price_desc: (a, b) => price(b) - price(a),
    title_asc: (a, b) => title(a).localeCompare(title(b), undefined, { numeric: true }),
    title_desc: (a, b) => title(b).localeCompare(title(a), undefined, { numeric: true }),
    inventory_desc: (a, b) => inventory(b) - inventory(a),
    inventory_asc: (a, b) => inventory(a) - inventory(b),
  };

  const cmp = comparators[base];
  if (!cmp) return list;

  // Decorate-sort-undecorate keeps the sort stable on ties.
  return list
    .map((p, i) => ({ p, i }))
    .sort((a, b) => cmp(a.p, b.p) || a.i - b.i)
    .map((x) => x.p);
}

function normalizeTag(t) {
  return String(t || '').trim().toLowerCase();
}

export function productMatchesGroup(product, group) {
  switch (group.type) {
    case 'tag': {
      const wanted = (group.tags || []).map(normalizeTag).filter(Boolean);
      if (!wanted.length) return false;
      const have = new Set((product.tags || []).map(normalizeTag));
      return group.match === 'all' ? wanted.every((t) => have.has(t)) : wanted.some((t) => have.has(t));
    }
    case 'out_of_stock':
      // totalInventory <= 0 covers both sold out and untracked-at-zero.
      return inventory(product) <= 0;
    case 'draft':
      return product.status && product.status !== 'ACTIVE';
    default:
      return false;
  }
}

/**
 * @returns {{ order: object[], buckets: Map<number, object[]>, matchCounts: number[] }}
 */
export function evaluate(products, strategy, remoteOrder) {
  const base = strategy?.base || 'current';
  const groups = Array.isArray(strategy?.groups) ? strategy.groups : [];

  const ordered = applyBaseOrder(products, base, remoteOrder);
  const matchCounts = groups.map(() => 0);

  const ranked = ordered.map((product, i) => {
    let rank = 0; // unmatched products sit in the middle
    for (let g = 0; g < groups.length; g++) {
      if (!productMatchesGroup(product, groups[g])) continue;
      matchCounts[g] += 1;
      // First matching group wins. Earlier groups outrank later ones, so a
      // 'top' group listed first ends up above a 'top' group listed second.
      rank = groups[g].position === 'bottom' ? 1_000_000 + g : -1_000_000 + g;
      break;
    }
    return { product, rank, i };
  });

  const order = ranked
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.product);

  return { order, matchCounts };
}

/** Throws a descriptive error if a strategy from the client is malformed. */
export function validateStrategy(strategy) {
  if (!strategy || typeof strategy !== 'object') throw new Error('Strategy must be an object.');

  const base = strategy.base || 'current';
  if (!BASE_ORDERS.includes(base)) {
    throw new Error(`Unknown base order "${base}". Expected one of: ${BASE_ORDERS.join(', ')}`);
  }

  const groups = strategy.groups ?? [];
  if (!Array.isArray(groups)) throw new Error('Strategy `groups` must be an array.');
  if (groups.length > 10) throw new Error('A rule can have at most 10 groups.');

  const clean = groups.map((g, i) => {
    if (!GROUP_TYPES.includes(g?.type)) {
      throw new Error(`Group ${i + 1}: unknown type "${g?.type}".`);
    }
    if (!['top', 'bottom'].includes(g?.position)) {
      throw new Error(`Group ${i + 1}: position must be "top" or "bottom".`);
    }
    const out = { type: g.type, position: g.position };
    if (g.type === 'tag') {
      const tags = (Array.isArray(g.tags) ? g.tags : [])
        .map((t) => String(t).trim())
        .filter(Boolean)
        .slice(0, 50);
      if (!tags.length) throw new Error(`Group ${i + 1}: add at least one tag.`);
      out.tags = tags;
      out.match = g.match === 'all' ? 'all' : 'any';
    }
    return out;
  });

  if (base === 'current' && clean.length === 0) {
    throw new Error('This rule would not change anything. Add a group or pick a base sort.');
  }

  return { base, groups: clean };
}

/** Human-readable one-liner for the run log and the UI. */
export function describeStrategy(strategy) {
  const parts = [];
  const baseLabels = {
    current: 'Keep current order',
    best_selling: 'Sort by best selling',
    newest: 'Sort newest first',
    oldest: 'Sort oldest first',
    price_asc: 'Sort by price, low to high',
    price_desc: 'Sort by price, high to low',
    title_asc: 'Sort by title A–Z',
    title_desc: 'Sort by title Z–A',
    inventory_desc: 'Sort by inventory, high to low',
    inventory_asc: 'Sort by inventory, low to high',
  };
  parts.push(baseLabels[strategy?.base || 'current'] || 'Keep current order');

  for (const g of strategy?.groups || []) {
    const where = g.position === 'bottom' ? 'to the bottom' : 'to the top';
    if (g.type === 'tag') {
      const joiner = g.match === 'all' ? ' and ' : ' or ';
      parts.push(`move products tagged ${g.tags.map((t) => `"${t}"`).join(joiner)} ${where}`);
    } else if (g.type === 'out_of_stock') {
      parts.push(`move out-of-stock products ${where}`);
    } else if (g.type === 'draft') {
      parts.push(`move unavailable products ${where}`);
    }
  }

  return parts.join(', then ');
}
