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
    // XLSX (or other binary). For spreadsheetml we unzip + parse the first
    // sheet to CSV server-side (Workers have DecompressionStream). Anything
    // else, or a parse failure, falls back to base64 for the client.
    const res = await fetch(`${DRIVE_BASE}/files/${id}?alt=media&supportsAllDrives=true`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return json(res.status, { ok: false, error: `download ${res.status}: ${await res.text()}` });
    const buf = await res.arrayBuffer();
    const isXlsx = /spreadsheetml\.sheet/.test(meta.mimeType || '') || /\.xlsx$/i.test(meta.name || '');
    if (isXlsx) {
      try {
        const rows = await xlsxToRows(buf);
        content = rowsToCsv(rows);
        format = 'csv';
      } catch (err) {
        content = arrayBufferToBase64(buf);
        format = 'xlsx-base64';
        return json(200, { ok: true, id, name: meta.name, mimeType: meta.mimeType, format, content, parseError: err.message });
      }
    } else {
      content = arrayBufferToBase64(buf);
      format = 'xlsx-base64';
    }
  }

  return json(200, { ok: true, id, name: meta.name, mimeType: meta.mimeType, format, content });
}

// ── Minimal XLSX → rows reader (ZIP + first worksheet + shared strings) ──────
async function xlsxToRows(arrayBuffer) {
  const entries = readZipEntries(new Uint8Array(arrayBuffer));
  const read = async (name) => {
    const e = entries.get(name);
    if (!e) return '';
    const bytes = await getEntryData(new Uint8Array(arrayBuffer), e);
    return new TextDecoder('utf-8').decode(bytes);
  };
  // Shared strings (cells with t="s" index into this).
  const shared = parseSharedStrings(await read('xl/sharedStrings.xml'));
  // First worksheet — prefer sheet1.xml, else any worksheet entry.
  let sheetName = 'xl/worksheets/sheet1.xml';
  if (!entries.has(sheetName)) {
    sheetName = [...entries.keys()].find(k => /^xl\/worksheets\/.*\.xml$/.test(k)) || sheetName;
  }
  return parseSheet(await read(sheetName), shared);
}

function readZipEntries(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  // Find End Of Central Directory (sig 0x06054b50), scanning back from the end.
  let eocd = -1;
  for (let i = u8.length - 22; i >= 0 && i >= u8.length - 22 - 65536; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('xlsx: no EOCD (not a zip?)');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const compSize = dv.getUint32(off + 20, true);
    const fnLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const localOff = dv.getUint32(off + 42, true);
    const name = new TextDecoder().decode(u8.subarray(off + 46, off + 46 + fnLen));
    entries.set(name, { method, compSize, localOff });
    off += 46 + fnLen + extraLen + commentLen;
  }
  return entries;
}

async function getEntryData(u8, entry) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  // Local header: filename + extra lengths live at +26/+28.
  const lfnLen = dv.getUint16(entry.localOff + 26, true);
  const lexLen = dv.getUint16(entry.localOff + 28, true);
  const start = entry.localOff + 30 + lfnLen + lexLen;
  const comp = u8.subarray(start, start + entry.compSize);
  if (entry.method === 0) return comp;            // stored
  if (entry.method === 8) return inflateRaw(comp); // deflate
  throw new Error(`xlsx: unsupported zip method ${entry.method}`);
}

async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const w = ds.writable.getWriter();
  w.write(bytes); w.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}

function parseSharedStrings(xml) {
  const out = [];
  if (!xml) return out;
  const reSi = /<si\b[\s\S]*?<\/si>/g;
  let m;
  while ((m = reSi.exec(xml))) {
    // Concatenate every <t>…</t> in this <si> (handles rich-text <r> runs).
    let s = ''; const reT = /<t\b[^>]*>([\s\S]*?)<\/t>/g; let mt;
    while ((mt = reT.exec(m[0]))) s += decodeXml(mt[1]);
    out.push(s);
  }
  return out;
}

function parseSheet(xml, shared) {
  const rows = [];
  if (!xml) return rows;
  const reRow = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let mr;
  while ((mr = reRow.exec(xml))) {
    const cells = [];
    const reC = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g;
    let mc;
    while ((mc = reC.exec(mr[1]))) {
      const attrs = mc[1] || mc[3] || '';
      const inner = mc[2] || '';
      const ref = (attrs.match(/r="([A-Z]+)\d+"/) || [])[1] || '';
      const t = (attrs.match(/t="([^"]+)"/) || [])[1] || '';
      let val = '';
      if (t === 's') {
        const vi = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        val = vi != null ? (shared[Number(vi)] ?? '') : '';
      } else if (t === 'inlineStr') {
        const it = (inner.match(/<t\b[^>]*>([\s\S]*?)<\/t>/) || [])[1];
        val = it != null ? decodeXml(it) : '';
      } else {
        const vi = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        val = vi != null ? decodeXml(vi) : '';
      }
      const col = ref ? colToIdx(ref) : cells.length;
      cells[col] = val;
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
    rows.push(cells);
  }
  return rows;
}

function colToIdx(letters) {
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n - 1;
}

function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

function rowsToCsv(rows) {
  const q = (v) => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return rows.map(r => r.map(q).join(',')).join('\n');
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
