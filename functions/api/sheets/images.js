// Cloudflare Pages Function — Wayfair item-image master list.
//
// Reads the "Wayfair item id → image link" master spreadsheet and returns it
// as a { SPRID: url } map. The client uses it to fill in missing
// "Product Image URL" cells before pushing a manifest to the Load Center
// sheet. Same SA + DWD auth as sheets/append.js — the impersonated user
// (GMAIL_IMPERSONATE_USER) must have at least view access to the master
// spreadsheet.
//
// Request:  GET /api/sheets/images
// Response: { ok, count, map: { "GBIG4302.143014124": "https://…jpg", … } }

const SCOPE      = 'https://www.googleapis.com/auth/spreadsheets';
const TOKEN_URL  = 'https://oauth2.googleapis.com/token';
const SHEETS_URL = 'https://sheets.googleapis.com/v4/spreadsheets';

// Master list: columns A = Sprid (Wayfair item id), B = Picture (image URL).
const MASTER_SPREADSHEET_ID = '12jr8MC_Smz5ERaTMQ7bBBAJsz0zAB-84iDrywPdonNg';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'GET') return json(405, { ok: false, error: 'Method not allowed' });

  const cfg = {
    saEmail:     env.GMAIL_SA_EMAIL,
    privateKey:  env.GMAIL_SA_PRIVATE_KEY,
    impersonate: env.GMAIL_IMPERSONATE_USER,
  };
  const missing = Object.entries(cfg).filter(([_, v]) => !v).map(([k]) => k);
  if (missing.length) {
    const map = { saEmail: 'GMAIL_SA_EMAIL', privateKey: 'GMAIL_SA_PRIVATE_KEY', impersonate: 'GMAIL_IMPERSONATE_USER' };
    return json(500, { ok: false, error: `Missing env var(s): ${missing.map(k => map[k]).join(', ')}` });
  }

  let token;
  try { token = await mintAccessToken(cfg); }
  catch (err) { return json(502, { ok: false, error: `Auth failed: ${err.message}` }); }

  const url = `${SHEETS_URL}/${MASTER_SPREADSHEET_ID}/values/${encodeURIComponent('A:B')}?majorDimension=ROWS`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    return json(res.status, { ok: false, error: `Master sheet read ${res.status}: ${await res.text()}` });
  }
  const data = await res.json();
  const rows = data.values || [];
  const map = {};
  for (const r of rows) {
    const id = String(r?.[0] || '').trim().toUpperCase();
    const link = String(r?.[1] || '').trim();
    // Skip the header row and anything that isn't an id → http(s) link pair.
    if (!id || id === 'SPRID' || !/^https?:\/\//i.test(link)) continue;
    map[id] = link;
  }
  return new Response(JSON.stringify({ ok: true, count: Object.keys(map).length, map }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=600' },
  });
}

// ── Helpers (same JWT/RS256 flow as sheets/append.js) ────────────────────────

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function mintAccessToken(cfg) {
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: cfg.saEmail, scope: SCOPE, aud: TOKEN_URL, exp: now + 3600, iat: now, sub: cfg.impersonate };
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
