// Cloudflare Pages Function: /api/cover
// Proxies comic cover images and caches them on the Cloudflare edge CDN.
// Usage: /api/cover?u=<encoded original url>
const ALLOWED = /^(telegra\.ph|img[0-9]*\.teletype\.in|teletype\.in|i[0-9]\.wp\.com|gateway\.ipfsscan\.io)$/i;

export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);
  const target = url.searchParams.get('u');
  if (!target) {
    return new Response('missing u', { status: 400 });
  }
  let upstream;
  try {
    upstream = new URL(target);
  } catch (_) {
    return new Response('bad url', { status: 400 });
  }
  if (upstream.protocol !== 'https:' || !ALLOWED.test(upstream.hostname)) {
    return new Response('forbidden', { status: 403 });
  }

  const cache = caches.default;
  const cacheKey = new Request(request.url, { method: 'GET' });

  // 1. try edge cache
  const cached = await cache.match(cacheKey);
  if (cached) {
    return cached;
  }

  // 2. fetch upstream
  let resp;
  try {
    resp = await fetch(upstream.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ComicGallery/1.0)' },
      cf: { cacheTtl: 604800 },
    });
  } catch (_) {
    return new Response('upstream unreachable', { status: 502 });
  }
  if (!resp.ok) {
    return new Response('upstream error ' + resp.status, { status: 502 });
  }
  if (!resp.headers.get('content-type') || !resp.headers.get('content-type').startsWith('image/')) {
    return new Response('not an image', { status: 502 });
  }

  const body = await resp.arrayBuffer();
  const headers = new Headers();
  const ct = resp.headers.get('content-type') || 'image/jpeg';
  headers.set('Content-Type', ct);
  headers.set('Cache-Control', 'public, max-age=86400, s-maxage=604800');
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Content-Length', String(body.byteLength));
  const out = new Response(body, { status: 200, headers });

  // 3. store in edge cache (async, don't block response)
  context.waitUntil(cache.put(cacheKey, out.clone()));
  // 4. usage counter (async, best-effort) — 图片代理请求量统计
  context.waitUntil(
    (async () => {
      try {
        const db = context.env.DB;
        if (db) {
          const today = new Date().toISOString().slice(0, 10);
          await db.prepare(
            `INSERT INTO cf_usage (date, cover_requests, cover_bytes) VALUES (?, 1, ?)
             ON CONFLICT(date) DO UPDATE SET cover_requests = cover_requests + 1, cover_bytes = cover_bytes + excluded.cover_bytes`
          ).bind(today, body.byteLength).run();
        }
      } catch (_) { /* counter is best-effort */ }
    })()
  );
  return out;
}
