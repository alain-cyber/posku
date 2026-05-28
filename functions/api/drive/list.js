// Cloudflare Pages Function — Drive search for Wayfair manifests.
//
// Walks the four known manifest folder trees in the shared Drive, returning
// every file whose modifiedTime is in the requested date window.
//
// Auth: same SA + DWD setup as Gmail / Sheets. Requires the `drive.readonly`
// scope added to the delegation (alongside gmail.readonly + spreadsheets).
//
// Request:  GET /api/drive/list?after=YYYY-MM-DD&before=YYYY-MM-DD&tree=fc|hdo|outlet|perigold|all
// Response: { ok, files: [{ id, name, mimeType, modifiedTime, size, tree, path }] }

const SCOPES = 'https://www.googleapis.com/auth/drive.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';

// Top folders for each manifest type — these IDs are stable in the Via Trading SHARED Drive.
const TREES = {
  fc:       { id: '1d7FQXDX3dEFhE52nCCdhPKiKVvNWIGET', label: 'FC' },
  hdo:      { id: '1GZKD6UnUET-3sL5ocUZMQKGhqd1FI9Jk', label: 'HDO' },
  outlet:   { id: '1imyb8ey3BCFSPRxuwZ4YoPN-l91F6UU9', label: 'Outlet' },
  perigold: { id: '1D2BYIjbL5_SFdaszq5ZC87cut0KOvGig', label: 'Perigold' },
};

// Mimes we treat as manifests (skip docs, PDFs, etc.)
const MANIFEST_MIMES = new Set([
  'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.google-apps.spreadsheet',
]);

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
  const after  = url.searchParams.get('after');   // YYYY-MM-DD
  const before = url.searchParams.get('before');  // YYYY-MM-DD (inclusive end-of-day adds 1 day server-side)
  const treeParam = (url.searchParams.get('tree') || 'all').toLowerCase();
  const treeKeys = treeParam === 'all' ? Object.keys(TREES) : [treeParam];
  for (const k of treeKeys) if (!TREES[k]) return json(400, { ok: false, error: `Unknown tree "${k}". Use one of: ${Object.keys(TREES).join(', ')}, all` });

  let token;
  try { token = await mintAccessToken(cfg); }
  catch (err) { return json(502, { ok: false, error: `Auth failed: ${err.message}` }); }

  // Run each tree walk in parallel
  const dateClause = buildDateClause(after, before);
  const all = await Promise.all(treeKeys.map(k => walkTree(TREES[k].id, TREES[k].label, dateClause, token)));
  const files = all.flat();
  return json(200, { ok: true, files, treesQueried: treeKeys });
}

// Drive q: build modifiedTime clause for the file-list call. before is treated
// as inclusive of the picked day → +1 day so Drive's strict-less-than matches.
function buildDateClause(after, before) {
  const parts = [];
  if (after)  parts.push(`modifiedTime >= '${after}T00:00:00Z'`);
  if (before) {
    const [y, m, d] = before.split('-').map(Number);
    const next = new Date(Date.UTC(y, m - 1, d + 1));
    const iso = next.toISOString().slice(0, 10);
    parts.push(`modifiedTime < '${iso}T00:00:00Z'`);
  }
  return parts.join(' and ');
}

// Recursively walk a tree using a stack. At each folder we list its
// children (mime + date filter inline so we don't pull data we'll discard),
// recurse into subfolders, and accumulate manifest files.
async function walkTree(rootId, treeLabel, dateClause, token) {
  const out = [];
  const folders = [{ id: rootId, path: '' }];
  while (folders.length) {
    const f = folders.pop();
    const children = await listChildren(f.id, token);
    for (const c of children) {
      if (c.mimeType === 'application/vnd.google-apps.folder') {
        folders.push({ id: c.id, path: f.path ? `${f.path}/${c.name}` : c.name });
      } else if (MANIFEST_MIMES.has(c.mimeType)) {
        // Apply date filter in code (we can't combine ancestor + date in a single Drive q)
        if (passesDate(c.modifiedTime, dateClause)) {
          out.push({
            id:           c.id,
            name:         c.name,
            mimeType:     c.mimeType,
            modifiedTime: c.modifiedTime,
            size:         c.size,
            tree:         treeLabel,
            path:         f.path,
          });
        }
      }
    }
  }
  return out;
}

async function listChildren(parentId, token) {
  const out = [];
  let pageToken;
  do {
    const params = new URLSearchParams({
      q: `'${parentId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, size, parents)',
      pageSize: '1000',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await fetch(`${DRIVE_BASE}/files?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(`drive list ${res.status}: ${await res.text()}`);
    }
    const j = await res.json();
    out.push(...(j.files || []));
    pageToken = j.nextPageToken;
  } while (pageToken);
  return out;
}

// In-code date check — mirrors the date clause we'd have used at query time
// if Drive let us combine it with ancestor filters.
function passesDate(modifiedTime, dateClause) {
  if (!dateClause) return true;
  const m = new Date(modifiedTime).getTime();
  // The dateClause is human-friendly; we re-parse here. After-only clauses
  // and before-only clauses are both expressed via the >= / < pair below.
  const after = dateClause.match(/modifiedTime >= '([^']+)'/);
  const before = dateClause.match(/modifiedTime < '([^']+)'/);
  if (after  && m < new Date(after[1]).getTime())  return false;
  if (before && m >= new Date(before[1]).getTime()) return false;
  return true;
}

// ── Helpers (same JWT/RS256 flow as gmail + sheets) ──────────────────────────

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
