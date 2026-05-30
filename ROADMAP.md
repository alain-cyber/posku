# Posku Roadmap

## TODO — revisit
- **Real Via Trading + Vicki Intelligence logos in sidebar.** First attempt
  (commit `b44b12a`, reverted by `bcb05bc`) built both as inline SVG —
  Vicki sparkle was close to the brand but the Via Trading mark was
  approximate. The official PNG (`Viatrading-white-600.png`, Drive id
  `1-f7GtFBGnEe7AsdA6dIXdmWVS0ZIiRcz`) is too big to inline through chat
  tools. Next step: commit the PNG to `assets/`, replace the placeholder
  marks with `<img>` tags, and rebuild the Vicki sparkle from a high-res
  source (or get the brand SVG from the design team).

## Current state (POC)
- Static `index.html` running locally
- User pastes/drops Wayfair load emails → parser generates SKUs
- Manual "Push to ERP" via viatrading API from the browser
- CORS bypass via Chrome `--disable-web-security` for testing
- Dedicated API user `posku_api` (id 179) for audit trail
- Branch: `claude/charming-newton-Z1q4t`

## Next phases

### Phase 1 — Cloudflare hosting (in progress)
- ✅ `functions/api/[[path]].js` Pages Function proxies `/api/*` → `viatrading.biz`, injects `VIA_API_KEY` secret
- ✅ `index.html` + `diagnostic.html` auto-detect local-file vs hosted and swap API client accordingly
- ⏳ Dashboard steps (one-time): connect repo, set `VIA_API_KEY` env var, enable Cloudflare Access — see `CLOUDFLARE_SETUP.md`
- 🔜 Cloudflare Access (Zero Trust) — Google OAuth, viatrading group allowlist

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

## Wayfair markup table (from Alain 2026-05-28)

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

**To do tomorrow when the CSVs arrive:**
- Add `HTX` + `WPB` to `SUPPLIERS.WYF.fobIds` / `fobNames` / `locations` (confirm codes with user)
- Add `Perigold` (proposed code `PG`) to `SUPPLIERS.WYF.types` with detection patterns
- Salvage parser: emit one row at $3,000, no line items
- Build the actual line-item parser for LQ / A / QC / HDO / Perigold using the markup table above

## Training items (carried from session 2026-05-28)
- **Sam's manifest → product fields**: when manifest is attached at SKU-push, populate
  `qty`, `retail_price`, `retail_price_per_unit`, `price_per_unit` using
  `qty = sum(Qty)`, `retail_price = sum(Appx. EXT Retail)`,
  `retail_price_per_unit = retail / qty`, `price_per_unit = sum(Your EXT) / qty`.
  User will train on exact field names + math next session.
- **Wayfair manifest → product fields**: at Drive-fetch time, also push `pallets_qty`,
  `qty`, `retail_price`, `retail_price_per_unit`, `price_per_unit`, plus probably
  `price_per_pallet` and a couple others. Confirm full set with user.
- **HDO/Perigold SKU naming** — confirmed for now to keep the load ID as-is in the
  SKU (e.g. `WYFCIHDO8127`, `WYFHTXPG8133`). Re-confirm with user before going live.
- **SKU↔manifest match confidence** — must be 100% before writing to ERP. If the
  derived SKU isn't found in the ERP, flag for manual review; never auto-write
  uncertain data.
- **Wayfair fetch date filter** — both "SKU created on" and "manifest uploaded on"
  options will be exposed. Default to "uploaded today" since that's the trigger
  most days.
