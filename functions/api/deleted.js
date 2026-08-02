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
      // Mark comic(s) as deleted — 支持批量: {items:[{comic_id,title}]} 或 {comic_ids:[...]} 或单条 {comic_id,title}
      const body = await request.json();
      let items = [];
      if (Array.isArray(body.items)) {
        items = body.items.map(i => ({ comic_id: i.comic_id, title: i.title || '' }));
      } else if (Array.isArray(body.comic_ids)) {
        items = body.comic_ids.map(id => ({ comic_id: id, title: '' }));
      } else if (body.comic_id !== undefined && body.comic_id !== null) {
        items = [{ comic_id: body.comic_id, title: body.title || '' }];
      }
      if (!items.length) {
        return new Response(JSON.stringify({ error: 'comic_id is required' }), { status: 400, headers });
      }

      // 收藏保护：收藏中的漫画不可被隐藏（服务端强制）——按 D1 变量上限分批(每批90)
      const favIds = new Set();
      const BATCH = 90;
      for (let i = 0; i < items.length; i += BATCH) {
        const chunk = items.slice(i, i + BATCH);
        const favRows = await db.prepare(
          `SELECT comic_id FROM favorites WHERE comic_id IN (${chunk.map(() => '?').join(',')})`
        ).bind(...chunk.map(x => x.comic_id)).all();
        for (const r of favRows.results) favIds.add(r.comic_id);
      }

      const now = new Date().toISOString();
      let hidden = 0;
      const stmt = db.prepare(
        'INSERT OR IGNORE INTO deleted_comics (comic_id, deleted_at, title) VALUES (?, ?, ?)'
      );
      // 先取这些漫画的 telegraph_url/telegram_url（按批查询）
      const urlMap = {};
      for (let i = 0; i < items.length; i += BATCH) {
        const chunk = items.slice(i, i + BATCH);
        const urlRows = await db.prepare(
          `SELECT id, telegraph_url, telegram_url FROM comics WHERE id IN (${chunk.map(() => '?').join(',')})`
        ).bind(...chunk.map(x => x.comic_id)).all();
        for (const r of urlRows.results) urlMap[r.id] = r;
      }

      const updStmt = db.prepare(
        'UPDATE deleted_comics SET telegraph_url = ?, telegram_url = ? WHERE comic_id = ?'
      );
      for (const it of items) {
        if (favIds.has(it.comic_id)) continue; // 收藏跳过
        const r = await stmt.bind(it.comic_id, now, it.title || '').run();
        if (r.meta.changes > 0) hidden++; // 仅统计真实新增
        const c = urlMap[it.comic_id];
        if (c && (c.telegraph_url || c.telegram_url)) {
          await updStmt.bind(c.telegraph_url || '', c.telegram_url || '', it.comic_id).run();
        }
      }
      const skipped = items.length - hidden;
      return new Response(JSON.stringify({
        success: true, hidden,
        skipped, skippedFavorite: favIds.size,
      }), { headers });
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
  }
}
