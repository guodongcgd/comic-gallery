// Cloudflare Pages Function: /api/records/:id (DELETE)

export async function onRequest(context) {
  const { request, env, params } = context;
  const db = env.DB;
  const comicId = params.id;

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }

  if (request.method === 'DELETE') {
    try {
      await db.prepare('DELETE FROM downloads WHERE comic_id = ?').bind(comicId).run();
      return new Response(JSON.stringify({ success: true }), { headers });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
    }
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), {
    status: 405,
    headers,
  });
}
