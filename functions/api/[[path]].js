// Cloudflare Pages Function — Posku API proxy.
//
// Forwards any /api/* request from the browser to the selected upstream
// (TEST BIZ or LIVE OPS), injecting the matching server-side API key.
// The browser never sees the keys, and same-origin avoids CORS.
//
// Environment selection:
//   Header `X-Posku-Env: test` → viatrading.biz       with env.BIZ_API
//   Header `X-Posku-Env: live` → ops.viatrading.com   with env.ops_api_key
//   Missing/unknown → defaults to test (safer).
//
// Also dispatches the inbox (Gmail) handlers from here. This project
// intermittently fails to register standalone function files as their own
// routes, but the catch-all ALWAYS runs — so we import those handlers and call
// them directly, which guarantees they execute regardless of route registration.

import { onRequest as inboxHandler }           from './inbox.js';
import { onRequest as inboxAttachmentHandler } from './inbox-attachment.js';

const ENVIRONMENTS = {
  test: { origin: 'https://viatrading.biz',     keyVar: 'BIZ_API' },
  live: { origin: 'https://ops.viatrading.com', keyVar: 'ops_api_key' },
};

export async function onRequest(context) {
  const { request, env, params } = context;

  // Gmail integration has its own handler at /api/gmail/* — pass through if
  // it somehow lands here (defensive; the static route file should win).
  const segs = Array.isArray(params.path) ? params.path : (params.path ? [params.path] : []);
  // Inbox (Gmail) — run the handler here so it works even when its own route
  // isn't registered by the platform.
  if (segs[0] === 'inbox')            return inboxHandler(context);
  if (segs[0] === 'inbox-attachment') return inboxAttachmentHandler(context);
  if (segs[0] === 'gmail' || segs[0] === 'rules' || segs[0] === 'sheets' || segs[0] === 'drive') {
    return jsonError(404, `${segs[0]} subpath not handled by ERP proxy`);
  }
  // `/api/customers*` now proxies natively to the ERP (CustomerApi). The old
  // BigQuery bridge (functions/api/customers/search.js) has been removed.

  const envName = (request.headers.get('X-Posku-Env') || 'test').toLowerCase();
  const target = ENVIRONMENTS[envName];
  if (!target) {
    return jsonError(400, `Unknown environment "${envName}". Use "test" or "live".`);
  }

  const apiKey = env[target.keyVar];
  if (!apiKey) {
    return jsonError(500, `Server missing ${target.keyVar} environment variable for ${envName} mode`);
  }

  const segments = Array.isArray(params.path)
    ? params.path
    : (params.path ? [params.path] : []);
  const reqUrl = new URL(request.url);
  const targetUrl = target.origin + '/api/' + segments.join('/') + reqUrl.search;

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
