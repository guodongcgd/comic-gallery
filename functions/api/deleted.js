// Cloudflare Pages Function: /api/deleted
// Tracks deleted comic IDs in D1 (no GitHub token needed)

export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }

  try {
    if (request.method === 'GET') {
      // Return all deleted comic IDs
      const { results } = await db.prepare(
        'SELECT comic_id, title, deleted_at FROM deleted_comics ORDER BY deleted_at DESC'
      ).all();
      return new Response(JSON.stringify({ deleted: results }), { headers });

    } else if (request.method === 'POST') {
      // Mark a comic as deleted
      const body = await request.json();
      const { comic_id, title } = body;
      if (comic_id === undefined || comic_id === null) {
        return new Response(JSON.stringify({ error: 'comic_id is required' }), { status: 400, headers });
      }
      // 收藏保护：收藏中的漫画不可被隐藏（服务端强制，前端跳过只是兜底）
      const fav = await db.prepare('SELECT 1 FROM favorites WHERE comic_id = ?').bind(comic_id).first();
      if (fav) {
        return new Response(
          JSON.stringify({ success: false, skipped: true, reason: 'favorite', comic_id }),
          { headers }
        );
      }
      await db.prepare(
        'INSERT OR IGNORE INTO deleted_comics (comic_id, deleted_at, title) VALUES (?, ?, ?)'
      ).bind(comic_id, new Date().toISOString(), title || '').run();
      return new Response(JSON.stringify({ success: true }), { headers });
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
  }
}
