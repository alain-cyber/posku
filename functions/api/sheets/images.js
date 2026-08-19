// Cloudflare Pages Function — Wayfair item-image master lookup.
//
// The master sheet ("Sprid" → "Picture") is ~195K rows, far too big to pull
// wholesale into a function or the browser. Instead the client POSTs just the
// item ids that need images and we run a FILTERED query against Google's
// gviz endpoint (server-side WHERE at Google), returning only the matches.
// Falls back to a full values.get + filter if gviz is unavailable.
//
// Auth: same SA + DWD as sheets/append.js — the impersonated user must have
// at least view access to the master spreadsheet.
//
// Request:  POST /api/sheets/images   body: { ids: ["GBIG4302.143014124", …] }
// Response: { ok, requested, matched, map: { ID: url, … } }

const SCOPE      = 'https://www.googleapis.com/auth/spreadsheets';
const TOKEN_URL  = 'https://oauth2.googleapis.com/token';
const SHEETS_URL = 'https://sheets.googleapis.com/v4/spreadsheets';

// Master list: columns A = Sprid (Wayfair item id), B = Picture (image URL).
const MASTER_SPREADSHEET_ID = '12jr8MC_Smz5ERaTMQ7bBBAJsz0zAB-84iDrywPdonNg';
const MAX_IDS = 500;

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') return json(405, { ok: false, error: 'POST { ids: [...] }' });

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

  let body;
  try { body = await request.json(); }
  catch { return json(400, { ok: false, error: 'Body must be JSON { ids: [...] }' }); }
  const ids = [...new Set((Array.isArray(body.ids) ? body.ids : [])
    .map(s => String(s || '').trim().toUpperCase())
    // Sprids are alphanumeric + dot — reject anything else so ids can be
    // embedded in the gviz query safely.
    .filter(s => s && s.length <= 40 && /^[A-Z0-9.\-]+$/.test(s)))].slice(0, MAX_IDS);
  if (!ids.length) return json(200, { ok: true, requested: 0, matched: 0, map: {} });

  let token;
  try { token = await mintAccessToken(cfg); }
  catch (err) { return json(502, { ok: false, error: `Auth failed: ${err.message}` }); }

  // Filtered gviz query — Google evaluates the WHERE, we get only matches.
  const where = ids.map(id => `upper(A) = '${id}'`).join(' or ');
  const tq = `select A, B where ${where}`;
  const gvizUrl = `https://docs.google.com/spreadsheets/d/${MASTER_SPREADSHEET_ID}/gviz/tq?tqx=out:csv&tq=${encodeURIComponent(tq)}`;
  try {
    const res = await fetch(gvizUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) {
      const csv = await res.text();
      const map = parseTwoColCsv(csv, ids);
      return json(200, { ok: true, requested: ids.length, matched: Object.keys(map).length, map, via: 'gviz' });
    }
  } catch {}

  // Fallback: paged values.get scan (kept CPU-light by scanning in chunks and
  // stopping once every requested id is found).
  const want = new Set(ids);
  const map = {};
  const PAGE = 20000;
  for (let start = 1; start <= 400000 && want.size; start += PAGE) {
    const range = encodeURIComponent(`A${start}:B${start + PAGE - 1}`);
    const r = await fetch(`${SHEETS_URL}/${MASTER_SPREADSHEET_ID}/values/${range}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return json(r.status, { ok: false, error: `Master sheet read ${r.status}: ${await r.text()}` });
    const rows = (await r.json()).values || [];
    if (!rows.length) break;
    for (const row of rows) {
      const id = String(row?.[0] || '').trim().toUpperCase();
      if (want.has(id)) {
        const link = String(row?.[1] || '').trim();
        if (/^https?:\/\//i.test(link)) { map[id] = link; want.delete(id); }
      }
    }
    if (rows.length < PAGE) break;
  }
  return json(200, { ok: true, requested: ids.length, matched: Object.keys(map).length, map, via: 'scan' });
}

// Parse gviz out:csv ("A","B" quoted lines) into { ID: url } for wanted ids.
function parseTwoColCsv(csv, ids) {
  const want = new Set(ids);
  const map = {};
  for (const line of String(csv).split('\n')) {
    const m = line.match(/^"([^"]*)","([^"]*)"/);
    if (!m) continue;
    const id = m[1].trim().toUpperCase();
    const link = m[2].trim();
    if (want.has(id) && /^https?:\/\//i.test(link)) map[id] = link;
  }
  return map;
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
