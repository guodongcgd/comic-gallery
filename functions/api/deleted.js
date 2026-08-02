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

      // 收藏保护：收藏中的漫画不可被隐藏（服务端强制）— 收藏表很小, 一次全查
      const favIds = new Set();
      const favRows = await db.prepare('SELECT comic_id FROM favorites').all();
      for (const r of favRows.results) favIds.add(r.comic_id);

      const now = new Date().toISOString();
      // 前端已直接传 telegraph_url/telegram_url, 无需再查 comics 表
      // 用 db.batch() 批量执行 INSERT — 一次 D1 调用执行最多 100 条语句, 彻底规避 invocation 调用次数限制
      const stmts = [];
      const base = db.prepare(
        'INSERT OR IGNORE INTO deleted_comics (comic_id, deleted_at, title, telegraph_url, telegram_url) VALUES (?, ?, ?, ?, ?)'
      );
      for (const it of items) {
        if (favIds.has(it.comic_id)) continue; // 收藏跳过
        stmts.push(base.bind(it.comic_id, now, it.title || '', it.telegraph_url || '', it.telegram_url || ''));
      }
      let hidden = 0;
      const BATCH = 100;
      for (let i = 0; i < stmts.length; i += BATCH) {
        const res = await db.batch(stmts.slice(i, i + BATCH));
        for (const r of res) hidden += r.meta.changes || 0;
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
