const express = require('express');
const axios = require('axios');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── PROXY CONFIGURATION ─────────────────────────────────────────
const PROXY_BASE = 'https://ayushproxy-blue.vercel.app/api/proxy/';

// ─── API TARGET PARAMETERS (exact order) ─────────────────────────
const API_TARGET_BASE = 'https://api.mxplayer.in/v1/web/detail/browseItem';

// Helper to build proxy URL with optional extra query params
function buildProxyUrl(pageNum, pageSize, extraParams = {}) {
  const queryParts = [
    ['pageNum', pageNum],
    ['pageSize', pageSize],
    ['isCustomized', 'true'],
    ['browseLangFilterIds', 'hi'],
    ['type', '1'],                  // default type, will be overridden if extraParams includes type
    ['device-density', '1'],
    ['userid', '6d4a1a2c-5f2a-4f46-be26-901f8801dc88'],
    ['platform', 'com.mxplay.mobile'],
    ['content-languages', 'hi,en'],
    ['kids-mode-enabled', 'false']
  ];

  // Override or add extra params (like genreFilterIds, type)
  for (const [key, value] of Object.entries(extraParams)) {
    const existingIndex = queryParts.findIndex(([k]) => k === key);
    if (existingIndex !== -1) {
      queryParts[existingIndex][1] = value;
    } else {
      // Insert before kids-mode-enabled to maintain order roughly
      queryParts.splice(queryParts.length - 1, 0, [key, value]);
    }
  }

  const targetQuery = queryParts.map(([key, value]) => `${key}=${value}`).join('&');
  const targetUrl = `${API_TARGET_BASE}?${targetQuery}`;
  const proxyPath = targetUrl.replace('https://', 'https:/');
  return `${PROXY_BASE}${proxyPath}`;
}

// ─── IN-MEMORY CACHES ───────────────────────────────────────────
let cachedMoviesPlaylist = null;
let cachedMoviesTotalCount = null;
let cachedShowsPlaylist = null;
let cachedShowsTotalCount = null;
let isBuildingMovies = false;
let isBuildingShows = false;

// ─── HELPERS (same as before) ──────────────────────────────────
function buildImageUrl(imagePath) {
  if (!imagePath) return '';
  if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
    return imagePath;
  }
  return `https://qqcdnpictest.mxplay.com/${imagePath.startsWith('/') ? imagePath.slice(1) : imagePath}`;
}

// Stream URL: DASH priority, HLS fallback, videoHash fallback
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

// ─── FETCH TOTAL COUNT (lightweight) for a given type/genre ────
async function fetchTotalCount(type, genreFilterId = null) {
  const extra = { type: type };
  if (genreFilterId) extra.genreFilterIds = genreFilterId;
  const url = buildProxyUrl(0, 2, extra);
  console.log(`[CHECK] ${url}`);
  const response = await axios.get(url, { timeout: 12000 });
  const total = response.data.totalCount;
  console.log(`[CHECK] totalCount = ${total}`);
  return total;
}

// ─── FETCH ALL ITEMS (paginated) for movies or shows ────────────
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

    if (items.length === 0 || allItems.length >= totalCount) {
      break;
    }
    pageNum++;

    if (pageNum > 200) {
      console.error('[FETCH] too many pages, aborting');
      break;
    }
  }

  return { items: allItems, totalCount };
}

// ─── BUILD MOVIES M3U PLAYLIST ─────────────────────────────────
function buildMoviesM3U(movies) {
  const lines = ['#EXTM3U'];
  let validCount = 0;

  for (const movie of movies) {
    const streamUrl = buildStreamUrl(movie);
    if (!streamUrl) {
      console.warn(`[MOVIES] skipping "${movie.title}" - no stream`);
      continue;
    }

    const id = movie.id || '';
    let logo = '';

    const portraitLarge = movie.imageInfo?.find(img => img.type === 'portrait_large');
    const anyImage = movie.imageInfo?.find(img => img.url);
    const imageInfo = portraitLarge || anyImage;

    if (imageInfo && imageInfo.url) {
      logo = buildImageUrl(imageInfo.url);
    }

    const title = movie.title || 'Unknown';
    lines.push(`#EXTINF:-1 tvg-id="${id}" tvg-logo="${logo}" group-title="Movies", ${title}`);
    lines.push(`${streamUrl}#.mp4`);
    validCount++;
  }

  console.log(`[MOVIES] created ${validCount} valid entries out of ${movies.length} items`);
  return { playlist: lines.join('\n'), validCount };
}

// ─── EPISODE SERVICE BATCH FETCH (with delay) ──────────────────
async function fetchEpisodeDetails(episodeIds) {
  const baseUrl = 'https://mxplayer-dun.vercel.app/api/service';
  const results = [];

  // Batch in groups of 20
  for (let i = 0; i < episodeIds.length; i += 20) {
    const batch = episodeIds.slice(i, i + 20);
    const url = `${baseUrl}?id=${batch.join(',')}`;
    console.log(`[EPISODES] fetching batch ${i / 20 + 1}: ${url}`);

    try {
      const response = await axios.get(url, { timeout: 20000 });
      const showsData = response.data;
      results.push(...showsData);
    } catch (err) {
      console.error(`[EPISODES] batch ${i / 20 + 1} failed:`, err.message);
    }

    // Delay between batches (1.2 seconds)
    if (i + 20 < episodeIds.length) {
      await new Promise(resolve => setTimeout(resolve, 1200));
    }
  }

  return results;
}

// ─── EXTRACT FIRST EPISODE INFO FROM SHOW DATA ─────────────────
function extractFirstEpisode(showData) {
  // Find first season (seasonNumber 1 or lowest), then first episode
  if (!showData.seasons || showData.seasons.length === 0) return null;

  // Sort seasons by seasonNumber ascending
  const seasons = [...showData.seasons].sort((a, b) => a.seasonNumber - b.seasonNumber);
  const firstSeason = seasons[0];
  if (!firstSeason.episodes || firstSeason.episodes.length === 0) return null;

  // Sort episodes by episodeNo ascending and take first
  const episodes = [...firstSeason.episodes].sort((a, b) => a.episodeNo - b.episodeNo);
  return {
    seasonNumber: firstSeason.seasonNumber,
    episodeNo: episodes[0].episodeNo,
    title: episodes[0].title,
    stream: episodes[0].stream,
    imageInfo: episodes[0].imageInfo
  };
}

// ─── BUILD SHOWS M3U PLAYLIST FOR ONE GENRE ────────────────────
async function buildShowsM3UForGenre(genreName, genreFilterId) {
  console.log(`\n[SHOWS] Processing genre: ${genreName} (${genreFilterId})`);

  // Fetch all shows of this genre
  const { items: shows, totalCount } = await fetchAllItems(2, genreFilterId);
  console.log(`[SHOWS] ${genreName}: total shows = ${totalCount}`);

  // Collect episode IDs (firstVideo.id)
  const episodeIdToShowMap = new Map(); // episodeId -> { showId, showTitle }
  for (const show of shows) {
    if (show.firstVideo && show.firstVideo.id) {
      episodeIdToShowMap.set(show.firstVideo.id, {
        showId: show.id,
        showTitle: show.title
      });
    }
  }

  const episodeIds = [...episodeIdToShowMap.keys()];
  console.log(`[SHOWS] ${genreName}: collected ${episodeIds.length} episode IDs`);

  if (episodeIds.length === 0) {
    return { playlist: '', validCount: 0 };
  }

  // Fetch episode details in batches
  const showsData = await fetchEpisodeDetails(episodeIds);
  console.log(`[SHOWS] ${genreName}: received data for ${showsData.length} shows`);

  const lines = [];
  let validCount = 0;

  for (const showData of showsData) {
    const showInfo = episodeIdToShowMap.get(showData.showId);
    if (!showInfo) continue;

    const firstEpisode = extractFirstEpisode(showData);
    if (!firstEpisode) {
      console.warn(`[SHOWS] ${genreName}: no episode data for ${showInfo.showTitle}`);
      continue;
    }

    const streamUrl = buildStreamUrl(firstEpisode);
    if (!streamUrl) {
      console.warn(`[SHOWS] ${genreName}: no stream for ${showInfo.showTitle} S${firstEpisode.seasonNumber}E${firstEpisode.episodeNo}`);
      continue;
    }

    // Logo: landscape image from episode info
    let logo = '';
    const landscape = firstEpisode.imageInfo?.find(img => img.type === 'landscape');
    if (landscape && landscape.url) {
      logo = buildImageUrl(landscape.url);
    }

    // Title format: ShowName - S0E0 - EpisodeTitle
    const title = `${showInfo.showTitle} - S${firstEpisode.seasonNumber}E${firstEpisode.episodeNo} - ${firstEpisode.title}`;
    lines.push(`#EXTINF:-1 tvg-id="${showInfo.showId}" tvg-logo="${logo}" group-title="${genreName}", ${title}`);
    lines.push(`${streamUrl}#.mp4`);
    validCount++;
  }

  console.log(`[SHOWS] ${genreName}: created ${validCount} valid entries`);
  return { playlist: lines.join('\n'), validCount };
}

// ─── UPDATE MOVIES CACHE ───────────────────────────────────────
async function updateMoviesIfNeeded(forceRebuild = false) {
  if (isBuildingMovies) {
    console.log('[MOVIES] already building, skipping');
    return;
  }
  isBuildingMovies = true;
  const start = Date.now();

  try {
    const newTotalCount = await fetchTotalCount(1);
    if (
      forceRebuild ||
      cachedMoviesPlaylist === null ||
      cachedMoviesTotalCount === null ||
      newTotalCount !== cachedMoviesTotalCount
    ) {
      console.log('[MOVIES] cache empty or count changed, rebuilding...');
      const { items: movies, totalCount } = await fetchAllItems(1);
      const { playlist, validCount } = buildMoviesM3U(movies);
      cachedMoviesPlaylist = playlist;
      cachedMoviesTotalCount = totalCount;
      console.log(`[MOVIES] cache updated. total=${totalCount}, valid=${validCount}`);
    } else {
      console.log('[MOVIES] count unchanged, keeping old cache');
    }
  } catch (err) {
    console.error('[MOVIES] update error:', err.message);
    if (!cachedMoviesPlaylist) {
      cachedMoviesPlaylist = '#EXTM3U\n';
      cachedMoviesTotalCount = 0;
    }
  } finally {
    isBuildingMovies = false;
    console.log(`[MOVIES] finished in ${((Date.now() - start) / 1000).toFixed(2)}s`);
  }
}

// ─── UPDATE SHOWS CACHE (all genres) ───────────────────────────
async function updateShowsIfNeeded(forceRebuild = false) {
  if (isBuildingShows) {
    console.log('[SHOWS] already building, skipping');
    return;
  }
  isBuildingShows = true;
  const start = Date.now();

  // Define genres with their API genreFilterIds
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

  try {
    let combinedPlaylist = '#EXTM3U\n';
    let totalValid = 0;

    for (const genre of genres) {
      const { playlist, validCount } = await buildShowsM3UForGenre(genre.name, genre.filterId);
      if (validCount > 0) {
        // Append genre playlist (skip the initial #EXTM3U line if present)
        const lines = playlist.split('\n');
        if (lines[0] === '#EXTM3U') lines.shift();
        combinedPlaylist += lines.join('\n') + '\n';
        totalValid += validCount;
      }
    }

    cachedShowsPlaylist = combinedPlaylist;
    // Store total count as number of valid episodes (or shows)
    cachedShowsTotalCount = totalValid;
    console.log(`[SHOWS] cache updated. total valid episodes = ${totalValid}`);
  } catch (err) {
    console.error('[SHOWS] update error:', err.message);
    if (!cachedShowsPlaylist) {
      cachedShowsPlaylist = '#EXTM3U\n';
      cachedShowsTotalCount = 0;
    }
  } finally {
    isBuildingShows = false;
    console.log(`[SHOWS] finished in ${((Date.now() - start) / 1000).toFixed(2)}s`);
  }
}

// ─── SCHEDULE UPDATES ──────────────────────────────────────────
// Movies update at 12:00 AM IST
cron.schedule('0 0 * * *', () => {
  console.log('[CRON] Movies daily update triggered');
  updateMoviesIfNeeded();
}, { timezone: 'Asia/Kolkata' });

// Shows update at 12:00 PM IST
cron.schedule('0 12 * * *', () => {
  console.log('[CRON] Shows daily update triggered');
  updateShowsIfNeeded();
}, { timezone: 'Asia/Kolkata' });

// ─── STARTUP INITIAL BUILD ─────────────────────────────────────
updateMoviesIfNeeded().catch(err => console.error('[STARTUP] Movies build failed:', err));
updateShowsIfNeeded().catch(err => console.error('[STARTUP] Shows build failed:', err));

// ─── ROUTES ──────────────────────────────────────────────────────
app.get('/index.m3u', (req, res) => {
  let combined = '#EXTM3U\n';

  if (cachedMoviesPlaylist) {
    combined += cachedMoviesPlaylist + '\n';
  }
  if (cachedShowsPlaylist) {
    combined += cachedShowsPlaylist;
  }

  if (combined.trim() === '#EXTM3U') {
    res.status(503).send('Playlist is being generated. Please try again shortly.');
  } else {
    res.setHeader('Content-Type', 'audio/x-mpegurl');
    res.setHeader('Cache-Control', 'public, max-age=1800'); // 30 minutes
    res.send(combined);
  }
});

// Keep old endpoint for movies only (optional)
app.get('/hindi.m3u', (req, res) => {
  if (cachedMoviesPlaylist) {
    res.setHeader('Content-Type', 'audio/x-mpegurl');
    res.setHeader('Cache-Control', 'public, max-age=1800');
    res.send(cachedMoviesPlaylist);
  } else {
    res.status(503).send('Playlist is being generated. Please try again shortly.');
  }
});

app.get('/', (req, res) => {
  res.send('MX Player Combined M3U service is running. Use /index.m3u for all content.');
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
