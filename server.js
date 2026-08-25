const express = require('express');
const axios = require('axios');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

// API configuration
const API_BASE = 'https://tv.wapgotube.workers.dev/proxy/https://api.mxplayer.in/v1/web/detail/browseItem';
const QUERY_PARAMS = {
  'isCustomized': 'true',
  'browseLangFilterIds': 'hi',
  'type': '1',
  'device-density': '1',
  'userid': '6d4a1a2c-5f2a-4f46-be26-901f8801dc88',
  'platform': 'com.mxplay.mobile',
  'content-languages': 'hi,en',
  'kids-mode-enabled': 'false'
};

// In-memory cache
let cachedPlaylist = null;
let cachedTotalCount = null;

// Helper: Build full URL for images
function buildImageUrl(imagePath, size = null) {
  if (!imagePath) return '';
  if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
    return imagePath;
  }
  let path = imagePath.startsWith('/') ? imagePath.slice(1) : imagePath;
  if (size && /\/\d+x\d+\//.test(path)) {
    path = path.replace(/\/\d+x\d+\//, `/${size}/`);
  }
  return `https://qqcdnpictest.mxplay.com/${path}`;
}

// Helper: Build stream URL with fallback to videoHash
function buildStreamUrl(item) {
  const stream = item.stream;
  if (!stream) return '';

  // Try all possible HLS paths
  let path = stream.thirdParty?.hlsUrl ||
             stream.thirdParty?.webHlsUrl ||
             stream.hls?.high ||
             stream.hls?.main ||
             stream.mxplay?.hls?.high;

  // Fallback: construct from videoHash if no path found
  if (!path && stream.videoHash) {
    path = `video/${stream.videoHash}/2/hls/h264_high.m3u8`;
  }

  if (!path) return '';
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path;
  }
  path = path.startsWith('/') ? path.slice(1) : path;
  return `https://d3sgzbosmwirao.cloudfront.net/${path}`;
}

// Fetch total count using pageSize=2 (lightweight)
async function fetchTotalCount() {
  const params = { ...QUERY_PARAMS, 'pageNum': 0, 'pageSize': 2 };
  const response = await axios.get(API_BASE, { params, timeout: 10000 });
  return response.data.totalCount;
}

// Fetch all movies (paginated)
async function fetchAllMovies() {
  const allMovies = [];
  let pageNum = 0;
  const pageSize = 100;
  let totalCount = null;

  while (true) {
    const params = {
      ...QUERY_PARAMS,
      'pageNum': pageNum,
      'pageSize': pageSize
    };
    console.log(`Fetching page ${pageNum}...`);
    const response = await axios.get(API_BASE, { params, timeout: 15000 });
    const data = response.data;

    if (totalCount === null) {
      totalCount = data.totalCount;
      console.log(`Total count from API: ${totalCount}`);
    }

    const items = data.items || [];
    console.log(`Page ${pageNum}: received ${items.length} items`);
    allMovies.push(...items);

    if (allMovies.length >= totalCount || items.length === 0) {
      break;
    }
    pageNum++;
  }

  return { movies: allMovies, totalCount };
}

// Build M3U playlist from movie list
function buildM3U(movies) {
  const lines = ['#EXTM3U'];
  let validCount = 0;

  for (const movie of movies) {
    const streamUrl = buildStreamUrl(movie);
    if (!streamUrl) {
      console.warn(`Skipping "${movie.title}" (id: ${movie.id}) - no stream URL`);
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

  console.log(`Built playlist with ${validCount} valid entries out of ${movies.length} items`);
  return lines.join('\n');
}

// Update cache: check count and rebuild if needed
async function updatePlaylistIfNeeded(forceRebuild = false) {
  try {
    console.log('Checking total count...');
    const newTotalCount = await fetchTotalCount();
    console.log(`New total count: ${newTotalCount}`);

    if (
      forceRebuild ||
      cachedPlaylist === null ||
      cachedTotalCount === null ||
      newTotalCount !== cachedTotalCount
    ) {
      console.log(`Count changed or cache empty (old: ${cachedTotalCount}, new: ${newTotalCount}). Rebuilding...`);
      const { movies, totalCount } = await fetchAllMovies();
      const newPlaylist = buildM3U(movies);

      // Only update cache if we have at least one valid entry
      if (newPlaylist.trim() !== '#EXTM3U') {
        cachedPlaylist = newPlaylist;
        cachedTotalCount = totalCount;
        console.log(`Cache updated with ${totalCount} total items.`);
      } else {
        console.error('Playlist would be empty – not updating cache. Old cache kept (if any).');
      }
    } else {
      console.log('Count unchanged, using cached playlist.');
    }
  } catch (error) {
    console.error('Error updating playlist:', error.message);
  }
}

// Schedule daily update at 12:00 AM IST
cron.schedule('0 0 * * *', () => {
  console.log('Running scheduled daily update...');
  updatePlaylistIfNeeded();
}, {
  timezone: 'Asia/Kolkata'
});

// Initialize on server start
updatePlaylistIfNeeded().catch(err => console.error('Initial update failed:', err));

// Serve the M3U playlist
app.get('/hindi.m3u', (req, res) => {
  if (cachedPlaylist) {
    res.setHeader('Content-Type', 'audio/x-mpegurl');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(cachedPlaylist);
  } else {
    res.status(503).send('Playlist is being generated. Please try again shortly.');
  }
});

// Health check
app.get('/', (req, res) => res.send('MX Player Hindi M3U service is running.'));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
