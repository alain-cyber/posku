// Cloudflare Pages Function — write the canonical Load-Center header row to
// row 1 of the configured Sheet/tab. Overwrites whatever was there.
//
// POST /api/sheets/init-headers  body: { headers: [...], tab?: "Manifest" }

const SCOPE      = 'https://www.googleapis.com/auth/spreadsheets';
const TOKEN_URL  = 'https://oauth2.googleapis.com/token';
const SHEETS_URL = 'https://sheets.googleapis.com/v4/spreadsheets';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });

  const cfg = {
    saEmail:     env.GMAIL_SA_EMAIL,
    privateKey:  env.GMAIL_SA_PRIVATE_KEY,
    impersonate: env.GMAIL_IMPERSONATE_USER,
    sheetId:     env.SHEETS_SPREADSHEET_ID,
    defaultTab:  env.SHEETS_TAB || 'Manifest',
  };
  const missing = Object.entries(cfg).filter(([k, v]) => !v && k !== 'defaultTab').map(([k]) => k);
  if (missing.length) {
    const map = { saEmail: 'GMAIL_SA_EMAIL', privateKey: 'GMAIL_SA_PRIVATE_KEY', impersonate: 'GMAIL_IMPERSONATE_USER', sheetId: 'SHEETS_SPREADSHEET_ID' };
    return json(500, { ok: false, error: `Missing Pages env var(s): ${missing.map(k => map[k]).join(', ')}` });
  }

  let body;
  try { body = await request.json(); }
  catch { return json(400, { ok: false, error: 'Body must be JSON { headers: [...], tab? }' }); }
  const headers = Array.isArray(body.headers) ? body.headers : null;
  if (!headers || !headers.length) return json(400, { ok: false, error: 'headers must be a non-empty array of strings' });
  const tab = body.tab || cfg.defaultTab;

  let accessToken;
  try { accessToken = await mintAccessToken(cfg); }
  catch (err) { return json(502, { ok: false, error: `Auth failed: ${err.message}` }); }

  // Overwrite row 1 with exactly the headers we want. Range = Manifest!A1:<col><1>.
  const lastCol = colLetter(headers.length);
  const range = `${tab}!A1:${lastCol}1`;
  const url = `${SHEETS_URL}/${cfg.sheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [headers] }),
  });
  if (!res.ok) {
    return json(res.status, { ok: false, error: `Sheets write ${res.status}: ${await res.text()}` });
  }
  const data = await res.json();
  return json(200, { ok: true, updatedRange: data.updatedRange, tab, headerCount: headers.length });
}

// Convert a 1-based column index to A1 letter (1→A, 26→Z, 27→AA, …)
function colLetter(n) {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

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
