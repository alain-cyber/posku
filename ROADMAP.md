# Posku Roadmap

> **For new sessions**: read [`HANDOVER.md`](HANDOVER.md) first for the current state.
> This file is the historical roadmap + remaining wishlist.

## Current state (Live)

Hosted on Cloudflare Pages with full server-side proxy, KV-backed shared rules,
Gmail/Drive/Sheets/BigQuery integrations, and the three-stage push pipeline
end-to-end:

- **SKU push** — Wayfair + Sam's Club. Parses inbox emails or pasted text → generates SKUs → `POST /api/products`.
- **PO push** — bulk-select pushed SKUs → drafts → `POST /api/purchase-orders`.
- **Invoice push** — bulk-select pushed SKUs → per-customer drafts → `POST /api/orders`. Customer picker via BigQuery typeahead.

Per-load progress visible as a 3-stage strip: **SKU · PO · INV**. TEST/LIVE
master toggle routes every API call to viatrading.biz or ops.viatrading.com.

## In flight / blocked

| Item | Status | Notes |
|---|---|---|
| BigQuery IAM grants for customer search | ⏳ pending user | `roles/bigquery.jobUser` + `roles/bigquery.dataViewer` on the SA — see CLOUDFLARE_SETUP.md step 8 |
| ERP invoice response shape (which field is the new invoice id) | ⏳ pending user | Posku sniffs `newOrderId / newId / id / order_id` until locked |
| `payments[]` semantics for unpaid invoices | ⏳ pending ERP team | Always `[]` in v1 |
| Customer search API endpoint | ⏳ pending ERP team | Using BigQuery `customers_flat` as a temp bridge |
| "Presold" data signal on loads | ⏳ pending user direction | Would add a "presold" chip + gate the Invoice button |
| App rename | ⏳ pending user pick | Shortlist in HANDOVER.md; user has not chosen yet |

## Future ideas (no work scheduled)

- Auto-cron the Gmail intake (today it's user-triggered via the Fetch button)
- Harbor Freight + Amazon suppliers (sidebar slots already exist, marked "soon")
- Per-rep dashboards (the Vicki Intelligence panel does this server-side already)
- One-click "reprice all" using a fresh markup table import

---

## Historical reference

### Wayfair markup table (from Alain 2026-05-28)

Per-location × per-type. LQ is the only universally-applied 11.5%; everything else
varies. Salvage is a **flat $3,000 per load** (not a percentage).

| Location | Code | LQ | Aged | HDO | QC | Salvage | Perigold | Dropped Trailer |
|---|---|---|---|---|---|---|---|---|
| Perris, CA | `PR` | 11.5% | 14.0% | 11.5% | 16.5% | $3,000 flat | — | ✅ |
| Lathrop, CA | `LA` | 11.5% | 10.5% | — | — | $3,000 flat | — | |
| City of Industry, CA | `CI` | — | — | 11.5% | — | — | — | ✅ |
| Lancaster, TX | `LTX` | 11.5% | 10.5% | — | — | $3,000 flat | — | |
| Jacksonville, FL | `JFL` | 11.5% | 10.5% | — | — | $3,000 flat | — | |
| Romeoville, IL | `RIL` | 11.5% | 10.5% | — | — | $3,000 flat | — | ✅ |
| Aberdeen, MD | `AMD` | 11.5% | 10.5% | — | — | $3,000 flat | — | ✅ |
| Kent, WA | `KWA` | 11.5% | 10.5% | — | — | — | — | |
| Portland, OR | `POR` | 11.5% | 10.5% | — | — | — | — | |
| McDonough, GA | `MCDO` | — | 10.5% | — | — | — | 12.5% | |
| Houston, TX | `HTX` (TBC) | — | 10.5% | — | — | — | 12.5% | |
| West Palm Beach, FL | `WPB` (TBC) | — | 10.5% | — | — | — | 12.5% | |

### Notes carried from older sessions

- **SKU↔manifest match confidence** — must be 100% before writing to ERP. If the
  derived SKU isn't found in the ERP, flag for manual review; never auto-write
  uncertain data. (Tracked via the Drive manifests "In ERP?" column.)
- **HDO/Perigold SKU naming** — confirmed: keep the load ID as-is in the SKU
  (e.g. `WYFCIHDO8127`, `WYFHTXPG8133`). Re-confirm before going live.
