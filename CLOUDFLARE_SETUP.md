# Cloudflare Pages setup — Posku

Hosts `index.html` + `diagnostic.html` on `posku.pages.dev`, with `/functions/api/[[path]].js`
proxying ERP calls to `https://viatrading.biz` and injecting the API key from a
server-side secret. Cloudflare Access (Zero Trust) gates the URL behind Google OAuth.

## Dashboard checklist (Alain — one-time setup)

### 1. Create the Pages project

1. Cloudflare dashboard → **Workers & Pages** → **Create application** → **Pages** → **Connect to Git**.
2. Authorize Cloudflare on GitHub if it isn't already, then pick **`alain-cyber/posku`**.
3. Build settings — leave everything blank/default:
   - **Build command**: *(empty)*
   - **Build output directory**: `/`
   - **Production branch**: `main`
4. Save & deploy. First build takes ~30 s. URL: **`https://posku.pages.dev`**.

### 2. Add the API key as a server-side secret

1. Pages project → **Settings** → **Environment variables**.
2. **Production** → **Add variable**:
   - Name: `VIA_API_KEY`
   - Value: *(paste the viatrading staging API key — the same one you've been using locally)*
   - **Encrypt** the value.
3. Click **Save** then **Retry deployment** so the function picks up the secret.

### 3. Gate the site behind Cloudflare Access (Google OAuth + group)

1. Cloudflare dashboard → **Zero Trust** → **Access** → **Applications** → **Add an application** → **Self-hosted**.
2. Application:
   - **Name**: `Posku`
   - **Session duration**: 24 h (or your team's standard)
   - **Application domain**: `posku.pages.dev`
3. Identity providers: enable **Google** (configure once under **Zero Trust → Settings → Authentication** if not already — point Cloudflare at your Google Workspace).
4. Policies → **Add policy**:
   - **Name**: `Viatrading group`
   - **Action**: `Allow`
   - **Include** rule type: **Google Groups** → select the group from the dropdown.
     - If Groups isn't surfacing, fall back to **Emails** and paste the addresses.
5. Save. Visit `https://posku.pages.dev` in an incognito window — Google login challenge should appear.

### 4. (Optional) Custom domain later

Pages → **Custom domains** → add e.g. `posku.viatrading.com`. Cloudflare will give you the
CNAME/AAAA to point at it. Once live, update the Access application domain to the new URL.

### 5. Bind the KV namespace for master rules

Rules (Wayfair + Sam's Club config, club mappings, SKU templates, etc.) are stored in
Cloudflare KV so every user sees the same values. The app falls back to JS defaults if
KV isn't bound yet, so the order doesn't matter — but until you do this, saves will fail.

1. Cloudflare dashboard → **Workers & Pages** → **KV** → **Create a namespace**.
   - **Name**: `posku-rules`
2. Pages project → **Settings** → **Functions** → **KV namespace bindings** → **Add binding**.
   - **Variable name**: `POSKU_RULES` (must be exactly this; the code reads `env.POSKU_RULES`)
   - **KV namespace**: select `posku-rules`
3. Save and **Retry deployment**.

To verify: visit `https://posku.pages.dev/api/rules` directly. You should see
`{"ok":true,"rules":{}}`. If you see an error mentioning KV not bound, the binding name
is wrong.

### 6. Gmail service account (for the "Fetch from inbox" feature)

Lets the app pull labeled emails from a shared workflow mailbox without per-user OAuth.

1. **Google Cloud Console** → **APIs & Services** → **Enable APIs** → search **Gmail API** → Enable.
2. **IAM & Admin** → **Service Accounts** → **Create service account**.
   - **Name**: `posku-gmail-reader`
   - Skip role grants and skip user access.
3. Open the service account → **Keys** → **Add key** → **Create new key** → **JSON**.
   Save the JSON file; you'll need two values from it:
   - `client_email` (e.g. `posku-gmail-reader@your-project.iam.gserviceaccount.com`)
   - `private_key` (the long `-----BEGIN PRIVATE KEY-----...` string)
4. Service account → **Details** tab → enable **Domain-wide delegation**. Copy the
   **Client ID** (numeric, ~21 digits).
5. **Google Workspace admin** (admin.google.com) → **Security** → **Access and data control**
   → **API controls** → **Manage domain-wide delegation** → **Add new**.
   - **Client ID**: the numeric ID from step 4.
   - **OAuth scopes**: `https://www.googleapis.com/auth/gmail.readonly`
   - Authorize.
6. Pages project → **Settings** → **Environment variables** → **Production**, add (encrypt all three):
   - `GMAIL_SA_EMAIL`         = the `client_email` from step 3
   - `GMAIL_SA_PRIVATE_KEY`   = the `private_key` from step 3 (paste the full PEM including
     `BEGIN/END` lines; Cloudflare preserves the newlines)
   - `GMAIL_IMPERSONATE_USER` = the mailbox to read from (e.g. `posku-inbox@viatrading.com`)
7. **Retry deployment**. Visit `/api/gmail/messages?label=posku` to verify — `ok:true`
   with an empty `messages` array means it worked.

### 7. Google Sheets writer (for Sam's manifest → Load Center)

Lets the app append parsed Sam's manifest rows straight to a shared Google Sheet
that's then exported to Excel and imported into the Load Center.

1. **Workspace admin → admin.google.com → Manage domain-wide delegation** → edit
   the existing entry for the `posku-gmail-reader` service account (or add a
   new one with the same Client ID) and include this scope in addition to the
   Gmail one:
   ```
   https://www.googleapis.com/auth/spreadsheets
   ```
   So the OAuth scopes field reads:
   ```
   https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/spreadsheets
   ```
2. Open the destination Google Sheet. **Share** it with the service-account email
   (`posku-gmail-reader@data-warehouse-494801.iam.gserviceaccount.com`) as
   **Editor**. (Domain-wide delegation gets you in as `vickiai@viatrading.com`,
   but explicit share is a safe fallback.)
3. Make sure the sheet has a tab named `Manifest` (or whatever you'll configure)
   with the **16 Load Center columns** in row 1 as headers:
   `SKU, Store, Pallet ID, Item ID, UPC, Description, Main Category, Subcategory,
   Quantity, Appx. EXT Retail, Appx. Unit Retail, Your Price %, Your EXT Price,
   Your Unit Price $, % of Load QTY, % of Load $$`. The function `append`s data
   rows starting after the last filled row, so the headers stay in row 1 forever.
4. Copy the sheet's ID from the URL (the long opaque string between `/d/` and
   `/edit`). Pages → Settings → Environment variables → Production:
   - `SHEETS_SPREADSHEET_ID` = that ID (plaintext)
   - `SHEETS_TAB` = `Manifest` (or your tab name — optional, defaults to `Manifest`)
5. **Retry deployment**.

To verify: from the app, attach a Sam's manifest CSV to a SMS load → click
**Send to Sheet**. Watch the sheet for the rows to appear.

### 8. BigQuery access for the customer typeahead

The invoice draft's customer picker reads `data-warehouse-494801.alain_via_erp.customers_flat`
for typeahead + billing/shipping address pre-fill. The same service account from steps 6 + 7
is used (`GMAIL_SA_*` env vars) but **without** Workspace impersonation — BigQuery uses the
SA acting as itself, so the IAM grants happen in GCP, not in Workspace admin.

Grant two roles to the SA in the GCP IAM:

```bash
SA="posku-gmail-reader@data-warehouse-494801.iam.gserviceaccount.com"  # GMAIL_SA_EMAIL

gcloud projects add-iam-policy-binding data-warehouse-494801 \
  --member="serviceAccount:${SA}" \
  --role="roles/bigquery.jobUser"

bq add-iam-policy-binding \
  --member="serviceAccount:${SA}" \
  --role="roles/bigquery.dataViewer" \
  data-warehouse-494801:alain_via_erp
```

Or via Console:

1. **IAM page** → https://console.cloud.google.com/iam-admin/iam?project=data-warehouse-494801
   - Grant access → New principal = the SA email → Role = **BigQuery Job User**.
2. **BigQuery dataset** → https://console.cloud.google.com/bigquery?project=data-warehouse-494801
   - Open `alain_via_erp` → Sharing → Permissions → Add principal = the SA email
   - Role = **BigQuery Data Viewer**.

No redeploy needed — Pages re-mints the access token on every request and picks up the new
IAM grants immediately.

To verify: open Posku, push a SKU, generate an invoice draft, start typing in the customer
field. Matches should appear within ~300 ms. If the dropdown says `lookup failed — Access
Denied`, the IAM grant didn't take (or you granted to the wrong SA).

This whole step is temporary: the ERP team is expected to expose a proper `/api/customers`
search endpoint at some point, after which Posku will swap to that and the BigQuery IAM
grants become irrelevant.

## How the code is wired

| Concern | Local file mode (`file://`) | Cloudflare Pages mode |
|---|---|---|
| API key | Stored in browser via settings bar | Server-side secret `VIA_API_KEY` |
| API base URL | `https://viatrading.biz` (direct) | `/api/*` (proxied) |
| CORS | Needs Chrome `--disable-web-security` | Same-origin, no flag needed |
| Settings bar | Shows base URL + key fields | Hides them, shows "Cloudflare proxy" pill |

The proxy lives at [`functions/api/[[path]].js`](functions/api/%5B%5Bpath%5D%5D.js). Cloudflare
Pages auto-deploys it on every push to `main`.

## Troubleshooting

- **500 "Server missing VIA_API_KEY"**: env var not set or not redeployed after setting.
- **Page loads but API calls 401/403**: Access policy might not have included your email/group.
- **404 from `/api/...`**: function file isn't picked up — check path is exactly `functions/api/[[path]].js`.
- **CORS error in browser**: shouldn't happen on the Pages URL; if it does, you opened the
  local file by mistake instead of the live URL.
