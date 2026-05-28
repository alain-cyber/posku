// Cloudflare Pages Function — Google Sheets appender.
//
// Appends rows to a configured Google Sheet, using the same SA + DWD setup
// as the Gmail integration. The user (Workspace admin) must add the
// spreadsheets scope to the delegation: https://www.googleapis.com/auth/spreadsheets
//
// Required Pages env vars (in addition to the GMAIL_* trio):
//   SHEETS_SPREADSHEET_ID  — the Sheet's ID (the long opaque string in the URL)
//   SHEETS_TAB             — optional, defaults to "Manifest"
//
// Request:  POST /api/sheets/append
//   body: { values: [[col1, col2, ...], ...], tab?: "Manifest" }
// Response: { ok: true, updatedRange, updatedRows }

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
  catch { return json(400, { ok: false, error: 'Body must be JSON { values: [[...]], tab? }' }); }
  const values = Array.isArray(body.values) ? body.values : null;
  if (!values || !values.length) return json(400, { ok: false, error: 'values must be a non-empty 2D array' });
  const tab = body.tab || cfg.defaultTab;

  let accessToken;
  try {
    accessToken = await mintAccessToken(cfg);
  } catch (err) {
    return json(502, { ok: false, error: `Auth failed: ${err.message}` });
  }

  // Sheets API: append to the named tab. valueInputOption=USER_ENTERED makes
  // Sheets interpret strings like "$4.25" / "25.00%" as numbers when possible.
  const range = encodeURIComponent(tab);
  const url = `${SHEETS_URL}/${cfg.sheetId}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ values }),
  });
  if (!res.ok) {
    return json(res.status, { ok: false, error: `Sheets append ${res.status}: ${await res.text()}` });
  }
  const data = await res.json();
  return json(200, {
    ok: true,
    updatedRange: data.updates?.updatedRange,
    updatedRows:  data.updates?.updatedRows,
    tab,
  });
}

// ── Helpers (same JWT/RS256 flow as gmail/messages.js) ───────────────────────

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function mintAccessToken(cfg) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss:   cfg.saEmail,
    scope: SCOPE,
    aud:   TOKEN_URL,
    exp:   now + 3600,
    iat:   now,
    sub:   cfg.impersonate,
  };
  const header = { alg: 'RS256', typ: 'JWT' };
  const enc = (obj) => b64urlEncode(new TextEncoder().encode(JSON.stringify(obj)));
  const signingInput = `${enc(header)}.${enc(claims)}`;
  const key = await importPrivateKey(cfg.privateKey);
  const sig = await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, key, new TextEncoder().encode(signingInput));
  const jwt = `${signingInput}.${b64urlEncode(new Uint8Array(sig))}`;
  const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`token exchange ${res.status}: ${await res.text()}`);
  const j = await res.json();
  if (!j.access_token) throw new Error('no access_token in response');
  return j.access_token;
}

async function importPrivateKey(pem) {
  const clean = pem
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN [A-Z ]+-----/g, '')
    .replace(/-----END [A-Z ]+-----/g, '')
    .replace(/\s+/g, '');
  const bytes = Uint8Array.from(atob(clean), c => c.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', bytes.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

function b64urlEncode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
