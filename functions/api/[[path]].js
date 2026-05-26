// Cloudflare Pages Function — Posku API proxy.
//
// Forwards any /api/* request from the browser to viatrading.biz/api/*,
// injecting the API key from the Pages env var VIA_API_KEY.
// The browser never sees the API key, and same-origin avoids CORS.

const TARGET_ORIGIN = 'https://viatrading.biz';

export async function onRequest(context) {
  const { request, env, params } = context;

  if (!env.VIA_API_KEY) {
    return jsonError(500, 'Server missing VIA_API_KEY environment variable');
  }

  const segments = Array.isArray(params.path)
    ? params.path
    : (params.path ? [params.path] : []);
  const reqUrl = new URL(request.url);
  const targetUrl = TARGET_ORIGIN + '/api/' + segments.join('/') + reqUrl.search;

  const headers = new Headers();
  headers.set('api-key', env.VIA_API_KEY);
  const ct = request.headers.get('Content-Type');
  headers.set('Content-Type', ct || 'application/json');
  // Pass through Accept so we honor JSON / text preferences from the client.
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
    return jsonError(502, `Upstream fetch failed: ${err.message}`);
  }

  const respBody = await upstream.text();
  return new Response(respBody, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
