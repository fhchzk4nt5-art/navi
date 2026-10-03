// 最強カーナビ サーバー（Cloudflare Workers）
// 役割：サブスクの確認（Stripe）、ルート検索・行き先検索（Mapbox）、曲がる場所の写真（Mapillary）
// 秘密のキーはすべて Cloudflare の「変数とシークレット」に入れる。このファイルには書かない。
//
// 必要な変数：
//   STRIPE_SECRET_KEY  Stripe のシークレットキー（テスト中は sk_test_...）
//   STRIPE_PRICE_ID    月額プランの価格ID（price_...）
//   TRIAL_DAYS         無料お試しの日数（例 7。なしなら空）
//   MAPBOX_TOKEN       Mapbox のアクセストークン（サーバー用）
//   MAPILLARY_TOKEN    Mapillary のクライアントトークン（MLY|...）
//   LICENSE_SECRET     購入コードの署名に使う長いランダム文字列
//   APP_URL            アプリのURL（例 https://fhchzk4nt5-art.github.io/navi/）

export default {
  async fetch(req, env, ctx) {
    const origin = req.headers.get('Origin') || '';
    const appOrigin = new URL(env.APP_URL).origin;
    const cors = {
      'Access-Control-Allow-Origin': origin === appOrigin ? origin : appOrigin,
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Vary': 'Origin'
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    let res;
    try { res = await handle(new URL(req.url), req, env, ctx); }
    catch (e) { res = json({ error: 'server', message: String(e && e.message || e) }, 500); }
    const h = new Headers(res.headers);
    for (const k in cors) h.set(k, cors[k]);
    return new Response(res.body, { status: res.status, headers: h });
  }
};

async function handle(url, req, env, ctx) {
  const p = url.pathname.replace(/\/+$/, '');
  if (p === '' || p === '/api') return json({ ok: true, name: 'navi-api' });

  if (p === '/api/checkout' && req.method === 'POST') {
    const params = {
      mode: 'subscription',
      'line_items[0][price]': env.STRIPE_PRICE_ID,
      'line_items[0][quantity]': '1',
      success_url: env.APP_URL + '?paid={CHECKOUT_SESSION_ID}',
      cancel_url: env.APP_URL,
      locale: 'ja',
      allow_promotion_codes: 'true'
    };
    if (env.TRIAL_DAYS && Number(env.TRIAL_DAYS) > 0) params['subscription_data[trial_period_days]'] = String(Number(env.TRIAL_DAYS));
    const s = await stripe(env, 'POST', 'checkout/sessions', params);
    return json({ url: s.url });
  }

  if (p === '/api/claim') {
    const id = url.searchParams.get('session_id') || '';
    if (!/^cs_[A-Za-z0-9_]+$/.test(id)) return json({ error: 'bad_session' }, 400);
    const s = await stripe(env, 'GET', 'checkout/sessions/' + id);
    if (s.status !== 'complete' || !s.customer) return json({ error: 'not_paid' }, 402);
    return json({ token: await sign(env, s.customer) });
  }

  // ここから先は購入コードが必要
  const cus = await verify(env, (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, ''));
  if (!cus) return json({ error: 'no_license' }, 401);

  if (p === '/api/portal' && req.method === 'POST') {
    const s = await stripe(env, 'POST', 'billing_portal/sessions', { customer: cus, return_url: env.APP_URL, locale: 'ja' });
    return json({ url: s.url });
  }

  const sub = await subscription(env, cus, ctx);
  if (p === '/api/status') return json(sub);
  if (!sub.active) return json({ error: 'inactive', status: sub.status }, 402);

  if (p === '/api/route') {
    const from = coord(url.searchParams.get('from')), to = coord(url.searchParams.get('to'));
    if (!from || !to) return json({ error: 'bad_coords' }, 400);
    const bearing = url.searchParams.get('bearing');
    const q = new URLSearchParams({
      alternatives: bearing ? 'false' : 'true', geometries: 'geojson', overview: 'full', steps: 'true',
      language: 'ja', annotations: 'maxspeed,congestion', access_token: env.MAPBOX_TOKEN
    });
    if (bearing && !isNaN(Number(bearing))) { q.set('bearings', Math.round(Number(bearing)) + ',60;'); q.set('radiuses', '40;unlimited'); }
    const r = await fetch('https://api.mapbox.com/directions/v5/mapbox/driving-traffic/' + from + ';' + to + '?' + q);
    return new Response(r.body, { status: r.status, headers: { 'Content-Type': 'application/json' } });
  }

  if (p === '/api/search') {
    const q = (url.searchParams.get('q') || '').slice(0, 120);
    if (!q) return json([]);
    const near = coord(url.searchParams.get('near'));
    const params = new URLSearchParams({ country: 'jp', language: 'ja', limit: '6', types: 'poi,address,place,locality,neighborhood', access_token: env.MAPBOX_TOKEN });
    if (near) params.set('proximity', near);
    const r = await fetch('https://api.mapbox.com/geocoding/v5/mapbox.places/' + encodeURIComponent(q) + '.json?' + params);
    const j = await r.json();
    return json((j.features || []).map(f => ({ name: f.text, full: f.place_name, lon: f.center[0], lat: f.center[1] })));
  }

  if (p === '/api/photo') {
    const lat = Number(url.searchParams.get('lat')), lon = Number(url.searchParams.get('lon')), hd = Number(url.searchParams.get('heading'));
    if (!isFinite(lat) || !isFinite(lon) || !isFinite(hd)) return json({ error: 'bad_params' }, 400);
    const key = new Request('https://cache.navi/photo/' + lat.toFixed(4) + ',' + lon.toFixed(4) + ',' + Math.round(hd / 15));
    const hit = await caches.default.match(key);
    if (hit) return hit;
    const photo = await mapillary(env.MAPILLARY_TOKEN, lat, lon, hd);
    const res = json(photo, 200, { 'Cache-Control': 'public, max-age=3600' });
    ctx.waitUntil(caches.default.put(key, res.clone()));
    return res;
  }

  return json({ error: 'not_found' }, 404);
}

/* ---------- Stripe ---------- */
async function stripe(env, method, path, params) {
  const init = { method, headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY } };
  let u = 'https://api.stripe.com/v1/' + path;
  if (params && method === 'GET') u += '?' + new URLSearchParams(params);
  else if (params) { init.body = new URLSearchParams(params); init.headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
  const r = await fetch(u, init);
  const j = await r.json();
  if (!r.ok) throw new Error('stripe: ' + (j.error && j.error.message || r.status));
  return j;
}
async function subscription(env, cus, ctx) {
  const key = new Request('https://cache.navi/sub/' + cus);
  const hit = await caches.default.match(key);
  if (hit) return hit.json();
  const list = await stripe(env, 'GET', 'subscriptions', { customer: cus, status: 'all', limit: '10' });
  const subs = list.data || [];
  const live = subs.find(s => s.status === 'active' || s.status === 'trialing');
  const out = live
    ? { active: true, status: live.status, trialEnd: live.trial_end || null, periodEnd: live.current_period_end || (live.items && live.items.data[0] && live.items.data[0].current_period_end) || null, cancelAtEnd: !!live.cancel_at_period_end }
    : { active: false, status: subs[0] ? subs[0].status : 'none' };
  ctx.waitUntil(caches.default.put(key, json(out, 200, { 'Cache-Control': 'public, max-age=600' })));
  return out;
}

/* ---------- 購入コード（顧客IDに署名を付けたもの） ---------- */
async function hmac(env, text) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.LICENSE_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(text)));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function sign(env, cus) { return cus + '.' + await hmac(env, cus); }
async function verify(env, token) {
  const m = /^(cus_[A-Za-z0-9]+)\.([A-Za-z0-9_-]+)$/.exec(token || '');
  if (!m) return null;
  const expect = await hmac(env, m[1]);
  if (expect.length !== m[2].length) return null;
  let diff = 0; for (let i = 0; i < expect.length; i++) diff |= expect.charCodeAt(i) ^ m[2].charCodeAt(i);
  return diff === 0 ? m[1] : null;
}

/* ---------- Mapillary：交差点の手前から、進む向きに近い写真を選ぶ ---------- */
async function mapillary(token, lat, lon, hd) {
  const d = 0.0004;
  const q = new URLSearchParams({ access_token: token, fields: 'id,thumb_1024_url,computed_compass_angle,compass_angle,computed_geometry,geometry,is_pano', bbox: [lon - d, lat - d, lon + d, lat + d].join(','), limit: '60' });
  const r = await fetch('https://graph.mapillary.com/images?' + q);
  if (!r.ok) return { url: null };
  const j = await r.json();
  let best = null, bestScore = 1e9;
  for (const im of (j.data || [])) {
    if (im.is_pano || !im.thumb_1024_url) continue;
    const g = (im.computed_geometry || im.geometry || {}).coordinates; if (!g) continue;
    const ang = im.computed_compass_angle != null ? im.computed_compass_angle : im.compass_angle;
    if (ang == null) continue;
    const da = Math.abs(((ang - hd + 540) % 360) - 180); if (da > 50) continue;
    const dm = Math.hypot((g[0] - lon) * 111320 * Math.cos(lat * Math.PI / 180), (g[1] - lat) * 110540);
    const score = dm + da * 0.8;
    if (score < bestScore) { bestScore = score; best = im; }
  }
  return best ? { url: best.thumb_1024_url, id: best.id, by: 'Mapillary' } : { url: null };
}

/* ---------- 共通 ---------- */
function coord(s) {
  const m = /^(-?\d{1,3}\.\d+),(-?\d{1,2}\.\d+)$/.exec(s || '');
  return m ? Number(m[1]).toFixed(6) + ',' + Number(m[2]).toFixed(6) : null;
}
function json(obj, status, extra) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, extra || {}) });
}
