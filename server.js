const express = require('express');
const axios = require('axios');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── API CONFIGURATION ───────────────────────────────────────────
const API_BASE = 'https://tv.wapgotube.workers.dev/proxy/https://api.mxplayer.in/v1/web/detail/browseItem';

// Build query string in EXACT order as provided, with leading `&`
function buildApiUrl(pageNum, pageSize) {
  const params = new URLSearchParams();
  params.set('pageNum', pageNum);
  params.set('pageSize', pageSize);
  params.set('isCustomized', 'true');
  params.set('browseLangFilterIds', 'hi');
  params.set('type', '1');
  params.set('device-density', '1');
  params.set('userid', '6d4a1a2c-5f2a-4f46-be26-901f8801dc88');
  params.set('platform', 'com.mxplay.mobile');
  params.set('content-languages', 'hi,en');
  params.set('kids-mode-enabled', 'false');
  // Note: URLSearchParams will produce "pageNum=...&pageSize=..." without leading "&".
  // To match exactly "?&pageNum=...", we prepend an "&" manually.
  return `${API_BASE}?&${params.toString()}`;
}

// ─── IN-MEMORY CACHE ─────────────────────────────────────────────
let cachedPlaylist = null;
let cachedTotalCount = null;
let isBuilding = false;

// ─── HELPERS ──────────────────────────────────────────────────────
function buildImageUrl(imagePath, size = null) {
  if (!imagePath) return '';
  if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) return imagePath;
  let path = imagePath.startsWith('/') ? imagePath.slice(1) : imagePath;
  if (size && /\/\d+x\d+\//.test(path)) {
    path = path.replace(/\/\d+x\d+\//, `/${size}/`);
  }
  return `https://qqcdnpictest.mxplay.com/${path}`;
}

function buildStreamUrl(item) {
  const stream = item.stream;
  if (!stream) return '';

  let path = stream.thirdParty?.hlsUrl ||
             stream.thirdParty?.webHlsUrl ||
             stream.hls?.high ||
             stream.hls?.main ||
             stream.mxplay?.hls?.high;

  // Fallback using videoHash (if no explicit URL)
  if (!path && stream.videoHash) {
    path = `video/${stream.videoHash}/2/hls/h264_high.m3u8`;
  }

  if (!path) return '';
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  path = path.startsWith('/') ? path.slice(1) : path;
  return `https://d3sgzbosmwirao.cloudfront.net/${path}`;
}

// ─── FETCH TOTAL COUNT (lightweight) ─────────────────────────────
async function fetchTotalCount() {
  const url = buildApiUrl(0, 2); // pageNum=0, pageSize=2
  console.log(`[CHECK] ${url}`);
  const response = await axios.get(url, { timeout: 10000 });
  const total = response.data.totalCount;
  console.log(`[CHECK] totalCount = ${total}`);
  return total;
}

// ─── FETCH ALL MOVIES (paginated) ───────────────────────────────
async function fetchAllMovies() {
  const allMovies = [];
  let pageNum = 0;
  const pageSize = 100;               // heavy pages
  let totalCount = null;

  while (true) {
    const url = buildApiUrl(pageNum, pageSize);
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

    // Safety break to avoid infinite loops
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

      // Always cache, even if empty, to stop endless 503
      cachedPlaylist = playlist;
      cachedTotalCount = totalCount;
      console.log(`[UPDATE] cache set. total=${totalCount}, valid=${validCount}`);
    } else {
      console.log('[UPDATE] count unchanged, keeping old cache');
    }
  } catch (err) {
    console.error('[UPDATE] error:', err.message);
    if (!cachedPlaylist) {
      // set empty fallback so we don't stay in 503 forever
      cachedPlaylist = '#EXTM3U\n';
      cachedTotalCount = 0;
      console.log('[UPDATE] set empty fallback cache');
    }
  } finally {
    isBuilding = false;
    console.log(`[UPDATE] finished in ${((Date.now() - start) / 1000).toFixed(2)}s`);
  }
}

// ─── SCHEDULE DAILY UPDATE AT 12:00 AM IST ───────────────────────
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
    res.setHeader('Cache-Control', 'public, max-age=3600'); // 1 hour
    res.send(cachedPlaylist);
  } else {
    // Should only happen on very first request while build is in progress
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
