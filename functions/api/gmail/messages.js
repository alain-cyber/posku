// Cloudflare Pages Function — Gmail message fetcher.
//
// Reads emails from a Google Workspace mailbox via a service account with
// domain-wide delegation. The browser never sees credentials; the access
// token is minted per-request from the SA private key.
//
// Required Pages env vars:
//   GMAIL_SA_EMAIL          — service account email
//                              (e.g. posku-reader@your-project.iam.gserviceaccount.com)
//   GMAIL_SA_PRIVATE_KEY    — the "private_key" string from the SA JSON key
//                              (full PEM, including BEGIN/END lines and \n)
//   GMAIL_IMPERSONATE_USER  — the user mailbox to read from
//                              (e.g. posku-inbox@viatrading.com)
//
// Request:  GET /api/gmail/messages?label=posku&after=YYYY-MM-DD&before=YYYY-MM-DD&max=50
// Response: { ok: true, messages: [{ id, subject, from, date, snippet, body }] }

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
  if (missing.length) {
    return json(500, {
      ok: false,
      error: `Gmail is not configured. Missing Pages env var(s): ${missing.map(k => k === 'saEmail' ? 'GMAIL_SA_EMAIL' : k === 'privateKey' ? 'GMAIL_SA_PRIVATE_KEY' : 'GMAIL_IMPERSONATE_USER').join(', ')}. See CLOUDFLARE_SETUP.md.`,
    });
  }

  const url = new URL(request.url);
  const label  = url.searchParams.get('label')  || 'posku';
  const after  = url.searchParams.get('after');   // YYYY-MM-DD
  const before = url.searchParams.get('before');  // YYYY-MM-DD
  const to     = url.searchParams.get('to');      // recipient address filter
  const max    = Math.min(parseInt(url.searchParams.get('max') || '50', 10) || 50, 200);

  // Build the Gmail search query
  const parts = [`label:${label}`];
  if (to)     parts.push(`to:${to}`);
  if (after)  parts.push(`after:${after.replace(/-/g, '/')}`);
  if (before) parts.push(`before:${before.replace(/-/g, '/')}`);
  const q = parts.join(' ');

  let accessToken;
  try {
    accessToken = await mintAccessToken(cfg);
  } catch (err) {
    return json(502, { ok: false, error: `Auth failed: ${err.message}` });
  }

  // Step 1 — list message IDs matching the query
  const listUrl = `${GMAIL_BASE}/users/me/messages?q=${encodeURIComponent(q)}&maxResults=${max}`;
  const listRes = await fetch(listUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!listRes.ok) {
    return json(listRes.status, { ok: false, error: `Gmail list failed (${listRes.status}): ${await listRes.text()}` });
  }
  const listJson = await listRes.json();
  const ids = (listJson.messages || []).map(m => m.id);
  if (!ids.length) return json(200, { ok: true, messages: [], query: q });

  // Step 2 — fetch each message in parallel
  const messages = await Promise.all(ids.map(async id => {
    const res = await fetch(`${GMAIL_BASE}/users/me/messages/${id}?format=full`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return { id, error: `HTTP ${res.status}` };
    const m = await res.json();
    const headers = Object.fromEntries((m.payload?.headers || []).map(h => [h.name.toLowerCase(), h.value]));
    return {
      id,
      threadId: m.threadId,
      subject:  headers.subject || '',
      from:     headers.from || '',
      date:     headers.date || '',
      snippet:  m.snippet || '',
      body:     extractBody(m.payload),
    };
  }));

  return json(200, { ok: true, messages, query: q });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// Recursively extract the best text body from a Gmail message payload.
// Prefers text/plain, falls back to text/html (stripped of tags).
function extractBody(payload) {
  if (!payload) return '';
  const plain = findPart(payload, 'text/plain');
  if (plain) return decodePart(plain);
  const html = findPart(payload, 'text/html');
  if (html) return decodePart(html).replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  return '';
}

function findPart(part, mime) {
  if (part.mimeType === mime && part.body?.data) return part;
  if (part.parts) {
    for (const p of part.parts) {
      const hit = findPart(p, mime);
      if (hit) return hit;
    }
  }
  return null;
}

function decodePart(part) {
  const data = part.body?.data || '';
  // Gmail uses base64url
  const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const bin = atob(b64 + '==='.slice((b64.length + 3) % 4));
    // Decode UTF-8
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return '';
  }
}

// ── Service-account JWT → access token (RS256) ───────────────────────────────

async function mintAccessToken(cfg) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss:   cfg.saEmail,
    scope: SCOPE,
    aud:   TOKEN_URL,
    exp:   now + 3600,
    iat:   now,
    sub:   cfg.impersonate,  // user to impersonate via domain-wide delegation
  };
  const header = { alg: 'RS256', typ: 'JWT' };

  const enc = (obj) => b64urlEncode(new TextEncoder().encode(JSON.stringify(obj)));
  const signingInput = `${enc(header)}.${enc(claims)}`;

  const key = await importPrivateKey(cfg.privateKey);
  const sig = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    new TextEncoder().encode(signingInput),
  );
  const jwt = `${signingInput}.${b64urlEncode(new Uint8Array(sig))}`;

  // Exchange JWT for access token
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    throw new Error(`token exchange ${res.status}: ${await res.text()}`);
  }
  const j = await res.json();
  if (!j.access_token) throw new Error('no access_token in response');
  return j.access_token;
}

async function importPrivateKey(pem) {
  // Strip header/footer and any whitespace/newlines (env vars may have \n escapes)
  const clean = pem
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN [A-Z ]+-----/g, '')
    .replace(/-----END [A-Z ]+-----/g, '')
    .replace(/\s+/g, '');
  const bytes = Uint8Array.from(atob(clean), c => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8',
    bytes.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

function b64urlEncode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
