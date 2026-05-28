// Cloudflare Pages Function — Drive file fetcher.
//
// Downloads a single Drive file and returns it as text. For native Google
// Sheets we export to CSV; for XLSX we return base64 (client parses with
// SheetJS-equivalent); for CSV we return decoded text.
//
// Request:  GET /api/drive/file?id=<fileId>
// Response: { ok, id, name, mimeType, format: 'csv'|'xlsx-base64', content }

const SCOPES = 'https://www.googleapis.com/auth/drive.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';

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

  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id) return json(400, { ok: false, error: 'Missing id parameter' });

  let token;
  try { token = await mintAccessToken(cfg); }
  catch (err) { return json(502, { ok: false, error: `Auth failed: ${err.message}` }); }

  // 1 — fetch metadata so we know the mime type
  const metaRes = await fetch(`${DRIVE_BASE}/files/${id}?fields=id,name,mimeType,size&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!metaRes.ok) return json(metaRes.status, { ok: false, error: `metadata ${metaRes.status}: ${await metaRes.text()}` });
  const meta = await metaRes.json();

  // 2 — download the bytes. Google native sheets must use /export; everything else /files/{id}?alt=media
  let content, format;
  if (meta.mimeType === 'application/vnd.google-apps.spreadsheet') {
    // Export as CSV (the first sheet only — Drive's export-CSV gives sheet 1)
    const res = await fetch(`${DRIVE_BASE}/files/${id}/export?mimeType=text/csv`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return json(res.status, { ok: false, error: `export ${res.status}: ${await res.text()}` });
    content = await res.text();
    format = 'csv';
  } else if (meta.mimeType === 'text/csv') {
    const res = await fetch(`${DRIVE_BASE}/files/${id}?alt=media&supportsAllDrives=true`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return json(res.status, { ok: false, error: `download ${res.status}: ${await res.text()}` });
    content = await res.text();
    format = 'csv';
  } else {
    // XLSX / other binary — return base64. Client decodes with SheetJS.
    const res = await fetch(`${DRIVE_BASE}/files/${id}?alt=media&supportsAllDrives=true`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return json(res.status, { ok: false, error: `download ${res.status}: ${await res.text()}` });
    const buf = await res.arrayBuffer();
    content = arrayBufferToBase64(buf);
    format = 'xlsx-base64';
  }

  return json(200, { ok: true, id, name: meta.name, mimeType: meta.mimeType, format, content });
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = '';
  // Process in chunks to avoid stack overflow on large files
  const chunkSize = 32768;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(bin);
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function mintAccessToken(cfg) {
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: cfg.saEmail, scope: SCOPES, aud: TOKEN_URL, exp: now + 3600, iat: now, sub: cfg.impersonate };
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
