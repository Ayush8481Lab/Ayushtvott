const express = require('express');
const axios = require('axios');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── PROXY CONFIGURATION ─────────────────────────────────────────
const PROXY_BASE = 'https://ayushproxy-blue.vercel.app/api/proxy/';

// ─── API TARGET PARAMETERS (exact order) ─────────────────────────
const API_TARGET_BASE = 'https://api.mxplayer.in/v1/web/detail/browseItem';
const QUERY_PARAMS = [
  ['pageNum', ''],
  ['pageSize', ''],
  ['isCustomized', 'true'],
  ['browseLangFilterIds', 'hi'],
  ['type', '1'],
  ['device-density', '1'],
  ['userid', '6d4a1a2c-5f2a-4f46-be26-901f8801dc88'],
  ['platform', 'com.mxplay.mobile'],
  ['content-languages', 'hi,en'],
  ['kids-mode-enabled', 'false']
];

function buildProxyUrl(pageNum, pageSize) {
  const queryParts = QUERY_PARAMS.map(([key, val]) => {
    if (key === 'pageNum') return `pageNum=${pageNum}`;
    if (key === 'pageSize') return `pageSize=${pageSize}`;
    return `${key}=${val}`;
  });
  const targetQuery = queryParts.join('&');
  const targetUrl = `${API_TARGET_BASE}?${targetQuery}`;
  const proxyPath = targetUrl.replace('https://', 'https:/');
  return `${PROXY_BASE}${proxyPath}`;
}

// ─── IN-MEMORY CACHE ─────────────────────────────────────────────
let cachedPlaylist = null;
let cachedTotalCount = null;
let isBuilding = false;

// ─── HELPERS ──────────────────────────────────────────────────────
function buildImageUrl(imagePath, size = null) {
  if (!imagePath) return '';
  if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
    return imagePath;
  }
  let path = imagePath.startsWith('/') ? imagePath.slice(1) : imagePath;

  if (size) {
    const matches = [...path.matchAll(/\d+x\d+/g)];
    if (matches.length > 0) {
      const lastMatch = matches[matches.length - 1];
      const { index, 0: match } = lastMatch;
      path = path.slice(0, index) + size + path.slice(index + match.length);
    }
  }

  return `https://qqcdnpictest.mxplay.com/${path}`;
}

// Updated stream URL builder: prioritizes DASH (.mpd)
function buildStreamUrl(item) {
  const stream = item.stream;
  if (!stream) return '';

  let path = stream.thirdParty?.dashUrl ||
             stream.dash?.high ||
             stream.dash?.main ||
             stream.mxplay?.dash?.high;

  if (!path) {
    path = stream.thirdParty?.hlsUrl ||
           stream.thirdParty?.webHlsUrl ||
           stream.hls?.high ||
           stream.hls?.main ||
           stream.mxplay?.hls?.high;
  }

  if (!path && stream.videoHash) {
    path = `video/${stream.videoHash}/2/dash/h264_high.mpd`;
  }

  if (!path) return '';
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path;
  }
  path = path.startsWith('/') ? path.slice(1) : path;
  return `https://d3sgzbosmwirao.cloudfront.net/${path}`;
}

// ─── FETCH TOTAL COUNT ───────────────────────────────────────────
async function fetchTotalCount() {
  const url = buildProxyUrl(0, 2);
  console.log(`[CHECK] ${url}`);
  const response = await axios.get(url, { timeout: 12000 });
  const total = response.data.totalCount;
  console.log(`[CHECK] totalCount = ${total}`);
  return total;
}

// ─── FETCH ALL MOVIES ────────────────────────────────────────────
async function fetchAllMovies() {
  const allMovies = [];
  let pageNum = 0;
  const pageSize = 100;
  let totalCount = null;

  while (true) {
    const url = buildProxyUrl(pageNum, pageSize);
    console.log(`[FETCH] page ${pageNum}: ${url}`);
    const response = await axios.get(url, { timeout: 15000 });
    const data = response.data;

    if (totalCount === null) {
      totalCount = data.totalCount;
      console.log(`[FETCH] totalCount = ${totalCount}`);
    }

    const items = data.items || [];
    console.log(`[FETCH] page ${pageNum}: got ${items.length} items`);
    allMovies.push(...items);

    if (items.length === 0 || allMovies.length >= totalCount) {
      break;
    }
    pageNum++;

    if (pageNum > 200) {
      console.error('[FETCH] too many pages, aborting');
      break;
    }
  }

  return { movies: allMovies, totalCount };
}

// ─── BUILD M3U PLAYLIST ──────────────────────────────────────────
function buildM3U(movies) {
  const lines = ['#EXTM3U'];
  let validCount = 0;

  for (const movie of movies) {
    const streamUrl = buildStreamUrl(movie);
    if (!streamUrl) {
      console.warn(`[BUILD] skipping "${movie.title}" (id: ${movie.id}) - no stream`);
      continue;
    }

    const id = movie.id || '';
    let logo = '';

    const portraitLarge = movie.imageInfo?.find(img => img.type === 'portrait_large');
    const anyImage = movie.imageInfo?.find(img => img.url);
    const imageInfo = portraitLarge || anyImage;

    if (imageInfo && imageInfo.url) {
      logo = buildImageUrl(imageInfo.url, '320x480');
    }

    const title = movie.title || 'Unknown';
    lines.push(`#EXTINF:-1 tvg-id="${id}" tvg-logo="${logo}" group-title="Movies", ${title}`);
    lines.push(`${streamUrl}#.mp4`);
    validCount++;
  }

  console.log(`[BUILD] created ${validCount} valid entries out of ${movies.length} items`);
  return { playlist: lines.join('\n'), validCount };
}

// ─── UPDATE CACHE ────────────────────────────────────────────────
async function updatePlaylistIfNeeded(forceRebuild = false) {
  if (isBuilding) {
    console.log('[UPDATE] already building, skipping');
    return;
  }
  isBuilding = true;
  const start = Date.now();

  try {
    const newTotalCount = await fetchTotalCount();

    if (
      forceRebuild ||
      cachedPlaylist === null ||
      cachedTotalCount === null ||
      newTotalCount !== cachedTotalCount
    ) {
      console.log('[UPDATE] cache empty or count changed, rebuilding...');
      const { movies, totalCount } = await fetchAllMovies();
      const { playlist, validCount } = buildM3U(movies);

      cachedPlaylist = playlist;
      cachedTotalCount = totalCount;
      console.log(`[UPDATE] cache set. total=${totalCount}, valid=${validCount}`);
    } else {
      console.log('[UPDATE] count unchanged, keeping old cache');
    }
  } catch (err) {
    console.error('[UPDATE] error:', err.message);
    if (!cachedPlaylist) {
      cachedPlaylist = '#EXTM3U\n';
      cachedTotalCount = 0;
      console.log('[UPDATE] set empty fallback cache');
    }
  } finally {
    isBuilding = false;
    console.log(`[UPDATE] finished in ${((Date.now() - start) / 1000).toFixed(2)}s`);
  }
}

// ─── SCHEDULE DAILY UPDATE ───────────────────────────────────────
cron.schedule('0 0 * * *', () => {
  console.log('[CRON] daily update triggered');
  updatePlaylistIfNeeded();
}, {
  timezone: 'Asia/Kolkata'
});

// ─── STARTUP BUILD ───────────────────────────────────────────────
updatePlaylistIfNeeded().catch(err => console.error('[STARTUP] build failed:', err));

// ─── ROUTES ──────────────────────────────────────────────────────
app.get('/hindi.m3u', (req, res) => {
  if (cachedPlaylist) {
    res.setHeader('Content-Type', 'audio/x-mpegurl');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(cachedPlaylist);
  } else {
    res.status(503).send('Playlist is being generated. Please try again shortly.');
  }
});

app.get('/', (req, res) => {
  res.send('MX Player Hindi M3U service is running.');
});

// ─── START SERVER ────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
