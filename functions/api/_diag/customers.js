// TEMPORARY diagnostic route — DELETE before/with the customer recode.
//
// Purpose: verify the native ERP customer endpoints from an iPad (or any
// browser) without a shell. Runs server-side where the api-key lives, calls
// the same two endpoints the recode will use, and returns ONLY the response
// SHAPES — field names + whether address arrays are populated. No PII values
// are returned, so the URL is safe to open and paste back.
//
// Open (after deploy):
//   /api/_diag/customers?q=Smith            (TEST env, default)
//   /api/_diag/customers?q=Smith  + header X-Posku-Env: live   (LIVE)
//
// q = full_name search term (default "a").

const ENVIRONMENTS = {
  test: { origin: 'https://viatrading.biz',     keyVar: 'BIZ_API' },
  live: { origin: 'https://ops.viatrading.com', keyVar: 'ops_api_key' },
};

export async function onRequest(context) {
  const { request, env } = context;
  const reqUrl = new URL(request.url);
  const q = reqUrl.searchParams.get('q') || 'a';

  const envName = (request.headers.get('X-Posku-Env') || 'test').toLowerCase();
  const target = ENVIRONMENTS[envName];
  if (!target) return json(400, { error: `Unknown env "${envName}"` });
  const apiKey = env[target.keyVar];
  if (!apiKey) return json(500, { error: `Server missing ${target.keyVar}` });

  const hdr = { 'api-key': apiKey, 'Accept': 'application/json' };
  const out = { envUsed: envName, origin: target.origin, query: q };

  // 1) Search (typeahead) — should NOT include full addresses.
  const searchUrl = `${target.origin}/api/customers?is_customer=2,3&context=order_search&limit=5&full_name=${encodeURIComponent(q)}`;
  out.search = await probe(searchUrl, hdr, (data) => {
    const rows = rowsOf(data);
    const first = rows[0] || null;
    return {
      count: rows.length,
      data0_keys: first ? Object.keys(first) : [],
      // which fields the recode cares about are actually present:
      has: first ? {
        id: 'id' in first,
        first_name: 'first_name' in first,
        last_name: 'last_name' in first,
        email: 'email' in first,
        phone_number: 'phone_number' in first,
        phone: 'phone' in first,
        company_name: 'company_name' in first,
      } : null,
      includes_addresses: first ? Object.keys(first).some(k => /address/i.test(k)) : null,
      firstId: first ? (first.id ?? null) : null,
    };
  });

  // 2) Detail by id — addresses should appear here.
  const firstId = out.search && out.search.parsed && out.search.parsed.firstId;
  if (firstId != null) {
    const detailUrl = `${target.origin}/api/customers/${encodeURIComponent(firstId)}`;
    out.detail = await probe(detailUrl, hdr, (data) => {
      const rows = rowsOf(data);
      const rec = rows[0] || (Array.isArray(data) ? null : data) || null;
      const arrInfo = (key) => {
        const v = rec ? rec[key] : undefined;
        if (!Array.isArray(v)) return { present: !!v, isArray: false };
        return { present: true, isArray: true, count: v.length, item0_keys: v[0] ? Object.keys(v[0]) : [] };
      };
      return {
        data0_keys: rec ? Object.keys(rec) : [],
        billingAddressDetails: arrInfo('billingAddressDetails'),
        defaultAddressDetails: arrInfo('defaultAddressDetails'),
        shippingAddressDetails: arrInfo('shippingAddressDetails'),
      };
    });
  } else {
    out.detail = { skipped: 'no id from search' };
  }

  return json(200, out);
}

function rowsOf(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.data)) return data.data;
  if (data && data.data) return [data.data];
  return [];
}

async function probe(url, headers, summarize) {
  const res = { url };
  try {
    const r = await fetch(url, { headers });
    res.status = r.status;
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { res.parseError = true; res.raw = text.slice(0, 300); return res; }
    res.topLevelKeys = data && !Array.isArray(data) ? Object.keys(data) : `array(${Array.isArray(data) ? data.length : 0})`;
    res.parsed = summarize(data);
  } catch (e) {
    res.error = e.message;
  }
  return res;
}

function json(status, obj) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
