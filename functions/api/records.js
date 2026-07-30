// Cloudflare Pages Function: /api/records
// D1-backed download record storage

export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;

  // CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  // Handle preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }

  try {
    if (request.method === 'GET') {
      // List all download records, newest first
      const { results } = await db.prepare(
        'SELECT comic_id, title, share_url, downloaded_at, pages FROM downloads ORDER BY downloaded_at DESC'
      ).all();

      return new Response(JSON.stringify({ records: results }), { headers });

    } else if (request.method === 'POST') {
      // Save or update a download record
      const body = await request.json();
      const { comic_id, title, share_url, pages } = body;

      if (!comic_id || !share_url) {
        return new Response(
          JSON.stringify({ error: 'comic_id and share_url are required' }),
          { status: 400, headers }
        );
      }

      await db.prepare(
        `INSERT OR REPLACE INTO downloads (comic_id, title, share_url, downloaded_at, pages)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(
        String(comic_id),
        title || '',
        share_url,
        new Date().toISOString(),
        pages || 0
      ).run();

      return new Response(JSON.stringify({ success: true }), { headers });
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers,
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers,
    });
  }
}
