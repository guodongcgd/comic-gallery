// Cloudflare Pages Function - PikPak Download API
// Processes comic download requests via PikPak's offline download feature

const PK_CLIENT_ID = 'YNxT9w7GMdWvEOKa';
const PK_CLIENT_SECRET = 'dbw2OtmVEeuUvIptb1Coyg';
const PK_AUTH_URL = 'https://user.mypikpak.com/v1/auth/signin';
const PK_API = 'https://api-drive.mypikpak.com/drive/v1/files';
const PK_TASK = 'https://api-drive.mypikpak.com/drive/v1/task';
const PK_SHARE = 'https://api-drive.mypikpak.com/drive/v1/share/shares';
const COMIC_ROOT = '漫画';  // PikPak folder name under root

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // CORS headers
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (request.method === 'POST') {
    return handleDownload(request, env, corsHeaders);
  }

  return new Response(JSON.stringify({ status: 'ok', message: 'PikPak Download API' }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function handleDownload(request, env, corsHeaders) {
  try {
    const body = await request.json();
    const { telegraph_url, title_cn, title_original } = body;
    if (!telegraph_url || !title_cn) {
      return new Response(JSON.stringify({ error: 'Missing required fields' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Step 1: Scrape Telegraph for image URLs
    const imageUrls = await scrapeTelegraph(telegraph_url);
    if (imageUrls.length === 0) {
      return new Response(JSON.stringify({ error: 'No images found on Telegraph page' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Step 2: Login to PikPak
    const accessToken = await pikpakLogin(env);
    if (!accessToken) {
      return new Response(JSON.stringify({ error: 'PikPak login failed' }), {
        status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Step 3: Find or create parent folder (漫画/)
    const rootId = await getRootFolderId(accessToken);
    const comicFolderId = await findOrCreateFolder(accessToken, rootId, COMIC_ROOT);

    // Step 4: Create comic-specific folder
    const folderName = sanitizeName(title_cn);
    const folderId = await findOrCreateFolder(accessToken, comicFolderId, folderName);

    // Step 5: Submit offline download tasks for all images
    const fileIds = [];
    for (let i = 0; i < imageUrls.length; i++) {
      const ext = imageUrls[i].split('.').pop()?.split('?')[0] || 'jpg';
      const fileName = `${String(i + 1).padStart(3, '0')}.${ext}`;
      const fileId = await createOfflineTask(accessToken, fileName, imageUrls[i], folderId);
      if (fileId) fileIds.push(fileId);
    }

    // Step 6: Create share link
    const shareUrl = await createShareLink(accessToken, folderId);

    return new Response(JSON.stringify({
      status: 'completed',
      share_url: shareUrl,
      total: imageUrls.length,
      folder: `/${COMIC_ROOT}/${folderName}`,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    return new Response(JSON.stringify({
      status: 'error',
      error: err.message || 'Unknown error',
    }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}

// ── Telegraph Scraper ──

async function scrapeTelegraph(url) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PikPakBot/1.0)' },
  });
  if (!resp.ok) throw new Error(`Telegraph fetch failed: ${resp.status}`);
  const html = await resp.text();

  const urls = [];
  // Pattern 1: <img src="/file/xxx.jpg"> or <img src="https://telegra.ph/file/xxx.jpg">
  const imgRegex = /<img[^>]+src="([^"]+)"/g;
  let match;
  while ((match = imgRegex.exec(html)) !== null) {
    let src = match[1];
    if (src.startsWith('/file/')) src = 'https://telegra.ph' + src;
    if (src.includes('telegra.ph') || /\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(src)) {
      if (!urls.includes(src)) urls.push(src);
    }
  }

  // Pattern 2: <figure> with <img> or <noscript> fallback
  if (urls.length === 0) {
    const allSrcRegex = /src="([^"]*telegra\.ph\/file\/[^"]+)"/g;
    while ((match = allSrcRegex.exec(html)) !== null) {
      if (!urls.includes(match[1])) urls.push(match[1]);
    }
  }

  return urls;
}

// ── PikPak Auth via Refresh Token ──

async function pikpakRefreshToken(env) {
  const refreshToken = env.PIKPAK_REFRESH_TOKEN;
  if (!refreshToken) throw new Error('PIKPAK_REFRESH_TOKEN not configured');

  const resp = await fetch('https://user.mypikpak.com/v1/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      client_id: PK_CLIENT_ID,
      client_secret: PK_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`PikPak token refresh failed: ${resp.status} ${text.slice(0, 200)}`);
  }

  const data = await resp.json();
  // If a new refresh_token is returned, use it for next time
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    console.log('New refresh token available (not persisted across Worker restarts)');
  }
  return data.access_token;
}

async function pikpakLogin(env) {
  return pikpakRefreshToken(env);
}

// ── PikPak File Operations ──

async function pikpakFetch(accessToken, url, options = {}) {
  const headers = {
    'Authorization': `Bearer ${accessToken}`,
    ...(options.headers || {}),
  };
  if (options.body && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json; charset=utf-8';
  }
  const resp = await fetch(url, { ...options, headers });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`PikPak API ${url} failed: ${resp.status} ${text.slice(0, 200)}`);
  }
  return resp.json();
}

async function getRootFolderId(accessToken) {
  // Get user's drive info - root folder ID from first page of files
  try {
    const data = await pikpakFetch(accessToken, `${PK_API}?parent_id=*&page_size=1`);
    if (data.files && data.files.length > 0) {
      // Files in root have parent_id as the root folder
      return data.files[0].parent_id || '';
    }
  } catch (e) {
    // Fallback: try to get folder by listing root without filter
  }
  
  // Try listing without parent_id filter
  try {
    const data = await pikpakFetch(accessToken, `${PK_API}?page_size=1`);
    if (data.files && data.files.length > 0) {
      return data.files[0].parent_id || '';
    }
  } catch (e) {}
  
  return '';  // Last resort: empty string
}

async function findOrCreateFolder(accessToken, parentId, name) {
  // Check if folder exists
  const filter = JSON.stringify({
    phase: { eq: { value: 1 } },
    trashed: { eq: { value: false } },
    name: { eq: { value: name } },
  });
  
  const listParent = parentId || '*';
  try {
    const data = await pikpakFetch(accessToken,
      `${PK_API}?parent_id=${encodeURIComponent(listParent)}&page_size=100&filters=${encodeURIComponent(filter)}`
    );
    
    if (data.files && data.files.length > 0) {
      const folder = data.files.find(f => f.kind === 'drive#folder');
      if (folder) return folder.id;
    }
  } catch (e) {
    // Folder doesn't exist, will create
  }

  // Create folder
  const folderData = await pikpakFetch(accessToken, PK_API, {
    method: 'POST',
    body: JSON.stringify({
      kind: 'drive#folder',
      name: name,
      parent_id: parentId || '*',
    }),
  });

  return folderData.file?.id || folderData.id;
}

async function createOfflineTask(accessToken, fileName, fileUrl, parentId) {
  const data = await pikpakFetch(accessToken, PK_TASK, {
    method: 'POST',
    body: JSON.stringify({
      kind: 'drive#file',
      name: fileName,
      upload_type: 'UPLOAD_TYPE_URL',
      url: { url: fileUrl },
      parent_id: parentId,
      folder_type: '',
    }),
  });
  return data.task_id || data.id || null;
}

async function createShareLink(accessToken, fileId) {
  // Create share
  const shareData = await pikpakFetch(accessToken, PK_SHARE, {
    method: 'POST',
    body: JSON.stringify({
      file_ids: [fileId],
      share_type: 'drive',
    }),
  });

  const shareId = shareData.share_id || shareData.id;
  
  if (shareData.share_url) return shareData.share_url;

  // Get share info to extract URL
  try {
    const info = await pikpakFetch(accessToken, `${PK_SHARE}/${shareId}`);
    return info.share_url || `https://mypikpak.com/s/${shareId}`;
  } catch {
    return `https://mypikpak.com/s/${shareId}`;
  }
}

function sanitizeName(name) {
  return name.replace(/[/\\:*?"<>|]/g, '').trim().slice(0, 100) || 'Unknown';
}
