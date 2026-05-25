# Posku Roadmap

## Current state (POC)
- Static `index.html` running locally
- User pastes/drops Wayfair load emails → parser generates SKUs
- Manual "Push to ERP" via viatrading API from the browser
- CORS bypass via Chrome `--disable-web-security` for testing
- Dedicated API user `posku_api` (id 183) for audit trail
- Branch: `claude/charming-newton-Z1q4t`

## Next phases

### Phase 1 — Cloudflare hosting
- Deploy `index.html` as a Cloudflare Pages site
- Restrict access via **Cloudflare Access** (Zero Trust) — Google OAuth, allowlist viatrading email domain
- Move ERP calls behind a **Cloudflare Worker** so:
  - API key lives as a Worker secret (never reaches browser)
  - CORS goes away (Worker is same-origin as the page)
  - One server-side place for retry / logging / dedup

### Phase 2 — Gmail auto-intake
- User applies a Gmail label (e.g. `posku-intake`) to Wayfair load emails
- Worker (cron-triggered or Gmail Pub/Sub push) pulls labeled emails
- Auto-parses each → generates SKU candidates
- Confident parses → queue for one-click confirm
- Ambiguous parses → flag for manual fix
- After processing → relabel to `posku-processed` (so we don't re-process)

### Phase 3 — Purchase Order generation
- After SKU is pushed to ERP, prompt user to generate a Purchase Order for that SKU
- Likely another viatrading API endpoint — capture the curl when ready
- Pre-fill PO with what we already know: SKU, supplier, FOB, pallet count

## Open items (carried over from POC)
- Drop `-test` suffix when going live
- Email parsing for `pallets_qty` (Wayfair emails sometimes include it)
- Verify hardcoded trait/store/supplier IDs against `/api/products/dropdowns` on staging
- **PUT updates clear traits if omitted** — when we add update flow, always include `packing`, `condition`, `manifested`, `productType`
