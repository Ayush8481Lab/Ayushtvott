const express = require('express');
const axios = require('axios');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── PROXY CONFIGURATION ─────────────────────────────────────────
const PROXY_BASE = 'https://ayushproxy-blue.vercel.app/api/proxy/';

// ─── API TARGET PARAMETERS ───────────────────────────────────────
const API_TARGET_BASE = 'https://api.mxplayer.in/v1/web/detail/browseItem';

function buildProxyUrl(pageNum, pageSize, extraParams = {}) {
  const queryParts = [
    ['pageNum', pageNum],
    ['pageSize', pageSize],
    ['isCustomized', 'true'],
    ['browseLangFilterIds', 'hi'],
    ['type', '1'],
    ['device-density', '1'],
    ['userid', '6d4a1a2c-5f2a-4f46-be26-901f8801dc88'],
    ['platform', 'com.mxplay.mobile'],
    ['content-languages', 'hi,en'],
    ['kids-mode-enabled', 'false']
  ];

  for (const [key, value] of Object.entries(extraParams)) {
    const existingIndex = queryParts.findIndex(([k]) => k === key);
    if (existingIndex !== -1) {
      queryParts[existingIndex][1] = value;
    } else {
      queryParts.splice(queryParts.length - 1, 0, [key, value]);
    }
  }

  const targetQuery = queryParts.map(([key, value]) => `${key}=${value}`).join('&');
  const targetUrl = `${API_TARGET_BASE}?${targetQuery}`;
  const proxyPath = targetUrl.replace('https://', 'https:/');
  return `${PROXY_BASE}${proxyPath}`;
}

// ─── CACHES ──────────────────────────────────────────────────────
const cache = {
  movies: { playlist: null, totalCount: null },
  shows: {} // genre name -> { playlist, totalCount }
};
let isBuilding = { movies: false, shows: {} };

// ─── HELPERS ─────────────────────────────────────────────────────
function buildImageUrl(imagePath) {
  if (!imagePath) return '';
  if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) return imagePath;
  return `https://qqcdnpictest.mxplay.com/${imagePath.startsWith('/') ? imagePath.slice(1) : imagePath}`;
}

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
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  path = path.startsWith('/') ? path.slice(1) : path;
  return `https://d3sgzbosmwirao.cloudfront.net/${path}`;
}

// Fetch total count for movies or shows
async function fetchTotalCount(type, genreFilterId = null) {
  const extra = { type: type };
  if (genreFilterId) extra.genreFilterIds = genreFilterId;
  const url = buildProxyUrl(0, 2, extra);
  console.log(`[CHECK] ${url}`);
  const response = await axios.get(url, { timeout: 12000 });
  return response.data.totalCount;
}

// Fetch all items (paginated)
async function fetchAllItems(type, genreFilterId = null) {
  const allItems = [];
  let pageNum = 0;
  const pageSize = 100;
  let totalCount = null;

  while (true) {
    const extra = { type: type };
    if (genreFilterId) extra.genreFilterIds = genreFilterId;
    const url = buildProxyUrl(pageNum, pageSize, extra);
    console.log(`[FETCH] page ${pageNum}: ${url}`);
    const response = await axios.get(url, { timeout: 15000 });
    const data = response.data;

    if (totalCount === null) {
      totalCount = data.totalCount;
      console.log(`[FETCH] totalCount = ${totalCount}`);
    }

    const items = data.items || [];
    console.log(`[FETCH] page ${pageNum}: got ${items.length} items`);
    allItems.push(...items);

    if (items.length === 0 || allItems.length >= totalCount) break;
    pageNum++;
    if (pageNum > 200) break;
  }
  return { items: allItems, totalCount };
}

// ─── EPISODE SERVICE (USE SHOW IDs) ─────────────────────────────
async function fetchShowDetails(showIds) {
  const baseUrl = 'https://mxplayer-dun.vercel.app/api/service';
  const results = [];
  const batchSize = 20;

  for (let i = 0; i < showIds.length; i += batchSize) {
    const batch = showIds.slice(i, i + batchSize);
    const url = `${baseUrl}?id=${batch.join(',')}`;
    console.log(`[EPISODES] fetching batch ${Math.floor(i / batchSize) + 1}: ${url}`);

    try {
      const response = await axios.get(url, { timeout: 20000 });
      if (Array.isArray(response.data)) {
        results.push(...response.data);
      } else {
        console.warn('[EPISODES] Unexpected response format:', response.data);
      }
    } catch (err) {
      console.error('[EPISODES] batch failed:', err.message);
    }

    if (i + batchSize < showIds.length) {
      await new Promise(resolve => setTimeout(resolve, 1200));
    }
  }
  return results;
}

// Extract first episode info from show detail
function extractFirstEpisode(showDetail) {
  if (!showDetail.seasons || showDetail.seasons.length === 0) return null;
  const seasons = [...showDetail.seasons].sort((a, b) => a.seasonNumber - b.seasonNumber);
  const firstSeason = seasons[0];
  if (!firstSeason.episodes || firstSeason.episodes.length === 0) return null;
  const episodes = [...firstSeason.episodes].sort((a, b) => a.episodeNo - b.episodeNo);
  const ep = episodes[0];
  return {
    seasonNumber: firstSeason.seasonNumber,
    episodeNo: ep.episodeNo,
    title: ep.title,
    stream: ep.stream,
    imageInfo: ep.imageInfo
  };
}

// ─── BUILD MOVIES PLAYLIST ───────────────────────────────────────
function buildMoviesM3U(movies) {
  const lines = ['#EXTM3U'];
  let validCount = 0;
  for (const movie of movies) {
    const streamUrl = buildStreamUrl(movie);
    if (!streamUrl) continue;
    const id = movie.id || '';
    let logo = '';
    const portraitLarge = movie.imageInfo?.find(img => img.type === 'portrait_large');
    const anyImage = movie.imageInfo?.find(img => img.url);
    const imageInfo = portraitLarge || anyImage;
    if (imageInfo) logo = buildImageUrl(imageInfo.url);
    lines.push(`#EXTINF:-1 tvg-id="${id}" tvg-logo="${logo}" group-title="Movies", ${movie.title}`);
    lines.push(`${streamUrl}#.mp4`);
    validCount++;
  }
  console.log(`[MOVIES] built ${validCount} entries`);
  return { playlist: lines.join('\n'), validCount };
}

// ─── BUILD SHOWS PLAYLIST FOR ONE GENRE ─────────────────────────
async function buildShowsM3UForGenre(genreName, genreFilterId) {
  console.log(`\n[SHOWS] Processing genre: ${genreName}`);
  const { items: shows, totalCount } = await fetchAllItems(2, genreFilterId);
  console.log(`[SHOWS] ${genreName}: total shows = ${totalCount}`);

  // Collect show IDs (show.id, not firstVideo.id)
  const showIds = shows.map(show => show.id).filter(Boolean);
  console.log(`[SHOWS] ${genreName}: collecting ${showIds.length} show IDs`);

  if (showIds.length === 0) return { playlist: '', validCount: 0 };

  const showDetailsArray = await fetchShowDetails(showIds);
  console.log(`[SHOWS] ${genreName}: received details for ${showDetailsArray.length} shows`);

  // Map by showId
  const showDetailMap = {};
  for (const detail of showDetailsArray) {
    showDetailMap[detail.showId] = detail;
  }

  const lines = [];
  let validCount = 0;

  for (const show of shows) {
    const detail = showDetailMap[show.id];
    if (!detail) continue;

    const firstEpisode = extractFirstEpisode(detail);
    if (!firstEpisode) continue;

    const streamUrl = buildStreamUrl(firstEpisode);
    if (!streamUrl) continue;

    let logo = '';
    const landscape = firstEpisode.imageInfo?.find(img => img.type === 'landscape');
    if (landscape && landscape.url) {
      logo = buildImageUrl(landscape.url);
    }

    const title = `${show.title} - S${firstEpisode.seasonNumber}E${firstEpisode.episodeNo} - ${firstEpisode.title}`;
    lines.push(`#EXTINF:-1 tvg-id="${show.id}" tvg-logo="${logo}" group-title="${genreName}", ${title}`);
    lines.push(`${streamUrl}#.mp4`);
    validCount++;
  }

  console.log(`[SHOWS] ${genreName}: built ${validCount} entries`);
  return { playlist: lines.join('\n'), validCount };
}

// ─── UPDATE FUNCTIONS ────────────────────────────────────────────
async function updateMovies(force = false) {
  if (isBuilding.movies) return;
  isBuilding.movies = true;
  try {
    const total = await fetchTotalCount(1);
    if (force || cache.movies.playlist === null || cache.movies.totalCount !== total) {
      console.log('[MOVIES] rebuilding...');
      const { items } = await fetchAllItems(1);
      const { playlist, validCount } = buildMoviesM3U(items);
      cache.movies = { playlist, totalCount: total };
    }
  } catch (err) {
    console.error('[MOVIES] update error:', err.message);
  } finally {
    isBuilding.movies = false;
  }
}

async function updateShows(force = false) {
  const genres = [
    { name: 'Romance', filterId: '1dfb3454a9898389b8eae7ba7d664bc0' },
    { name: 'Drama', filterId: '48efa872f6f17facebf6149dfc536ee1' },
    { name: 'Comedy', filterId: 'a24ddcadde26310ddfdb674e09e38eb5' },
    { name: 'Thriller', filterId: '2dd5daf25be5619543524f360c73c3d8' },
    { name: 'Crime', filterId: 'b413dff55bdad743c577a8bea3b65044' },
    { name: 'Horror', filterId: '2bab9af055150068ef74b58163dc638b' },
    { name: 'Action', filterId: '426ce788509fd7ac2814ae1639907fe3' },
    { name: 'Reality Show', filterId: 'd63bdd9c0381a0cdd1e38a3cc9439e2c' },
    { name: 'K Drama', filterId: '0681d37530f4e2a8fc1f99bce0b707e4' }
  ];

  for (const genre of genres) {
    if (isBuilding.shows[genre.name]) continue;
    isBuilding.shows[genre.name] = true;
    try {
      const { playlist, validCount } = await buildShowsM3UForGenre(genre.name, genre.filterId);
      cache.shows[genre.name] = { playlist, totalCount: validCount };
    } catch (err) {
      console.error(`[SHOWS:${genre.name}] update error:`, err.message);
      if (!cache.shows[genre.name]) {
        cache.shows[genre.name] = { playlist: '#EXTM3U\n', totalCount: 0 };
      }
    } finally {
      isBuilding.shows[genre.name] = false;
    }
  }
}

// ─── SCHEDULE ────────────────────────────────────────────────────
// Movies: 12:00 AM IST
cron.schedule('0 0 * * *', () => {
  console.log('[CRON] Movies update');
  updateMovies();
}, { timezone: 'Asia/Kolkata' });

// Shows: 12:00 PM IST
cron.schedule('0 12 * * *', () => {
  console.log('[CRON] Shows update');
  updateShows();
}, { timezone: 'Asia/Kolkata' });

// Initial build on startup
(async () => {
  console.log('Starting initial cache build...');
  await updateMovies(true);
  await updateShows(true);
  console.log('Initial cache build complete.');
})().catch(err => console.error('Initial build error:', err));

// ─── ROUTES ──────────────────────────────────────────────────────
// /index.m3u -> movies + all shows
app.get('/index.m3u', (req, res) => {
  if (cache.movies.playlist && Object.keys(cache.shows).length > 0) {
    let combined = '#EXTM3U\n';
    combined += cache.movies.playlist + '\n';
    for (const genre of Object.keys(cache.shows)) {
      const genrePlaylist = cache.shows[genre].playlist;
      if (genrePlaylist && genrePlaylist.trim() !== '#EXTM3U') {
        const lines = genrePlaylist.split('\n');
        if (lines[0] === '#EXTM3U') lines.shift();
        combined += lines.join('\n') + '\n';
      }
    }
    res.setHeader('Content-Type', 'audio/x-mpegurl');
    res.setHeader('Cache-Control', 'public, max-age=1800');
    res.send(combined);
  } else {
    res.status(503).send('Playlist is being generated. Please try again shortly.');
  }
});

// /hindi.m3u -> movies only
app.get('/hindi.m3u', (req, res) => {
  if (cache.movies.playlist) {
    res.setHeader('Content-Type', 'audio/x-mpegurl');
    res.setHeader('Cache-Control', 'public, max-age=1800');
    res.send(cache.movies.playlist);
  } else {
    res.status(503).send('Playlist is being generated. Please try again shortly.');
  }
});

// Genre endpoints
const genreEndpoints = [
  { route: '/romance.m3u', key: 'Romance' },
  { route: '/drama.m3u', key: 'Drama' },
  { route: '/comedy.m3u', key: 'Comedy' },
  { route: '/thriller.m3u', key: 'Thriller' },
  { route: '/crime.m3u', key: 'Crime' },
  { route: '/horror.m3u', key: 'Horror' },
  { route: '/action.m3u', key: 'Action' },
  { route: '/reality.m3u', key: 'Reality Show' },
  { route: '/kdrama.m3u', key: 'K Drama' }
];

for (const ep of genreEndpoints) {
  app.get(ep.route, (req, res) => {
    const genreCache = cache.shows[ep.key];
    if (genreCache && genreCache.playlist) {
      res.setHeader('Content-Type', 'audio/x-mpegurl');
      res.setHeader('Cache-Control', 'public, max-age=1800');
      res.send(genreCache.playlist);
    } else {
      res.status(503).send('Playlist is being generated. Please try again shortly.');
    }
  });
}

app.get('/', (req, res) => {
  res.send('MX Player M3U service. Endpoints: /index.m3u, /hindi.m3u, /drama.m3u, ...');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
