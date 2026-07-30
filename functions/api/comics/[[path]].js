// Cloudflare Pages Function: /api/comics
// D1-backed comic data API - replaces static comics.json

export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }

  try {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');

    // --- STATS ---
    // GET /api/comics/stats
    if (path.endsWith('/stats')) {
      // Load all tags and authors from DB to compute counts
      const { results } = await db.prepare(
        'SELECT tags, author FROM comics WHERE id NOT IN (SELECT comic_id FROM deleted_comics)'
      ).all();

      const tagCount = {};
      const authorCount = {};
      for (const row of results) {
        const author = (row.author || '').trim();
        if (author) {
          authorCount[author] = (authorCount[author] || 0) + 1;
        }
        try {
          const tags = JSON.parse(row.tags || '[]');
          for (const tag of tags) {
            tagCount[tag] = (tagCount[tag] || 0) + 1;
          }
        } catch (_) { /* skip invalid JSON tags */ }
      }

      const tags = Object.entries(tagCount)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);

      const authors = Object.entries(authorCount)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);

      return new Response(JSON.stringify({ tags, authors }), { headers });
    }

    // --- LIST ---
    // GET /api/comics
    if (request.method === 'GET') {
      const page = parseInt(url.searchParams.get('page')) || 1;
      const size = parseInt(url.searchParams.get('size')) || 0; // 0 = all
      const search = url.searchParams.get('search') || '';
      const author = url.searchParams.get('author') || '';
      const tag = url.searchParams.get('tag') || '';

      let sql = 'SELECT * FROM comics WHERE id NOT IN (SELECT comic_id FROM deleted_comics)';
      const params = [];
      const conditions = [];

      if (search) {
        conditions.push('(title_cn LIKE ? OR title_original LIKE ? OR author LIKE ?)');
        const s = `%${search}%`;
        params.push(s, s, s);
      }
      if (author) {
        conditions.push('author = ?');
        params.push(author);
      }
      if (tag) {
        conditions.push("tags LIKE ?");
        params.push(`%"${tag}"%`);
      }

      if (conditions.length > 0) {
        sql += ' AND ' + conditions.join(' AND ');
      }

      sql += ' ORDER BY id DESC';

      if (size > 0) {
        const offset = (page - 1) * size;
        sql += ` LIMIT ${size} OFFSET ${offset}`;
      }

      const stmt = db.prepare(sql);
      const bound = stmt.bind(...params);
      const { results } = await bound.all();

      // Parse tags JSON string to array for all results
      for (const row of results) {
        if (typeof row.tags === 'string') {
          try {
            row.tags = JSON.parse(row.tags);
          } catch (_) { row.tags = []; }
        }
      }

      return new Response(JSON.stringify({ comics: results }), { headers });
    }

    // --- ADD (from sync script) ---
    // POST /api/comics
    if (request.method === 'POST') {
      const body = await request.json();
      const comics = Array.isArray(body) ? body : (body.comics ? body.comics : [body]);

      let added = 0;
      for (const c of comics) {
        // Skip if this comic was already imported or deleted (check by telegram_url)
        const telegramUrl = c.telegram_url || '';
        const telegraphUrl = c.telegraph_url || '';
        if (telegramUrl || telegraphUrl) {
          const { results } = await db.prepare(
            `SELECT COUNT(*) as cnt FROM comics WHERE telegram_url = ? OR telegraph_url = ?
             UNION ALL
             SELECT COUNT(*) FROM deleted_comics WHERE telegram_url = ?`
          ).bind(telegramUrl, telegraphUrl, telegramUrl).all();
          const totalCnt = results.reduce((sum, r) => sum + Object.values(r)[0], 0);
          if (totalCnt > 0) {
            continue; // Already exists or was deleted, skip
          }
        }
        const tagsJson = JSON.stringify(c.tags || []);
        await db.prepare(
          `INSERT OR IGNORE INTO comics 
           (id, title_cn, title_original, cover_url, author, tags,
            telegraph_url, telegram_url, published_at, pages, stars)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          c.id,
          c.title_cn || '',
          c.title_original || '',
          c.cover_url || '',
          c.author || '',
          tagsJson,
          c.telegraph_url || '',
          c.telegram_url || '',
          c.published_at || '',
          c.pages || 0,
          c.stars || 0
        ).run();
        added++;
      }

      return new Response(JSON.stringify({ success: true, added }), { headers });
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers,
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers,
    });
  }
}
