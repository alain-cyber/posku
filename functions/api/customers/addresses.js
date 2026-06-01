// Cloudflare Pages Function — customer shipping addresses via BigQuery.
//
// Returns the DISTINCT shipping addresses on file for a customer so the invoice
// flow can offer a "ship to" picker when there's more than one. Sourced from
// the customer_addresses_view mirror (the ERP detail endpoint is gated behind
// VIEW_CUSTOMERS). Same SA auth as customers/search.js — needs BigQuery
// jobUser + dataViewer on the SA.
//
// Request:  GET /api/customers/addresses?id=<customer_id>
// Response: { ok, shipping: [{ ...addressObj, _label }], query }
//   addressObj matches the shape search.js builds (drop-in for order payload).

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

  const id = parseInt(new URL(request.url).searchParams.get('id') || '', 10);
  if (!id) return json(400, { ok: false, error: 'id (customer_id) required' });

  let token;
  try { token = await mintAccessToken(cfg); }
  catch (err) { return json(502, { ok: false, error: `Auth failed: ${err.message}` }); }

  // GROUP BY all columns = distinct addresses; drop per-order snapshots
  // (is_order=1). Shipping only — billing comes from the search row already.
  const sql = `
    SELECT company_name, first_name, last_name, address, address_more,
           city, state_name, state_code, zip, country, commercial, liftgate
    FROM \`${cfg.projectId}.airbyte_sync.customer_addresses_view\`
    WHERE customer_id = @id AND IFNULL(is_order, 0) = 0 AND address_type = 'shipping'
      AND IFNULL(address, '') != ''
    GROUP BY company_name, first_name, last_name, address, address_more,
             city, state_name, state_code, zip, country, commercial, liftgate
    ORDER BY company_name, address
    LIMIT 50
  `;
  const body = {
    query: sql,
    useLegacySql: false,
    parameterMode: 'NAMED',
    queryParameters: [{ name: 'id', parameterType: { type: 'INT64' }, parameterValue: { value: String(id) } }],
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

  const fields = (j.schema?.fields || []).map(f => f.name);
  const shipping = (j.rows || []).map(r => {
    const o = {};
    fields.forEach((name, i) => { o[name] = r.f[i]?.v ?? null; });
    const country = (o.country || '').toLowerCase();
    const addr = {
      first_name:  o.first_name || '',
      last_name:   o.last_name || '',
      companyName: o.company_name || '',
      address:     o.address || '',
      addressMore: o.address_more || '',
      city:        o.city || '',
      stateName:   o.state_name || '',
      state:       o.state_code || '',
      zip:         o.zip || '',
      countryCode: country.includes('united states') || country === 'us' ? 'US' : (o.state_code ? 'US' : ''),
      phoneNumber: '',
      commercial:  Number(o.commercial) || 0,
      liftgate:    Number(o.liftgate) || 0,
    };
    addr._label = [
      addr.companyName,
      [addr.address, addr.city, [addr.state, addr.zip].filter(Boolean).join(' ')].filter(Boolean).join(', '),
    ].filter(Boolean).join(' — ');
    return addr;
  });

  return json(200, { ok: true, shipping, query: id });
}

// ── auth helpers (mirror customers/search.js — SA acting as itself) ──────────
function json(status, body) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
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
