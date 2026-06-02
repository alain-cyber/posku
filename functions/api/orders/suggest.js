// Cloudflare Pages Function — order suggestions + order_id→id resolution (BigQuery).
//
// Backs the "append SKU to an existing invoice" flow:
//   GET /api/orders/suggest?customer_id=<user_id>  → open orders for that
//        customer that contain SMS SKUs, newest first (append candidates).
//   GET /api/orders/suggest?order_id=<customer-facing #>  → resolve to the
//        internal orders.id needed for GET/PUT /api/orders/{id}.
//
// Read-only, from the airbyte_sync mirror (the ERP order search isn't exposed).
// Same SA auth as customers/search.js (BigQuery jobUser + dataViewer).

const SCOPE = 'https://www.googleapis.com/auth/bigquery.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const BIGQUERY_BASE = 'https://bigquery.googleapis.com/bigquery/v2';
const DEFAULT_PROJECT_ID = 'data-warehouse-494801';
// Open / still-appendable statuses (orders_status): 1 Pending, 2 Being Reviewed,
// 5 Waiting Payment, 7 Quote. (3 Released, 4 Shipped, 6 Canceled are excluded.)
const OPEN_STATUSES = '1,2,5,7';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'GET') return json(405, { ok: false, error: 'Method not allowed' });

  const cfg = {
    saEmail:    env.GMAIL_SA_EMAIL,
    privateKey: env.GMAIL_SA_PRIVATE_KEY,
    projectId:  env.BIGQUERY_PROJECT_ID || DEFAULT_PROJECT_ID,
  };
  if (!cfg.saEmail || !cfg.privateKey) return json(500, { ok: false, error: 'Missing GMAIL_SA_* env vars' });

  const url = new URL(request.url);
  const customerId = parseInt(url.searchParams.get('customer_id') || '', 10);
  const orderId = parseInt(url.searchParams.get('order_id') || '', 10);
  if (!customerId && !orderId) return json(400, { ok: false, error: 'customer_id or order_id required' });

  let token;
  try { token = await mintAccessToken(cfg); }
  catch (err) { return json(502, { ok: false, error: `Auth failed: ${err.message}` }); }

  const P = cfg.projectId;
  let sql, params;
  if (orderId) {
    // Resolve customer-facing order_id → internal id.
    sql = `SELECT id, order_id, orders_status_id, user_id, grand_total
           FROM \`${P}.airbyte_sync.orders\`
           WHERE order_id = @oid AND IFNULL(_ab_cdc_deleted_at,'') = ''
           LIMIT 1`;
    params = [{ name: 'oid', parameterType: { type: 'INT64' }, parameterValue: { value: String(orderId) } }];
  } else {
    // Open orders for the customer that contain SMS SKUs, newest first.
    sql = `
      SELECT o.id, o.order_id, o.orders_status_id, o.grand_total, o.created,
             STRING_AGG(DISTINCT li.product_sku, ', ' ORDER BY li.product_sku) AS skus
      FROM \`${P}.airbyte_sync.orders\` o
      JOIN \`${P}.airbyte_sync.orders_line_items\` li
        ON li.order_id = o.order_id AND IFNULL(li._ab_cdc_deleted_at,'') = ''
      WHERE o.user_id = @cust AND IFNULL(o._ab_cdc_deleted_at,'') = ''
        AND o.orders_status_id IN (${OPEN_STATUSES})
      GROUP BY o.id, o.order_id, o.orders_status_id, o.grand_total, o.created
      HAVING COUNTIF(UPPER(li.product_sku) LIKE 'SMS%') > 0
      ORDER BY o.created DESC
      LIMIT 15`;
    params = [{ name: 'cust', parameterType: { type: 'INT64' }, parameterValue: { value: String(customerId) } }];
  }

  let res, j;
  try {
    res = await fetch(`${BIGQUERY_BASE}/projects/${P}/queries`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: sql, useLegacySql: false, parameterMode: 'NAMED', queryParameters: params, timeoutMs: 8000 }),
    });
    j = await res.json();
  } catch (err) {
    return json(502, { ok: false, error: `BigQuery fetch failed: ${err.message}` });
  }
  if (!res.ok || j.error) return json(res.status || 502, { ok: false, error: j.error?.message || `BigQuery ${res.status}` });

  const fields = (j.schema?.fields || []).map(f => f.name);
  const rows = (j.rows || []).map(r => {
    const o = {}; fields.forEach((n, i) => { o[n] = r.f[i]?.v ?? null; }); return o;
  });
  const STATUS = { 1: 'Pending', 2: 'Being Reviewed', 3: 'Released', 4: 'Shipped', 5: 'Waiting Payment', 6: 'Canceled', 7: 'Quote' };

  if (orderId) {
    if (!rows.length) return json(200, { ok: true, resolved: null });
    const o = rows[0];
    return json(200, { ok: true, resolved: { id: Number(o.id), order_id: Number(o.order_id), status: STATUS[o.orders_status_id] || o.orders_status_id, status_id: Number(o.orders_status_id), user_id: Number(o.user_id) } });
  }
  const suggestions = rows.map(o => ({
    id: Number(o.id),
    order_id: Number(o.order_id),
    status: STATUS[o.orders_status_id] || String(o.orders_status_id),
    status_id: Number(o.orders_status_id),
    grand_total: o.grand_total != null ? Number(o.grand_total) : null,
    created: o.created,
    skus: o.skus || '',
  }));
  return json(200, { ok: true, suggestions });
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
