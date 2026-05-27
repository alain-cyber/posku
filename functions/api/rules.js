// Cloudflare Pages Function — master rules store (KV-backed).
//
// Single source of truth for app rules, shared across all users.
// GET  /api/rules  → { ok, rules: { WYF: {...}, SMS: {...} } }
// PUT  /api/rules  ← whole rules object; replaces.
//
// Bind a KV namespace called POSKU_RULES in Pages → Settings → Functions →
// KV namespace bindings. Until bound, the app falls back to the JS defaults
// (so the app keeps working even before this is set up).

export async function onRequest(context) {
  const { request, env } = context;
  if (!env.POSKU_RULES) {
    return json(500, {
      ok: false,
      error: 'KV namespace POSKU_RULES is not bound. Add it in Cloudflare Pages → Settings → Functions → KV namespace bindings, then redeploy.',
    });
  }

  if (request.method === 'GET') {
    const rules = await env.POSKU_RULES.get('rules', 'json');
    return json(200, { ok: true, rules: rules || {} });
  }

  if (request.method === 'PUT') {
    let body;
    try { body = await request.json(); }
    catch { return json(400, { ok: false, error: 'Body must be JSON' }); }
    if (typeof body !== 'object' || body === null) {
      return json(400, { ok: false, error: 'Body must be a JSON object' });
    }
    await env.POSKU_RULES.put('rules', JSON.stringify(body));
    return json(200, { ok: true });
  }

  return json(405, { ok: false, error: 'Method not allowed' });
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
