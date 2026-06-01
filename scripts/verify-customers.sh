#!/usr/bin/env bash
# Verify the native ERP customer endpoints before we recode Posku's typeahead
# off BigQuery. Run this ONCE against TEST with the staging api-key, then paste
# the output back so we can lock the field mapping.
#
#   POSKU_KEY=<your viatrading.biz api-key> ./scripts/verify-customers.sh "Jane"
#
# Optional args/env:
#   $1            search term for full_name (default: "a")
#   POSKU_BASE    base URL (default: https://viatrading.biz  — the TEST env)
#   POSKU_EMAIL   if set, also runs an email= search
#   POSKU_PHONE   if set, also runs a phone= search
#
# Needs: curl, jq. Read-only (GETs only) — safe to run against TEST.
set -euo pipefail

BASE="${POSKU_BASE:-https://viatrading.biz}"
TERM="${1:-a}"
KEY="${POSKU_KEY:-}"

if [[ -z "$KEY" ]]; then
  echo "ERROR: set POSKU_KEY to the viatrading.biz api-key (Cloudflare BIZ_API)." >&2
  exit 1
fi
command -v jq >/dev/null || { echo "ERROR: jq not installed." >&2; exit 1; }

hdr=(-sS -H "api-key: $KEY" -H "Accept: application/json")

echo "============================================================"
echo " BASE: $BASE"
echo "============================================================"

run_search() {  # $1=param  $2=value
  local param="$1" val="$2"
  local url="$BASE/api/customers?is_customer=2,3&context=order_search&limit=5&${param}=$(jq -rn --arg v "$val" '$v|@uri')"
  echo
  echo ">>> SEARCH by ${param}='${val}'"
  echo "    GET $url"
  local body; body="$(curl "${hdr[@]}" "$url")" || { echo "    (request failed)"; return 1; }
  echo "--- data[0] keys (what search returns; expect NO addresses) ---"
  echo "$body" | jq -r '(.data // .)[0] // {} | keys' 2>/dev/null || echo "$body" | head -c 800
  echo "--- data[0] sample (values) ---"
  echo "$body" | jq '(.data // .)[0] // .' 2>/dev/null | head -40
  # echo the first id so the caller can chain the detail fetch
  echo "$body" | jq -r '((.data // .)[0] // {}).id // empty' 2>/dev/null
}

# 1) full_name search — capture the first id
FIRST_ID="$(run_search full_name "$TERM" | tail -n1)"
[[ -n "${POSKU_EMAIL:-}" ]] && run_search email "$POSKU_EMAIL" >/dev/null || true
[[ -n "${POSKU_PHONE:-}" ]] && run_search phone "$POSKU_PHONE" >/dev/null || true

# 2) detail fetch by id — this is where addresses should appear
if [[ -n "$FIRST_ID" ]]; then
  echo
  echo ">>> DETAIL  GET $BASE/api/customers/$FIRST_ID"
  detail="$(curl "${hdr[@]}" "$BASE/api/customers/$FIRST_ID")"
  echo "--- data[0] keys (look for billingAddressDetails / defaultAddressDetails / shippingAddressDetails) ---"
  echo "$detail" | jq -r '(.data // .)[0] // {} | keys'
  echo "--- billingAddressDetails[0] keys ---"
  echo "$detail" | jq '(.data // .)[0].billingAddressDetails[0] // "MISSING"'
  echo "--- defaultAddressDetails[0] keys ---"
  echo "$detail" | jq '(.data // .)[0].defaultAddressDetails[0] // "MISSING"'
else
  echo
  echo "!! No id from search — can't run the detail fetch. Check search shape above."
fi

echo
echo "============================================================"
echo " Done. Paste everything above back to finalize the mapping."
echo "============================================================"
