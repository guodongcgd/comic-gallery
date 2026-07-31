// Cloudflare Pages Function: /api/favorites
// Favorites stored in D1 (cross-device, persistent).
// GET  /api/favorites            -> { ids: [comic_id, ...] }
// POST /api/favorites {comic_id} -> add one (INSERT OR IGNORE)
// POST /api/favorites {ids:[...]}-> batch add
// DELETE /api/favorites?comic_id=N -> remove

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const method = request.method;
  const db = env.DB;

  if (method === 'OPTIONS') {
    return new Response(null, { headers: JSON_HEADERS });
  }

  if (method === 'GET') {
    const { results } = await db.prepare(
      'SELECT comic_id FROM favorites ORDER BY created_at DESC'
    ).all();
    return new Response(JSON.stringify({ ids: results.map((r) => r.comic_id) }), {
      headers: JSON_HEADERS,
    });
  }

  if (method === 'POST') {
    const body = await request.json();
    const ids = Array.isArray(body)
      ? body
      : Array.isArray(body.ids)
        ? body.ids
        : body.comic_id
          ? [body.comic_id]
          : [];
    if (!ids.length) {
      return new Response(JSON.stringify({ ok: true, added: 0 }), { headers: JSON_HEADERS });
    }
    const stmt = db.prepare(
      'INSERT OR IGNORE INTO favorites (comic_id, created_at) VALUES (?, ?)'
    );
    const now = new Date().toISOString();
    for (const id of ids) {
      await stmt.bind(Number(id), now).run();
      // 收藏 = 必须可见：自动解除该漫画的隐藏状态（先隐藏后收藏的场景）
      await db.prepare('DELETE FROM deleted_comics WHERE comic_id = ?').bind(Number(id)).run();
    }
    return new Response(JSON.stringify({ ok: true, added: ids.length }), { headers: JSON_HEADERS });
  }

  if (method === 'DELETE') {
    const id = Number(url.searchParams.get('comic_id'));
    if (!id) {
      return new Response(JSON.stringify({ ok: false, error: 'comic_id required' }), {
        status: 400,
        headers: JSON_HEADERS,
      });
    }
    await db.prepare('DELETE FROM favorites WHERE comic_id = ?').bind(id).run();
    return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
  }

  return new Response('method not allowed', { status: 405, headers: JSON_HEADERS });
}
