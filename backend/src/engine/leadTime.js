/**
 * Lead-time notice — the pure half (no network, no database).
 *
 * The notice is a single bold paragraph that leads a product's description while
 * every variant is out of stock but still orderable. It is recognised by its
 * TEXT, not by hidden markup: Shopify's editor and the marketplaces we sync to
 * (Reverb, eBay) strip or rewrite unknown attributes and comments, but they keep
 * visible words. Matching on normalised text also means a hand-typed copy of the
 * notice is adopted rather than duplicated.
 *
 * Everything here is idempotent: applying the same decision twice returns the
 * same HTML, so the caller can compare before writing and never produce a
 * product update that changes nothing (which would otherwise wake every
 * downstream webhook for no reason).
 */

export const DEFAULT_NOTICE = 'Please allow 1-3 weeks for shipping at this time, thank you!';
export const DEFAULT_TAG = 'special-order';

// Restoration pre-order listings must keep their disclaimer as the FIRST
// paragraph (see the Listing Trees convention). Two managed lead paragraphs
// would need an agreed order, so those products are left alone instead.
export const RESTORATION_TAG = 'restoration';

const DASHES = /[‐-―]/g;
const SINGLE_QUOTES = /[‘’‛]/g;
const DOUBLE_QUOTES = /[“”]/g;

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  rsquo: "'",
  lsquo: "'",
  ndash: '-',
  mdash: '-',
};

/** Visible text of an HTML fragment, folded so trivial re-encoding can't defeat a match. */
export function comparable(html) {
  return String(html ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
      if (name[0] === '#') {
        const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
      }
      return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
    })
    .replace(DASHES, '-')
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const escapeHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const noticeParagraph = (text) => `<p><strong>${escapeHtml(text)}</strong></p>`;

// A paragraph plus the whitespace that follows it, so removing one leaves no gap.
const PARAGRAPH = /<p\b[^>]*>[\s\S]*?<\/p>\s*/gi;

/**
 * Returns the description with the notice present as its first paragraph
 * (show = true) or absent (show = false).
 *
 * `legacy` lists earlier wordings of the notice. When the merchant edits the
 * text, products still carry the OLD sentence; without this they would end up
 * with both.
 *
 * action: 'added' | 'removed' | 'repositioned' | 'unchanged'
 */
export function applyNotice(html, text, show, legacy = []) {
  const original = String(html ?? '');
  const wanted = new Set([text, ...legacy].map(comparable).filter(Boolean));

  let removed = 0;
  const rest = original.replace(PARAGRAPH, (paragraph) => {
    if (!wanted.has(comparable(paragraph))) return paragraph;
    removed += 1;
    return '';
  });

  if (!show) {
    // Never touch a description that carries no notice — not even whitespace.
    if (removed === 0) return { html: original, changed: false, action: 'unchanged' };
    return { html: rest.replace(/^\s+/, ''), changed: true, action: 'removed' };
  }

  const body = rest.replace(/^\s+/, '');
  const next = body ? `${noticeParagraph(text)}\n${body}` : noticeParagraph(text);
  if (next === original) return { html: original, changed: false, action: 'unchanged' };
  return { html: next, changed: true, action: removed > 0 ? 'repositioned' : 'added' };
}

/**
 * Whether the notice should show for a product, from its variants.
 *
 * The description is shared by every variant, so the notice is shown only when
 * NO variant can ship from stock — otherwise it would tell a customer buying the
 * in-stock colour to wait weeks. (A product with one colour out and one in stock
 * therefore shows no notice; that is the deliberate trade-off.)
 *
 *   in stock           tracked and quantity >= 1, or not tracked at all
 *   special order      tracked, quantity < 1, and "continue selling" is on
 *   sold out           tracked, quantity < 1, selling denied — not orderable, so
 *                      promising a lead time would be wrong
 */
export function decideNotice(variants) {
  if (!Array.isArray(variants) || variants.length === 0) {
    return { show: false, reason: 'The product has no variants.' };
  }

  const inStock = (v) => !v.inventoryItem?.tracked || Number(v.inventoryQuantity) >= 1;
  const orderable = (v) =>
    v.inventoryItem?.tracked && Number(v.inventoryQuantity) < 1 && v.inventoryPolicy === 'CONTINUE';

  if (variants.some(inStock)) return { show: false, reason: 'At least one variant is in stock.' };
  if (variants.some(orderable)) {
    return { show: true, reason: 'Every variant is out of stock and can still be ordered.' };
  }
  return { show: false, reason: 'Sold out and not available to order.' };
}
