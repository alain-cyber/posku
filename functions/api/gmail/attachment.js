// Cloudflare Pages Function — Gmail attachment fetcher.
//
// Returns the decoded text of a single Gmail attachment. Exists as a
// separate endpoint from /api/gmail/messages because Workers have a hard
// 50-subrequest cap per invocation: fetching messages + all their
// attachments in one shot blew through that on inbox-fetches of >~24
// emails, silently losing CSVs. Splitting attachments out means each
// request only spends ~3 subrequests (token mint + metadata + bytes).
//
// Request:  GET /api/gmail/attachment?messageId=...&attachmentId=...
// Response: { ok, filename, mimeType, text }

const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'GET') return json(405, { ok: false, error: 'Method not allowed' });

  const cfg = {
    saEmail:    env.GMAIL_SA_EMAIL,
    privateKey: env.GMAIL_SA_PRIVATE_KEY,
    impersonate: env.GMAIL_IMPERSONATE_USER,
  };
  const missing = Object.entries(cfg).filter(([_, v]) => !v).map(([k]) => k);
  if (missing.length) return json(500, { ok: false, error: `Missing env var(s): ${missing.join(', ')}` });

  const url = new URL(request.url);
  const messageId = url.searchParams.get('messageId');
  const attachmentId = url.searchParams.get('attachmentId');
  const filename = url.searchParams.get('filename') || '';
  if (!messageId || !attachmentId) return json(400, { ok: false, error: 'messageId and attachmentId are required' });

  let accessToken;
  try { accessToken = await mintAccessToken(cfg); }
  catch (err) { return json(502, { ok: false, error: `Auth failed: ${err.message}` }); }

  try {
    const res = await fetch(`${GMAIL_BASE}/users/me/messages/${messageId}/attachments/${attachmentId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return json(res.status, { ok: false, error: `attachment fetch ${res.status}: ${await res.text()}` });
    const j = await res.json();
    return json(200, { ok: true, filename, text: decodeBase64Url(j.data || '') });
  } catch (err) {
    return json(502, { ok: false, error: `fetch failed: ${err.message}` });
  }
}

function decodeBase64Url(data) {
  const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const bin = atob(b64 + '==='.slice((b64.length + 3) % 4));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  } catch { return ''; }
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
