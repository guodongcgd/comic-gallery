// Cloudflare Pages Function: /api/comics
// D1-backed comic data API - replaces static comics.json

export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }

  try {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');

    // --- HIDDEN LIST ---
    // GET /api/comics/hidden — full records of hidden comics (JOIN comics)
    if (path.endsWith('/hidden')) {
      const { results } = await db.prepare(
        `SELECT c.* FROM comics c JOIN deleted_comics d ON c.id = d.comic_id ORDER BY d.deleted_at DESC`
      ).all();
      for (const row of results) {
        if (typeof row.tags === 'string') {
          try { row.tags = JSON.parse(row.tags); } catch (_) { row.tags = []; }
        }
      }
      return new Response(JSON.stringify({ comics: results, total: results.length }), { headers });
    }

    // --- RESTORE ---
    // POST /api/comics/restore — batch restore hidden comics
    if (path.endsWith('/restore') && request.method === 'POST') {
      const body = await request.json();
      const ids = (Array.isArray(body) ? body : (body.ids || [])).map(Number).filter(Boolean);
      if (!ids.length) {
        return new Response(JSON.stringify({ restored: 0 }), { headers });
      }
      // 安全保险：恢复前先把即将删除的记录备份到 deleted_comics_backup（防误恢复不可逆）
      const now = new Date().toISOString();
      const BATCH = 90;
      let restored = 0;
      for (let i = 0; i < ids.length; i += BATCH) {
        const chunk = ids.slice(i, i + BATCH);
        const placeholders = chunk.map(() => '?').join(',');
        // 1) 备份即将删除的记录（INSERT OR IGNORE, 重复备份不覆盖）
        await db.prepare(
          `INSERT OR IGNORE INTO deleted_comics_backup (comic_id, deleted_at, title, telegraph_url, telegram_url, backed_up_at)
           SELECT comic_id, deleted_at, title, telegraph_url, telegram_url, ? FROM deleted_comics WHERE comic_id IN (${placeholders})`
        ).bind(now, ...chunk).run();
        // 2) 删除
        const { meta } = await db.prepare(
          `DELETE FROM deleted_comics WHERE comic_id IN (${placeholders})`
        ).bind(...chunk).run();
        restored += meta.changes ?? chunk.length;
      }
      return new Response(JSON.stringify({ restored, backedUp: true }), { headers });
    }

    // POST /api/comics/restore/undo — undo a restore: put records back from backup
    // body: {ids: [...]} 或 {all: true}（全部撤回）
    if (path.endsWith('/restore/undo') && request.method === 'POST') {
      const body = await request.json();
      let where = '';
      let params = [];
      if (body.all) {
        where = '';
      } else {
        const ids = (Array.isArray(body) ? body : (body.ids || [])).map(Number).filter(Boolean);
        if (!ids.length) return new Response(JSON.stringify({ restored: 0 }), { headers });
        const BATCH = 90;
        let undone = 0;
        for (let i = 0; i < ids.length; i += BATCH) {
          const chunk = ids.slice(i, i + BATCH);
          const placeholders = chunk.map(() => '?').join(',');
          await db.prepare(
            `INSERT OR IGNORE INTO deleted_comics (comic_id, deleted_at, title, telegraph_url, telegram_url)
             SELECT comic_id, deleted_at, title, telegraph_url, telegram_url FROM deleted_comics_backup WHERE comic_id IN (${placeholders})`
          ).bind(...chunk).run();
          const { meta } = await db.prepare(
            `DELETE FROM deleted_comics_backup WHERE comic_id IN (${placeholders})`
          ).bind(...chunk).run();
          undone += meta.changes ?? chunk.length;
        }
        return new Response(JSON.stringify({ undone }), { headers });
      }
      // all: 全部撤回备份
      await db.prepare(
        `INSERT OR IGNORE INTO deleted_comics (comic_id, deleted_at, title, telegraph_url, telegram_url)
         SELECT comic_id, deleted_at, title, telegraph_url, telegram_url FROM deleted_comics_backup`
      ).run();
      const { meta } = await db.prepare('DELETE FROM deleted_comics_backup').run();
      return new Response(JSON.stringify({ undone: meta.changes ?? 0 }), { headers });
    }

    // --- STATS ---
    // GET /api/comics/stats
    if (path.endsWith('/stats')) {
      const { results } = await db.prepare(
        'SELECT tags, author, circle FROM comics WHERE id NOT IN (SELECT comic_id FROM deleted_comics)'
      ).all();

      const tagCount = {};
      const authorCount = {};
      const circleCount = {};
      for (const row of results) {
        const author = (row.author || '').trim();
        if (author) {
          authorCount[author] = (authorCount[author] || 0) + 1;
        }
        const circle = (row.circle || '').trim();
        if (circle) {
          circleCount[circle] = (circleCount[circle] || 0) + 1;
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

      const circles = Object.entries(circleCount)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);

      return new Response(JSON.stringify({ tags, authors, circles }), { headers });
    }

    // --- LIST ---
    // GET /api/comics
    if (request.method === 'GET') {
      const page = parseInt(url.searchParams.get('page')) || 1;
      const size = parseInt(url.searchParams.get('size')) || 0; // 0 = all
      const search = url.searchParams.get('search') || '';
      const author = url.searchParams.get('author') || '';
      const tag = url.searchParams.get('tag') || '';
      const circle = url.searchParams.get('circle') || '';

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
      if (circle) {
        conditions.push('circle = ?');
        params.push(circle);
      }
      if (tag) {
        conditions.push("tags LIKE ?");
        params.push(`%"${tag}"%`);
      }

      if (conditions.length > 0) {
        sql += ' AND ' + conditions.join(' AND ');
      }

      sql += ' ORDER BY published_at DESC, id DESC';

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
             SELECT COUNT(*) FROM deleted_comics WHERE telegraph_url = ? OR telegram_url = ?`
          ).bind(telegramUrl, telegraphUrl, telegraphUrl, telegramUrl).all();
          const totalCnt = results.reduce((sum, r) => sum + Object.values(r)[0], 0);
          if (totalCnt > 0) {
            continue; // Already exists or was deleted, skip
          }
        }
        const tagsJson = JSON.stringify(c.tags || []);
        await db.prepare(
          `INSERT OR IGNORE INTO comics 
           (title_cn, title_original, title_raw, cover_url, author, circle,
            language, original_work, tags,
            telegraph_url, telegram_url, file_id, published_at, pages, stars)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          c.title_cn || '',
          c.title_original || '',
          c.title_raw || '',
          c.cover_url || '',
          c.author || '',
          c.circle || '',
          c.language || '',
          c.original_work || '',
          tagsJson,
          c.telegraph_url || '',
          c.telegram_url || '',
          c.file_id || '',
          c.published_at || '',
          c.pages || 0,
          c.stars || 0
        ).run();
        added++;
      }

      return new Response(JSON.stringify({ success: true, added }), { headers });
    }

    // --- UPDATE TAGS ---
    // PATCH /api/comics/:id  {tags: [...]}  — 替换整组标签
    // PATCH /api/comics       {items: [{id, tags: [...]}, ...]}  — 批量
    if (request.method === 'PATCH') {
      const body = await request.json();
      let updated = 0;

      const applyTags = async (id, tags) => {
        if (!Array.isArray(tags)) return false;
        const clean = tags.map(t => String(t).trim()).filter(Boolean);
        const dedup = [...new Set(clean)];
        const tagsJson = JSON.stringify(dedup);
        const r = await db.prepare(
          'UPDATE comics SET tags = ? WHERE id = ?'
        ).bind(tagsJson, id).run();
        return r.meta.changes > 0;
      };

      if (body.items && Array.isArray(body.items)) {
        for (const it of body.items) {
          if (await applyTags(it.id, it.tags)) updated++;
        }
      } else {
        const id = Number(url.searchParams.get('id') || body.id);
        if (id && await applyTags(id, body.tags)) updated++;
      }

      return new Response(JSON.stringify({ success: true, updated }), { headers });
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
