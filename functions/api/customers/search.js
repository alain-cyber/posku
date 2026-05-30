// Cloudflare Pages Function — Customer search via BigQuery (TEMP).
//
// Bridges Posku's invoice flow to the customers_flat warehouse table so the
// invoice draft can pre-fill customer + billing address from a typeahead.
// Marked TEMP because the ERP team is expected to expose a proper
// /api/customers search endpoint later — at that point this whole file gets
// replaced with a simple pass-through.
//
// Uses the same GMAIL_SA_* private key the Gmail/Drive/Sheets functions use,
// but does NOT impersonate a Workspace user (BigQuery auth is the SA acting
// as itself, no DWD). For this to work the SA email needs:
//   - roles/bigquery.dataViewer on data-warehouse-494801.alain_via_erp
//   - roles/bigquery.jobUser    on data-warehouse-494801
// Granted via GCP IAM (Workspace admin scopes are NOT involved here).
//
// Request:  GET /api/customers/search?q=<partial email or name>&max=<N>
// Response: { ok, customers: [{ customer_id, email, name, company, phone,
//             billing_address, shipping_address }], query }

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
  const missing = [];
  if (!cfg.saEmail)    missing.push('GMAIL_SA_EMAIL');
  if (!cfg.privateKey) missing.push('GMAIL_SA_PRIVATE_KEY');
  if (missing.length) return json(500, { ok: false, error: `Missing env var(s): ${missing.join(', ')}` });

  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  const max = Math.min(parseInt(url.searchParams.get('max') || '12', 10) || 12, 50);
  // Cheap guard: don't burn a BigQuery slot on every keystroke. Client should
  // debounce too, but this is the floor.
  if (q.length < 2) return json(200, { ok: true, customers: [], query: q });

  let token;
  try { token = await mintAccessToken(cfg); }
  catch (err) { return json(502, { ok: false, error: `Auth failed: ${err.message}` }); }

  // Rank exact-email > email-prefix > email-contains > name-prefix > name-contains > company-contains.
  // Tie-break by recency of last order so frequent customers float first.
  const sql = `
    SELECT
      customer_id, primary_email, customer_full_name, company_name,
      first_name, last_name, phone,
      billing_address, billing_address_more, billing_city, billing_state,
      billing_zip, billing_country, billing_country_code,
      CASE
        WHEN LOWER(IFNULL(primary_email,'')) = @q THEN 0
        WHEN STARTS_WITH(LOWER(IFNULL(primary_email,'')), @q) THEN 1
        WHEN CONTAINS_SUBSTR(LOWER(IFNULL(primary_email,'')), @q) THEN 2
        WHEN STARTS_WITH(LOWER(IFNULL(customer_full_name,'')), @q) THEN 3
        WHEN CONTAINS_SUBSTR(LOWER(IFNULL(customer_full_name,'')), @q) THEN 4
        WHEN CONTAINS_SUBSTR(LOWER(IFNULL(company_name,'')), @q) THEN 5
        ELSE 99
      END AS _rank
    FROM \`${cfg.projectId}.alain_via_erp.customers_flat\`
    WHERE is_active = TRUE
      AND (
        CONTAINS_SUBSTR(LOWER(IFNULL(primary_email, '')), @q)
        OR CONTAINS_SUBSTR(LOWER(IFNULL(customer_full_name, '')), @q)
        OR CONTAINS_SUBSTR(LOWER(IFNULL(company_name, '')), @q)
      )
    ORDER BY _rank, last_order_date DESC NULLS LAST
    LIMIT @max
  `;

  const body = {
    query: sql,
    useLegacySql: false,
    parameterMode: 'NAMED',
    queryParameters: [
      { name: 'q',   parameterType: { type: 'STRING' }, parameterValue: { value: q.toLowerCase() } },
      { name: 'max', parameterType: { type: 'INT64' },  parameterValue: { value: String(max) } },
    ],
    timeoutMs: 8000,
  };

  let res, j;
  try {
    res = await fetch(`${BIGQUERY_BASE}/projects/${cfg.projectId}/queries`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    j = await res.json();
  } catch (err) {
    return json(502, { ok: false, error: `BigQuery fetch failed: ${err.message}` });
  }
  if (!res.ok || j.error) {
    return json(res.status || 502, { ok: false, error: j.error?.message || `BigQuery ${res.status}` });
  }

  // Shape rows into objects ready to drop into the invoice POST body. The
  // customers_flat table has no shipping_* columns — default ship-to = billing.
  const fields = (j.schema?.fields || []).map(f => f.name);
  const customers = (j.rows || []).map(r => {
    const obj = {};
    fields.forEach((name, i) => { obj[name] = r.f[i]?.v ?? null; });
    const billing = {
      first_name:  obj.first_name || '',
      last_name:   obj.last_name || '',
      companyName: obj.company_name || '',
      address:     obj.billing_address || '',
      addressMore: obj.billing_address_more || '',
      city:        obj.billing_city || '',
      stateName:   obj.billing_state || '',
      state:       '',
      zip:         obj.billing_zip || '',
      countryCode: obj.billing_country_code || 'US',
      phoneNumber: obj.phone || '',
    };
    return {
      customer_id:      Number(obj.customer_id),
      email:            obj.primary_email || '',
      name:             obj.customer_full_name || '',
      company:          obj.company_name || '',
      phone:            obj.phone || '',
      billing_address:  billing,
      shipping_address: { ...billing, commercial: 0, liftgate: 0 },
    };
  });

  return json(200, { ok: true, customers, query: q });
}

// ── Helpers (mirror gmail/drive funcs but no DWD impersonation) ──────────────

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function mintAccessToken(cfg) {
  const now = Math.floor(Date.now() / 1000);
  // No `sub` claim — BigQuery uses the SA as itself, not as a Workspace user.
  const claims = { iss: cfg.saEmail, scope: SCOPE, aud: TOKEN_URL, exp: now + 3600, iat: now };
  const enc = (obj) => b64urlEncode(new TextEncoder().encode(JSON.stringify(obj)));
  const signingInput = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc(claims)}`;
  const key = await importPrivateKey(cfg.privateKey);
  const sig = await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, key, new TextEncoder().encode(signingInput));
  const jwt = `${signingInput}.${b64urlEncode(new Uint8Array(sig))}`;
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
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
