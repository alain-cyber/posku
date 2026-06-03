// Cloudflare Pages Function — Wayfair (or any) load manifest from BigQuery.
//
// The ERP's manifest line items are mirrored in airbyte_sync.ProductManifest,
// keyed by the load SKU, already carrying the Load Center values (PricePercent,
// YourEXTPrice, AppxEXTRetail, …). This returns a load's lines mapped to the
// Posku LC_COLUMNS shape, plus the load name from alain_via_erp.products_flat —
// far cleaner than re-parsing the Drive manifest file.
//
// Request:  GET /api/wayfair/manifest?sku=<load SKU, e.g. WYFPRLQ48979>
// Response: { ok, sku, name, rows: [{ ...LC columns }] }   (% of load computed client-side)
//
// Same SA auth as customers/search.js (BigQuery jobUser + dataViewer).

const SCOPE = 'https://www.googleapis.com/auth/bigquery.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const BIGQUERY_BASE = 'https://bigquery.googleapis.com/bigquery/v2';
const DEFAULT_PROJECT_ID = 'data-warehouse-494801';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'GET') return json(405, { ok: false, error: 'Method not allowed' });

  const cfg = {
    saEmail:    env.GMAIL_SA_EMAIL,
    privateKey: env.GMAIL_SA_PRIVATE_KEY,
    projectId:  env.BIGQUERY_PROJECT_ID || DEFAULT_PROJECT_ID,
  };
  if (!cfg.saEmail || !cfg.privateKey) return json(500, { ok: false, error: 'Missing GMAIL_SA_* env vars' });

  const sku = (new URL(request.url).searchParams.get('sku') || '').trim().toUpperCase();
  if (!sku) return json(400, { ok: false, error: 'sku required' });

  let token;
  try { token = await mintAccessToken(cfg); }
  catch (err) { return json(502, { ok: false, error: `Auth failed: ${err.message}` }); }

  const P = cfg.projectId;
  // One query: the load name from products_flat + every manifest line.
  const sql = `
    SELECT
      (SELECT product_name FROM \`${P}.alain_via_erp.products_flat\` pf
        WHERE UPPER(pf.sku) = @sku LIMIT 1) AS load_name,
      PalletID, UPC, Description, Category, Subcategory, Quantity,
      AppxEXTRetail, AppxUnitRetail, PricePercent, YourEXTPrice, YourUnitPrice, ModelNumber
    FROM \`${P}.airbyte_sync.ProductManifest\`
    WHERE IFNULL(_ab_cdc_deleted_at,'') = '' AND UPPER(SKU) = @sku
    ORDER BY PalletID, id
    LIMIT 20000`;

  let res, j;
  try {
    res = await fetch(`${BIGQUERY_BASE}/projects/${P}/queries`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: sql, useLegacySql: false, parameterMode: 'NAMED', timeoutMs: 20000,
        queryParameters: [{ name: 'sku', parameterType: { type: 'STRING' }, parameterValue: { value: sku } }],
      }),
    });
    j = await res.json();
  } catch (err) {
    return json(502, { ok: false, error: `BigQuery fetch failed: ${err.message}` });
  }
  if (!res.ok || j.error) return json(res.status || 502, { ok: false, error: j.error?.message || `BigQuery ${res.status}` });

  const fields = (j.schema?.fields || []).map(f => f.name);
  const idx = Object.fromEntries(fields.map((n, i) => [n, i]));
  const cell = (r, n) => r.f[idx[n]]?.v ?? null;
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

  let name = '';
  const rows = (j.rows || []).map(r => {
    if (!name) name = cell(r, 'load_name') || '';
    return {
      SKU:                 sku,
      Store:               'WYF',
      'Pallet ID':         cell(r, 'PalletID') || '',
      'Item ID':           cell(r, 'ModelNumber') || '',
      UPC:                 cell(r, 'UPC') || '',
      Description:         cell(r, 'Description') || '',
      'Main Category':     cell(r, 'Category') || '',
      Subcategory:         cell(r, 'Subcategory') || '',
      Quantity:            num(cell(r, 'Quantity')) || 0,
      'Appx. EXT Retail':  num(cell(r, 'AppxEXTRetail')),
      'Appx. Unit Retail': num(cell(r, 'AppxUnitRetail')),
      // PricePercent is stored as a percent (e.g. 11.5) → fraction for the sheet.
      'Your Price %':      (num(cell(r, 'PricePercent')) != null) ? num(cell(r, 'PricePercent')) / 100 : null,
      'Your EXT Price':    num(cell(r, 'YourEXTPrice')),
      'Your Unit Price $': num(cell(r, 'YourUnitPrice')),
      '% of Load QTY':     null,   // filled client-side
      '% of Load $$':      null,
    };
  });

  return json(200, { ok: true, sku, name, rows });
}

// ── auth helpers (mirror customers/search.js) ────────────────────────────────
function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
async function mintAccessToken(cfg) {
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: cfg.saEmail, scope: SCOPE, aud: TOKEN_URL, exp: now + 3600, iat: now };
  const enc = (obj) => b64urlEncode(new TextEncoder().encode(JSON.stringify(obj)));
  const signingInput = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc(claims)}`;
  const key = await importPrivateKey(cfg.privateKey);
  const sig = await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, key, new TextEncoder().encode(signingInput));
  const jwt = `${signingInput}.${b64urlEncode(new Uint8Array(sig))}`;
  const res = await fetch(TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  if (!res.ok) throw new Error(`token exchange ${res.status}: ${await res.text()}`);
  const j = await res.json();
  if (!j.access_token) throw new Error('no access_token in response');
  return j.access_token;
}
async function importPrivateKey(pem) {
  const clean = pem.replace(/\\n/g, '\n').replace(/-----BEGIN [A-Z ]+-----/g, '').replace(/-----END [A-Z ]+-----/g, '').replace(/\s+/g, '');
  const bytes = Uint8Array.from(atob(clean), c => c.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', bytes.buffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}
function b64urlEncode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
