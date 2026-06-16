// Cloudflare Pages Function — Posku API proxy + local-handler dispatch.
//
// Forwards any /api/* request from the browser to the selected upstream
// (TEST BIZ or LIVE OPS), injecting the matching server-side API key.
// The browser never sees the keys, and same-origin avoids CORS.
//
// IMPORTANT: this catch-all also DISPATCHES to the Pages Functions that live in
// subfolders (gmail/, drive/, sheets/, rules). On this project Cloudflare is
// not reliably registering nested function files as their own routes, so
// /api/gmail/messages was hitting this catch-all (or a bare 404) instead of its
// handler. The catch-all itself is always invoked, so we import those handlers
// and call them directly — guaranteeing they run regardless of nested routing.
//
// Environment selection (for the ERP proxy path):
//   Header `X-Posku-Env: test` → viatrading.biz       with env.BIZ_API
//   Header `X-Posku-Env: live` → ops.viatrading.com   with env.ops_api_key
//   Missing/unknown → defaults to test (safer).

import { onRequest as gmailMessages }   from './gmail/messages.js';
import { onRequest as gmailAttachment } from './gmail/attachment.js';
import { onRequest as driveFile }       from './drive/file.js';
import { onRequest as driveList }       from './drive/list.js';
import { onRequest as sheetsAppend }    from './sheets/append.js';
import { onRequest as sheetsInit }      from './sheets/init-headers.js';
import { onRequest as rulesHandler }    from './rules.js';

// Local handlers keyed by their /api/<key> path. Anything not listed here
// (customers, orders, products, …) falls through to the ERP proxy below.
const LOCAL_HANDLERS = {
  'gmail/messages':      gmailMessages,
  'gmail/attachment':    gmailAttachment,
  'drive/file':          driveFile,
  'drive/list':          driveList,
  'sheets/append':       sheetsAppend,
  'sheets/init-headers': sheetsInit,
  'rules':               rulesHandler,
};

const ENVIRONMENTS = {
  test: { origin: 'https://viatrading.biz',     keyVar: 'BIZ_API' },
  live: { origin: 'https://ops.viatrading.com', keyVar: 'ops_api_key' },
};

export async function onRequest(context) {
  const { request, env, params } = context;

  const segs = Array.isArray(params.path) ? params.path : (params.path ? [params.path] : []);
  const key = segs.join('/');

  // 1 — dispatch to a local Pages Function if this path maps to one.
  if (LOCAL_HANDLERS[key]) {
    return LOCAL_HANDLERS[key](context);
  }
  // Unknown gmail/drive/sheets subpaths are ours but unhandled — 404 clearly
  // rather than proxying them to the ERP (which would 404 with no JSON body).
  if (segs[0] === 'gmail' || segs[0] === 'drive' || segs[0] === 'sheets') {
    return jsonError(404, `No handler for /api/${key}`);
  }

  // 2 — everything else (customers, orders, products, …) proxies to the ERP.
  const envName = (request.headers.get('X-Posku-Env') || 'test').toLowerCase();
  const target = ENVIRONMENTS[envName];
  if (!target) {
    return jsonError(400, `Unknown environment "${envName}". Use "test" or "live".`);
  }

  const apiKey = env[target.keyVar];
  if (!apiKey) {
    return jsonError(500, `Server missing ${target.keyVar} environment variable for ${envName} mode`);
  }

  const reqUrl = new URL(request.url);
  const targetUrl = target.origin + '/api/' + segs.join('/') + reqUrl.search;

  const headers = new Headers();
  headers.set('api-key', apiKey);
  const ct = request.headers.get('Content-Type');
  headers.set('Content-Type', ct || 'application/json');
  const accept = request.headers.get('Accept');
  if (accept) headers.set('Accept', accept);

  const init = { method: request.method, headers };
  if (!['GET', 'HEAD'].includes(request.method)) {
    init.body = await request.text();
  }

  let upstream;
  try {
    upstream = await fetch(targetUrl, init);
  } catch (err) {
    return jsonError(502, `Upstream fetch failed (${envName}): ${err.message}`);
  }

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

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
