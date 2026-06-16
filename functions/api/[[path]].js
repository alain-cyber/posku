// Cloudflare Pages Function — Posku API proxy + inlined inbox handlers.
//
// Forwards /api/* to the selected ERP upstream (TEST BIZ or LIVE OPS), and
// ALSO serves the Gmail "inbox" endpoints inline. This project intermittently
// fails to register standalone function files as their own routes, but this
// catch-all always runs — so the inbox logic lives here directly (no imports,
// no dependency on separate route registration).
//
//   GET /api/inbox?label=&after=&before=&to=&max=   → list + parse messages
//   GET /api/inbox-attachment?messageId=&attachmentId=&filename=  → attachment text
//
// Env selection for the ERP proxy:
//   X-Posku-Env: test → viatrading.biz (BIZ_API) · live → ops.viatrading.com (ops_api_key)

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const TOKEN_URL   = 'https://oauth2.googleapis.com/token';
const GMAIL_BASE  = 'https://gmail.googleapis.com/gmail/v1';

const ENVIRONMENTS = {
  test: { origin: 'https://viatrading.biz',     keyVar: 'BIZ_API' },
  live: { origin: 'https://ops.viatrading.com', keyVar: 'ops_api_key' },
};

export async function onRequest(context) {
  const { request, env, params } = context;
  const segs = Array.isArray(params.path) ? params.path : (params.path ? [params.path] : []);

  // ── Inbox (Gmail) — handled inline so they work regardless of route registration
  if (segs[0] === 'inbox') {
    try { return await handleInboxMessages(context); }
    catch (err) { return gJson(500, { ok: false, error: `inbox crashed: ${err?.message || String(err)}` }); }
  }
  if (segs[0] === 'inbox-attachment') {
    try { return await handleInboxAttachment(context); }
    catch (err) { return gJson(500, { ok: false, error: `inbox-attachment crashed: ${err?.message || String(err)}` }); }
  }
  // Other local subpaths (rules/sheets/drive) have their own files; if one ever
  // lands here it means it wasn't registered — 404 clearly rather than proxy.
  if (segs[0] === 'gmail' || segs[0] === 'rules' || segs[0] === 'sheets' || segs[0] === 'drive') {
    return jsonError(404, `${segs[0]} subpath not handled by ERP proxy`);
  }

  // ── Everything else proxies to the ERP.
  const envName = (request.headers.get('X-Posku-Env') || 'test').toLowerCase();
  const target = ENVIRONMENTS[envName];
  if (!target) return jsonError(400, `Unknown environment "${envName}". Use "test" or "live".`);
  const apiKey = env[target.keyVar];
  if (!apiKey) return jsonError(500, `Server missing ${target.keyVar} environment variable for ${envName} mode`);

  const reqUrl = new URL(request.url);
  const targetUrl = target.origin + '/api/' + segs.join('/') + reqUrl.search;
  const headers = new Headers();
  headers.set('api-key', apiKey);
  headers.set('Content-Type', request.headers.get('Content-Type') || 'application/json');
  const accept = request.headers.get('Accept');
  if (accept) headers.set('Accept', accept);
  const init = { method: request.method, headers };
  if (!['GET', 'HEAD'].includes(request.method)) init.body = await request.text();

  let upstream;
  try { upstream = await fetch(targetUrl, init); }
  catch (err) { return jsonError(502, `Upstream fetch failed (${envName}): ${err.message}`); }
  const respBody = await upstream.text();
  return new Response(respBody, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
      'Cache-Control': 'no-store',
      'X-Posku-Env-Used': envName,
    },
  });
}

// ── Inbox: list + parse messages ─────────────────────────────────────────────
async function handleInboxMessages(context) {
  const { request, env } = context;
  if (request.method !== 'GET') return gJson(405, { ok: false, error: 'Method not allowed' });

  const cfg = { saEmail: env.GMAIL_SA_EMAIL, privateKey: env.GMAIL_SA_PRIVATE_KEY, impersonate: env.GMAIL_IMPERSONATE_USER };
  const missing = Object.entries(cfg).filter(([_, v]) => !v).map(([k]) => k);
  if (missing.length) return gJson(500, { ok: false, error: `Gmail not configured. Missing: ${missing.map(k => k === 'saEmail' ? 'GMAIL_SA_EMAIL' : k === 'privateKey' ? 'GMAIL_SA_PRIVATE_KEY' : 'GMAIL_IMPERSONATE_USER').join(', ')}` });

  const url = new URL(request.url);
  const label  = url.searchParams.get('label') || 'posku';
  const after  = url.searchParams.get('after');
  const before = url.searchParams.get('before');
  const to     = url.searchParams.get('to');
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);

  const parts = [`label:${label}`];
  if (to)     parts.push(`to:${to}`);
  if (after)  parts.push(`after:${after.replace(/-/g, '/')}`);
  if (before) parts.push(`before:${before.replace(/-/g, '/')}`);
  const q = parts.join(' ');

  let accessToken;
  try { accessToken = await mintGmailToken(cfg); }
  catch (err) { return gJson(502, { ok: false, error: `Auth failed: ${err.message}` }); }

  // List up to 500 matching IDs in one (cheap) subrequest; the client paginates
  // full-message fetches via ?offset= so we never exceed the ~50 subrequest cap.
  const listUrl = `${GMAIL_BASE}/users/me/messages?q=${encodeURIComponent(q)}&maxResults=500`;
  const listRes = await fetch(listUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!listRes.ok) return gJson(listRes.status, { ok: false, error: `Gmail list failed (${listRes.status}): ${await listRes.text()}` });
  const listJson = await listRes.json();
  const allIds = (listJson.messages || []).map(m => m.id);
  const totalMatched = allIds.length;
  if (!totalMatched) return gJson(200, { ok: true, messages: [], query: q, totalMatched: 0, offset, nextOffset: null });

  const FETCH_CAP = 40;
  const ids = allIds.slice(offset, offset + FETCH_CAP);

  const messages = await Promise.all(ids.map(async id => {
    try {
      const res = await fetch(`${GMAIL_BASE}/users/me/messages/${id}?format=full`, { headers: { Authorization: `Bearer ${accessToken}` } });
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
        attachmentRefs: collectAttachmentRefs(m.payload),
      };
    } catch (err) {
      return { id, error: err?.message || String(err) };
    }
  }));

  const nextOffset = (offset + ids.length < totalMatched) ? offset + ids.length : null;
  return gJson(200, { ok: true, messages, query: q, totalMatched, offset, nextOffset });
}

// ── Inbox: single attachment text ────────────────────────────────────────────
async function handleInboxAttachment(context) {
  const { request, env } = context;
  if (request.method !== 'GET') return gJson(405, { ok: false, error: 'Method not allowed' });

  const cfg = { saEmail: env.GMAIL_SA_EMAIL, privateKey: env.GMAIL_SA_PRIVATE_KEY, impersonate: env.GMAIL_IMPERSONATE_USER };
  const missing = Object.entries(cfg).filter(([_, v]) => !v).map(([k]) => k);
  if (missing.length) return gJson(500, { ok: false, error: `Missing env var(s): ${missing.join(', ')}` });

  const url = new URL(request.url);
  const messageId = url.searchParams.get('messageId');
  const attachmentId = url.searchParams.get('attachmentId');
  const filename = url.searchParams.get('filename') || '';
  if (!messageId || !attachmentId) return gJson(400, { ok: false, error: 'messageId and attachmentId are required' });

  let accessToken;
  try { accessToken = await mintGmailToken(cfg); }
  catch (err) { return gJson(502, { ok: false, error: `Auth failed: ${err.message}` }); }

  try {
    const res = await fetch(`${GMAIL_BASE}/users/me/messages/${messageId}/attachments/${attachmentId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return gJson(res.status, { ok: false, error: `attachment fetch ${res.status}: ${await res.text()}` });
    const j = await res.json();
    return gJson(200, { ok: true, filename, text: decodeBase64Url(j.data || '') });
  } catch (err) {
    return gJson(502, { ok: false, error: `fetch failed: ${err.message}` });
  }
}

// ── Shared Gmail helpers ─────────────────────────────────────────────────────
function collectAttachmentRefs(payload) {
  const refs = [];
  (function walk(p) {
    if (!p) return;
    if (p.filename && p.body?.attachmentId) {
      refs.push({ filename: p.filename, mimeType: p.mimeType || '', size: p.body.size || 0, attachmentId: p.body.attachmentId });
    }
    if (p.parts) p.parts.forEach(walk);
  })(payload);
  return refs;
}

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
  return decodeBase64Url(part.body?.data || '');
}

function decodeBase64Url(data) {
  const b64 = String(data).replace(/-/g, '+').replace(/_/g, '/');
  try {
    const bin = atob(b64 + '==='.slice((b64.length + 3) % 4));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return '';
  }
}

async function mintGmailToken(cfg) {
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: cfg.saEmail, scope: GMAIL_SCOPE, aud: TOKEN_URL, exp: now + 3600, iat: now, sub: cfg.impersonate };
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

function gJson(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}
