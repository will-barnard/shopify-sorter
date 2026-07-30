# Collection Sorting Scheduler

A Shopify embedded app that reorders manual collections on a daily schedule.

The main job it was built for: **every day, move every product carrying a given tag to the top of a collection's manual sort order.** It also handles pushing out-of-stock products down, and re-sorting a whole collection by a metric like best-selling or newest.

Vue 3 frontend, Node/Express backend, Postgres, deployed on Beachhead.

---

## How sorting rules work

A rule targets one collection and runs once a day at a time you choose, in a timezone you choose.

Each rule has two parts:

**1. A base order** — the starting point. Either *keep the current manual order* (the usual choice) or re-sort everything by best-selling, newest, oldest, price, title, or inventory.

**2. Groups** — products pulled to the top or pushed to the bottom. A group matches on tags (any-of or all-of), on being out of stock, or on being draft/archived.

Groups are checked **in order, and the first match wins**. Group 1 has the strongest claim on a product, so if something is both `featured` and sold out, whichever group is listed first decides where it lands. Products matching no group stay in the middle, in base order.

The rule for the primary use case is: base = *keep current order*, one group = *products tagged `new` → to the top*. That's the default when you create a rule.

### Preview before you commit

The rule editor has a **Preview changes** button that reads the collection and shows the before/after ordering side by side without writing anything. Worth using before enabling a rule on a live collection.

---

## Setup

### 1. Create the app in the Shopify Partner dashboard

1. [Partner dashboard](https://partners.shopify.com) → **Apps** → **Create app** → **Create app manually**.
2. Note the **Client ID** (this is `SHOPIFY_API_KEY`) and **Client secret** (`SHOPIFY_API_SECRET`).
3. Under **Configuration → URLs**:
   - **App URL**: `https://your-app.example.com`
   - **Allowed redirection URL(s)**: `https://your-app.example.com/auth/callback`
4. Under **Configuration → Embedded app**, make sure the app is set to embed in the Shopify admin.

The requested scopes are `read_products,write_products`. Reordering a collection requires `write_products`.

### 2. Deploy on Beachhead

Push this repo, then set these as **global** environment variables in the Beachhead dashboard (leave Target Service blank so they land in `.env` for Compose substitution):

| Variable | Value |
| --- | --- |
| `DB_PASSWORD` | any long random string |
| `SHOPIFY_API_KEY` | Client ID from step 1 |
| `SHOPIFY_API_SECRET` | Client secret from step 1 |
| `APP_URL` | the public https origin, no trailing slash |

Optional: `SHOPIFY_API_VERSION` (default `2026-07`), `SHOPIFY_SCOPES`, `SCHEDULER_ENABLED`.

`APP_URL` must match the App URL in the Partner dashboard exactly, or OAuth will fail on the redirect.

Postgres is declared in `beachhead.json` as a stateful service, so it keeps running across blue/green deploys and its named volume (`shopify-sorter-postgres`) survives redeploys.

### 3. Install on a store

Visit `https://your-app.example.com/auth?shop=your-store.myshopify.com`, or use the install link from the Partner dashboard. After granting access you'll land in the embedded admin.

---

## Local development

```bash
# Postgres
docker run -d --name sorter-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_USER=sorter \
  -e POSTGRES_DB=sorter -p 5432:5432 postgres:16-alpine

# Backend
cd backend && npm install
DATABASE_URL=postgres://sorter:dev@localhost:5432/sorter \
SHOPIFY_API_KEY=... SHOPIFY_API_SECRET=... APP_URL=https://your-tunnel.example \
npm run dev

# Frontend
cd frontend && npm install
VITE_SHOPIFY_API_KEY=... npm run dev
```

Because the app is embedded and uses session tokens, you need a public https tunnel (Cloudflare Tunnel, ngrok) pointed at the frontend dev server, with `APP_URL` and the Partner dashboard URLs set to the tunnel hostname.

Run the tests with `cd backend && npm test`.

---

## Architecture

```
frontend/          Vue 3 + Vite, served by nginx which also reverse-proxies the API
  src/lib/api.js   attaches a fresh App Bridge session token to every request
  src/components/  rule editor, collection picker, tag input, run history

backend/
  src/routes/auth.js      OAuth install + callback, webhook registration
  src/routes/api.js       session-token-authenticated JSON API
  src/routes/webhooks.js  raw-body HMAC verification, app/uninstalled
  src/engine/planner.js   desired order -> minimal Shopify move list
  src/engine/rules.js     strategy -> desired order
  src/engine/runner.js    fetch, evaluate, plan, apply, log
  src/scheduler.js        minute tick, per-rule timezone, run claims
```

### Authentication

Install uses the standard OAuth grant flow with HMAC verification and a `state` cookie (`SameSite=None; Secure`, since the app runs in an iframe). After install, every API call carries an App Bridge session token — a short-lived JWT signed with the app secret. The backend verifies the signature, the `aud` claim against its own API key, expiry, and that `iss` and `dest` agree, then takes the shop domain **from the token's `dest` claim only** — never from a query parameter. That's what stops one store's session from reaching another store's rules.

If a shop's token is missing or the app was uninstalled, the API responds `403` with `X-Shopify-API-Request-Failure-Reauthorize`, and the frontend does a top-level redirect back into OAuth.

### The reorder planner

This is the part worth understanding, because `collectionReorderProducts` has awkward semantics: moves are applied **sequentially**, and each `newPosition` is a zero-based index *at the moment that move is applied*, not in the original list.

A naive "walk the target order and fix each mismatched slot" approach is correct but pathological — moving a single product from the top to the bottom of a 200-product collection would emit 199 moves.

Instead, `planner.js` computes the **longest increasing subsequence** of the target products' current positions. Those products are already in the right relative order and never move. Every other product moves exactly once, inserted immediately after its predecessor in the target order (which is always already settled by then). That gives `n - LIS` moves, which is the theoretical minimum number of single-item moves. Moving one product to the bottom costs one move; pulling three tagged products to the top of a 200-product collection costs three.

Before anything is sent to Shopify the runner replays the plan locally and aborts if the replay doesn't reproduce the target order, so a planning bug can't scramble a live collection.

The test suite fuzzes 2,500 random permutations, asserting both exact replay and that the move count equals the LIS bound.

### Scheduling

The backend ticks once a minute and fires any enabled rule whose `HH:MM` in its own timezone matches. Before running, it claims a slot row keyed by `(rule, shop-local date + time)` via an atomic `INSERT … ON CONFLICT`, so two backend containers during a blue/green swap can't double-run the same rule.

### Safety details

- Shopify only permits reordering on `MANUAL` collections. If the target collection uses another sort order, the rule either switches it to manual (default, toggleable per rule) or is skipped with an explanatory message rather than failing silently.
- Moves are applied in batches of 200, and the collection is re-fetched and re-planned between batches, so a merchant editing the collection mid-run can't cause later batches to apply at stale positions.
- The Admin client retries on `429`, `5xx`, and GraphQL `THROTTLED` with exponential backoff.
- Every run is logged with status, move count, and message, visible in the Run history table.
- `app/uninstalled` marks the shop uninstalled and disables its rules, so the scheduler stops calling a store that revoked access.

---

## API

All `/api` routes require `Authorization: Bearer <session token>`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/me` | shop info and available base orders |
| `GET` | `/api/collections?search=` | collection picker |
| `GET` | `/api/tags` | product tag suggestions |
| `GET` | `/api/timezones` | IANA timezone list |
| `GET` | `/api/rules` | list rules |
| `POST` | `/api/rules` | create |
| `PUT` | `/api/rules/:id` | update |
| `PATCH` | `/api/rules/:id/enabled` | pause / resume |
| `DELETE` | `/api/rules/:id` | delete |
| `POST` | `/api/rules/:id/run` | run now |
| `POST` | `/api/preview` | dry run, changes nothing |
| `GET` | `/api/runs?ruleId=` | run history |

`GET /healthz` is unauthenticated.

---

## Known limits

- Collections over 10,000 products are rejected rather than partially sorted.
- The best-selling base order is resolved by Shopify at run time, so the preview shows grouping only, not the final best-seller sequence.
- The tag picker suggests up to 1,000 tags; you can always type a tag that isn't in the list.
- Rules are capped at 100 per shop and 10 groups per rule.

---

## Tests

```
cd backend && npm test
```

52 tests covering:

- **planner** — 2,500 fuzzed permutations, asserting exact replay under Shopify's sequential-move semantics and that the move count equals the LIS lower bound.
- **rules** — group precedence, tag matching, base sorts, and that evaluation always returns a permutation of the input.
- **runner** — the full fetch → evaluate → plan → mutate loop against a fake Shopify that implements the documented reorder semantics, including 30 consecutive daily runs to prove idempotence.
- **security** — OAuth and webhook HMAC verification, session token signature/audience/expiry/issuer checks, `alg: none` rejection, and shop-domain validation.
- **sql** — the real schema and queries against an in-memory Postgres, including cross-shop isolation and the scheduler's double-run guard.
