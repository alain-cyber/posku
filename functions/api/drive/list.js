// Cloudflare Pages Function — Drive search for Wayfair manifests.
//
// Uses a single global Drive query (mime + date + filename patterns) instead
// of recursive tree walks — the old approach hit Cloudflare's wall-time limit
// before returning anything. One API round-trip; classification into tree
// happens in-code via the filename.
//
// Auth: same SA + DWD setup as Gmail / Sheets. Requires the `drive.readonly`
// scope added to the delegation (alongside gmail.readonly + spreadsheets).
//
// Request:  GET /api/drive/list?after=YYYY-MM-DD&before=YYYY-MM-DD&tree=fc|hdo|outlet|perigold|all
// Response: { ok, files: [{ id, name, mimeType, modifiedTime, size, tree }] }

const SCOPES = 'https://www.googleapis.com/auth/drive.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';

const ALL_TREES = ['fc', 'hdo', 'outlet', 'perigold'];

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
  const after  = url.searchParams.get('after');
  const before = url.searchParams.get('before');
  const treeParam = (url.searchParams.get('tree') || 'all').toLowerCase();
  const treeFilter = treeParam === 'all' ? null : treeParam;
  if (treeFilter && !ALL_TREES.includes(treeFilter)) {
    return json(400, { ok: false, error: `Unknown tree "${treeParam}". Use one of: ${ALL_TREES.join(', ')}, all` });
  }

  let token;
  try { token = await mintAccessToken(cfg); }
  catch (err) { return json(502, { ok: false, error: `Auth failed: ${err.message}` }); }

  // Build a single Drive q string. The filename patterns ("Load" / "Manifest" /
  // "Outlet" / "Perigold") narrow the corpus to manifest files specifically.
  const parts = [
    "(mimeType = 'text/csv' or mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' or mimeType = 'application/vnd.google-apps.spreadsheet')",
    "(name contains 'Load' or name contains 'Manifest' or name contains 'Outlet' or name contains 'Perigold')",
    'trashed = false',
  ];
  // UI labels these as "upload date" — that's createdTime in Drive terms.
  // modifiedTime is last-edit, which can predate the upload (file edited
  // locally before uploading) or postdate it (someone re-saved later) and
  // was causing manifests to be invisible to date searches.
  if (after)  parts.push(`createdTime >= '${after}T00:00:00Z'`);
  if (before) {
    const [y, m, d] = before.split('-').map(Number);
    const next = new Date(Date.UTC(y, m - 1, d + 1));
    parts.push(`createdTime < '${next.toISOString().slice(0, 10)}T00:00:00Z'`);
  }
  const q = parts.join(' and ');

  // Paginate through results
  const all = [];
  let pageToken;
  do {
    const params = new URLSearchParams({
      q,
      fields: 'nextPageToken, files(id, name, mimeType, createdTime, modifiedTime, size)',
      pageSize: '1000',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await fetch(`${DRIVE_BASE}/files?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      return json(res.status, { ok: false, error: `Drive list ${res.status}: ${await res.text()}` });
    }
    const j = await res.json();
    all.push(...(j.files || []));
    pageToken = j.nextPageToken;
  } while (pageToken);

  // Classify each file into a tree by its filename pattern
  const files = [];
  for (const f of all) {
    const tree = classifyTree(f.name);
    if (!tree) continue;
    if (treeFilter && tree.toLowerCase() !== treeFilter) continue;
    files.push({
      id:           f.id,
      name:         f.name,
      mimeType:     f.mimeType,
      createdTime:  f.createdTime,
      modifiedTime: f.modifiedTime,
      size:         f.size,
      tree,
    });
  }
  // Newest upload first
  files.sort((a, b) => (b.createdTime || '').localeCompare(a.createdTime || ''));

  return json(200, { ok: true, files, query: q });
}

// Map a filename to one of the four manifest categories. Order matters —
// Perigold check uses "PG" or "Perigold" string; Outlet uses "Outlet"; HDO
// uses the "<city> Liquidation Manifest LQ####" pattern; everything else
// that matches "Load NNNNN <city>" is FC.
function classifyTree(name) {
  if (!name) return null;
  if (/Perigold|\bPG\d?\b/i.test(name)) return 'Perigold';
  if (/Outlet/i.test(name))             return 'Outlet';
  // HDO: "<city> Liquidation Manifest LQ####.xlsx"
  if (/\bLiquidation\s+Manifest\s+LQ\d+/i.test(name)) return 'HDO';
  // FC: "Liquidation Load 50595 Romeoville" / "Salvage Load …" / "Aged Inventory Load …" / "QC Load …"
  if (/\b(Liquidation|Salvage|Aged|QC)(\s+Inventory)?\s+Load\s+\d+/i.test(name)) return 'FC';
  return null;
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
