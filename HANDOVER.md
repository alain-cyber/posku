# Posku — handover

What this app does, where things live, what's in flight, and what to ask the
user about. **Read this first** when picking up cold.

---

## 1 · What Posku is, in one paragraph

Vanilla-JS web app hosted on **Cloudflare Pages** that drives the full
liquidation-load pipeline at viatrading.com: parses supplier emails (Wayfair,
Sam's Club) → generates SKUs → pushes them as ERP products → drafts +
pushes purchase orders → drafts + pushes customer invoices. Three pipeline
stages, all going through one env-aware proxy that respects a master
**TEST/LIVE** toggle in the sidebar.

Domain: `https://posku-c2t.pages.dev` (production-branch `main`, deploys on
every push).

---

## 2 · The pipeline

```
  Inbox / paste / Drive          SKU                PO                 Invoice
  ─────────────────────  ──────────────────  ─────────────────  ─────────────────
  Parse email body  →    POST /api/products  POST /api/purchase  POST /api/orders
  Auto-attach CSVs       (creates the                 -orders   (bills customer
  Pre-fill loads          inventory record) (buys from supplier)  for presold load)
                             ↓                  ↓                    ↓
                          SKU ✓               PO ✓                INV ✓
                            tri-chip status strip per load row
```

Every API call goes through `functions/api/[[path]].js` which injects the
correct `api-key` header for whichever env the sidebar toggle is on:

| Sidebar | Base URL | Secret env var |
|---|---|---|
| TEST | `viatrading.biz` | `BIZ_API` |
| LIVE | `ops.viatrading.com` | `ops_api_key` |

---

## 3 · File map

| File | What it is |
|---|---|
| `index.html` | The entire app — UI, all the JS. Single-file by design. |
| `diagnostic.html` | Debug page (`/diagnostic`) — last push, saved product, ref SKU, dropdowns, inbox-fetch summary. |
| `whats-new.html` | User-facing changelog by week (`/whats-new`). |
| `functions/api/[[path]].js` | Catch-all proxy → viatrading. Env-aware. |
| `functions/api/gmail/messages.js` | Pulls labeled Gmail emails. Returns metadata + attachment refs. |
| `functions/api/gmail/attachment.js` | Fetches a single attachment's bytes. Exists separately to dodge Workers' 50-subrequest cap. |
| `functions/api/drive/list.js` | Searches Google Drive for manifest files. |
| `functions/api/drive/file.js` | Downloads one Drive file as text (or base64). |
| `functions/api/sheets/append.js` | Appends rows to the Load Center Google Sheet. |
| `functions/api/sheets/init-headers.js` | Rewrites the sheet's header row. |
| `functions/api/customers/search.js` | BigQuery `customers_flat` typeahead for the invoice flow. **Temp** — swap to ERP `/api/customers` when available. |
| `functions/api/rules.js` | KV-backed shared rules (Wayfair + Sam's config). |
| `CLOUDFLARE_SETUP.md` | One-time setup steps for the dashboard / GCP / Workspace. |
| `PRODUCTS_API.md` | Field reference for `POST /api/products`. |
| `ORDERS_API.md` | Field reference for `POST /api/orders` + hardcoded enums + customer-source notes. |
| `ROADMAP.md` | Wishlist + Wayfair markup table + historical notes. |
| `HANDOVER.md` | This file. |

---

## 4 · Recent work (last session)

Pushed end-to-end **customer invoicing**:

| Commit | What |
|---|---|
| `e5d8bc7` | New `/api/customers/search` Pages Function (BigQuery typeahead) |
| `e0563f9` | Invoice flow: unique-toggle, drafts, customer picker, POST /api/orders |
| `7825d35` | Rules editor: default invoice customer tables (SMS by loc, WYF by loc+type) |
| `086a8a5` | Tri-chip SKU · PO · INV status strip per load |
| `fc93ed3` | Detected-loads card collapsible |
| `27fe32a` | PO drafts + Invoice drafts cards collapsible |
| `1926a74` | Customer typeahead: surface real error in dropdown |

Read these in commit order if you need to understand the invoice flow.

---

## 5 · Open / blocked items

### Blocked on the user

1. **BigQuery IAM grants** — the invoice customer search needs
   `roles/bigquery.jobUser` on `data-warehouse-494801` + `roles/bigquery.dataViewer`
   on the `alain_via_erp` dataset, granted to the same SA Posku already uses
   for Gmail/Drive (`GMAIL_SA_EMAIL`). User confirmed they'd do this — until
   they do, the customer picker shows `lookup failed — Access Denied: ...
   bigquery.jobs.create permission`. See CLOUDFLARE_SETUP.md step 8 for the
   exact gcloud / Console steps.

2. **App rename** — user asked for name ideas, I gave a shortlist (Manifold,
   Hangar, Lodemark, Stacker, Forge, Pallette, Quayd, Skubot). They have not
   picked. Currently called **Posku**.

### Blocked on the ERP team

3. **Invoice response shape** — which JSON field carries the new invoice id.
   Posku currently sniffs `newOrderId / newId / id / order_id` and falls back
   to "(check response)" in the success message. Locking this is just a
   one-line change once the user pastes a sample response.

4. **`payments[]` semantics** — for unpaid invoices, server-side behavior of
   `[]` vs omitted vs a pending-method record. Posku always sends `[]` for
   now.

5. **Proper customers REST endpoint** — currently bridged via BigQuery
   `customers_flat`. When the ERP team exposes `/api/customers`, swap the
   Pages Function for a thin pass-through (frontend code unchanged).

### Deferred / "advise later" (user)

6. **"Presold" data signal** — whether there's a flag/tag/sheet column
   marking which loads have a customer waiting. Would let Posku gate the
   Invoice button on it and show a "presold" chip on the row.

---

## 6 · Mental model for working in `index.html`

- It's **one IIFE-wrapped script** at the bottom, ~5000 lines. No build step.
- `SUPPLIERS.WYF` / `SUPPLIERS.SMS` — the per-supplier config object. Most
  per-supplier behavior keys off here. KV overrides load into these on app
  start via `applyRulesOverride()`.
- `loads[]` — the main state. Each row in the loads table is a load object.
  Status field walks: `'review' → 'ready' → 'pushing' → 'done' / 'failed' / 'dup'`.
- `poDrafts[]` — generated from selected done-loads via `generatePoDrafts()`.
- `invoiceDrafts[]` — generated from selected done-loads via `generateInvoiceDrafts()`.
  Each draft = one customer + N items.
- `erpRequest(method, path, body)` — the wrapper that respects TEST/LIVE.
  Anything talking to the ERP goes through this.
- `renderLoads()` — called after any state change. Triggers the tri-chip
  status refresh, the action-row update, and the Drive table re-render.
- LocalStorage keys (prefixed `posku.`):
  - `posku.cfg.v3` — base config (api key in local-file mode, env toggle)
  - `posku.stats.v1` — gamification HUD counters
  - `posku.zoom.v1` — sidebar zoom setting
  - `posku.sidebar.collapsed` — sidebar collapse state
  - `posku.inbox.diag.v1` — diagnostic stash from last inbox fetch
  - `posku.push.history.v1` — last 10 push captures (for diagnostic page)
  - `posku.invoice.recentCustomers.v1` — typeahead recents

---

## 7 · Conventions worth knowing

- **Commit messages**: imperative present, with a body that explains WHY +
  the user-visible effect. E.g. `Hide Push button on duplicate loads; make
  the duplicate chip louder` then a paragraph about why dup-status loads
  shouldn't be pushable.
- **No emojis in code/commits** unless the user explicitly asked.
- **No "you should..."** in chat replies. State what you did + what changed.
- **Don't make a PR** unless user asks. Push directly to `main` after each
  change so Pages redeploys. User has the production branch wired to deploy
  on `main`.
- **TEST/LIVE master toggle** must respect ALL endpoints. Any new endpoint
  must go through `erpRequest()` (or read `X-Posku-Env` if it's a server-side
  Pages Function).
- **One-file design** — the user has explicitly asked us to keep adding to
  `index.html` rather than splitting. Don't refactor it into modules.

---

## 8 · Things you can test cold without bothering the user

- **Hit the live `/diagnostic` page** to see what the last push looked like.
- **Read the recent commits** with `git log --oneline -20` to see what
  shipped.
- **`grep -n` against `index.html`** — the JS is structured with `// ════`
  banners marking each subsystem (INVOICE FLOW, SUPPLIER REGISTRY, etc.).
- **BigQuery via MCP** — read the warehouse tables directly to confirm
  schema before changing any SQL in the Pages Functions. Project
  `data-warehouse-494801`.

---

## 9 · The user

- Speaks via voice transcription a lot — expect typos and run-on sentences.
  Ask one clarifying question if anything is ambiguous; don't guess.
- Wants forward motion. Plans, then ships. Doesn't want over-engineering.
- Sometimes pivots mid-feature. When you get a system-reminder mid-task,
  honor the new request and circle back.
- Repository is `alain-cyber/posku` on GitHub. Only branch we work on is `main`.
