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
