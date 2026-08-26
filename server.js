const express = require('express');
const axios = require('axios');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── PROXY CONFIGURATION ─────────────────────────────────────────
const PROXY_BASE = 'https://ayushproxy-blue.vercel.app/api/proxy/';
const API_TARGET_BASE = 'https://api.mxplayer.in/v1/web/detail/browseItem';

function buildBrowseUrl(pageNum, pageSize, type, genreFilterId = null) {
  let query = `pageNum=${pageNum}&pageSize=${pageSize}&isCustomized=true`;
  if (genreFilterId) {
    query += `&genreFilterIds=${genreFilterId}`;
  }
  query += `&type=${type}&device-density=1&userid=6d4a1a2c-5f2a-4f46-be26-901f8801dc88&platform=com.mxplay.mobile&content-languages=hi,en&kids-mode-enabled=false`;
  const targetUrl = `${API_TARGET_BASE}?${query}`;
  const proxyPath = targetUrl.replace('https://', 'https:/');
  return `${PROXY_BASE}${proxyPath}`;
}

// ─── CACHES & JOB STATUS ────────────────────────────────────────
const cache = {
  movies: { playlist: null, totalCount: null },                 // all Hindi movies
  movieGenres: {},                                              // genre name -> { playlist, totalCount }
  shows: {}                                                     // genre name -> { playlist, totalCount }
};

const showJobs = {};  // genre -> { status, totalShows, completedShows, lastProcessed, playlist, error? }
let isBuildingMovies = false;

// ─── MOVIE GENRE DEFINITIONS ────────────────────────────────────
const movieGenres = [
  { name: 'Romance',   filterId: 'dd1bbd57f60ddcb366d3c0c419c1ef16', endpoint: '/movie-romance.m3u' },
  { name: 'Comedy',    filterId: '5492e591ea1ce9038c80c8c2c1b797f7', endpoint: '/movie-comedy.m3u' },
  { name: 'Action',    filterId: '72c7a3098399dfb77a42f5181b46fa41', endpoint: '/movie-action.m3u' },
  { name: 'Crime',     filterId: '52175868f778ec20e0103a06299cbb6c', endpoint: '/movie-crime.m3u' },
  { name: 'Horror',    filterId: '2bfe89ac78ecfc9330fb01a6303a49c8', endpoint: '/movie-horror.m3u' },
  { name: 'Animation', filterId: '2e5274cb97ea3c30073c6aebf6e8965e', endpoint: '/movie-animation.m3u' },
  { name: 'Thriller',  filterId: 'e226765da2e105f06b058d3049a10757', endpoint: '/movie-thriller.m3u' },
  { name: 'Mystery',   filterId: '98ebb0f782f3700f1f22cf52e3e5526f', endpoint: '/movie-mystery.m3u' }
];

// ─── SHOW GENRE DEFINITIONS ─────────────────────────────────────
const showGenres = [
  { name: 'Romance',     filterId: '1dfb3454a9898389b8eae7ba7d664bc0', endpoint: '/romance.m3u' },
  { name: 'Drama',       filterId: '48efa872f6f17facebf6149dfc536ee1', endpoint: '/drama.m3u' },
  { name: 'Comedy',      filterId: 'a24ddcadde26310ddfdb674e09e38eb5', endpoint: '/comedy.m3u' },
  { name: 'Thriller',    filterId: '2dd5daf25be5619543524f360c73c3d8', endpoint: '/thriller.m3u' },
  { name: 'Crime',       filterId: 'b413dff55bdad743c577a8bea3b65044', endpoint: '/crime.m3u' },
  { name: 'Horror',      filterId: '2bab9af055150068ef74b58163dc638b', endpoint: '/horror.m3u' },
  { name: 'Action',      filterId: '426ce788509fd7ac2814ae1639907fe3', endpoint: '/action.m3u' },
  { name: 'Reality Show',filterId: 'd63bdd9c0381a0cdd1e38a3cc9439e2c', endpoint: '/reality.m3u' },
  { name: 'K Drama',     filterId: '0681d37530f4e2a8fc1f99bce0b707e4', endpoint: '/kdrama.m3u' }
];

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

// ─── FETCH FUNCTIONS ─────────────────────────────────────────────
async function fetchTotalCount(type, genreFilterId = null) {
  const url = buildBrowseUrl(0, 2, type, genreFilterId);
  console.log(`[CHECK] ${url}`);
  const response = await axios.get(url, { timeout: 12000 });
  return response.data.totalCount;
}

async function fetchAllItems(type, genreFilterId = null) {
  const allItems = [];
  let pageNum = 0;
  const pageSize = 100;
  let totalCount = null;

  while (true) {
    const url = buildBrowseUrl(pageNum, pageSize, type, genreFilterId);
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

// Fetch episode details using firstVideo.id in batches of 5 with delay
async function fetchEpisodeDetailsInBatches(episodeIds, onProgress) {
  const baseUrl = 'https://mxplayer-dun.vercel.app/api/service';
  const batchSize = 5;
  const results = [];
  let successfulBatches = 0;
  let failedBatches = 0;

  for (let i = 0; i < episodeIds.length; i += batchSize) {
    const batch = episodeIds.slice(i, i + batchSize);
    const url = `${baseUrl}?id=${batch.join(',')}`;
    console.log(`[EPISODES] batch ${Math.floor(i / batchSize) + 1}: ${url}`);

    try {
      const response = await axios.get(url, { timeout: 20000 });
      let data = response.data;
      if (!Array.isArray(data)) {
        data = [data];
      }
      results.push(...data);
      successfulBatches++;
    } catch (err) {
      console.error('[EPISODES] batch failed:', err.message);
      failedBatches++;
    }

    if (onProgress) {
      onProgress(Math.min(i + batchSize, episodeIds.length));
    }

    if (i + batchSize < episodeIds.length) {
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }

  console.log(`[EPISODES] fetched ${results.length} details. Successful batches: ${successfulBatches}, failed: ${failedBatches}`);
  return results;
}

// ─── BUILD MOVIES PLAYLIST (with group title parameter) ─────────
function buildMoviesM3U(movies, groupTitle) {
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
    lines.push(`#EXTINF:-1 tvg-id="${id}" tvg-logo="${logo}" group-title="${groupTitle}", ${movie.title}`);
    lines.push(`${streamUrl}#.mp4`);
    validCount++;
  }
  console.log(`[MOVIES:${groupTitle}] built ${validCount} entries`);
  return { playlist: lines.join('\n'), validCount };
}

// ─── PROCESS ONE SHOW GENRE (ALL EPISODES) ──────────────────────
async function processShowGenre(genre) {
  showJobs[genre.name] = {
    status: 'processing',
    totalShows: 0,
    completedShows: 0,
    lastProcessed: null,
    playlist: null,
    error: null
  };

  try {
    const { items: shows } = await fetchAllItems(2, genre.filterId);

    const episodeIdToShowMap = new Map();
    for (const show of shows) {
      if (show.firstVideo && show.firstVideo.type === 'episode' && show.firstVideo.id) {
        episodeIdToShowMap.set(show.firstVideo.id, show);
      }
    }

    const episodeIds = [...episodeIdToShowMap.keys()];
    showJobs[genre.name].totalShows = episodeIds.length;
    console.log(`[SHOWS:${genre.name}] total shows = ${episodeIds.length}`);

    if (episodeIds.length === 0) {
      showJobs[genre.name].status = 'done';
      showJobs[genre.name].playlist = '#EXTM3U\n';
      return;
    }

    const episodeDetailsArray = await fetchEpisodeDetailsInBatches(episodeIds, (completed) => {
      showJobs[genre.name].completedShows = completed;
    });

    if (episodeDetailsArray.length === 0) {
      showJobs[genre.name].status = 'error';
      showJobs[genre.name].error = 'No episode details fetched.';
      return;
    }

    const episodeDetailMap = {};
    for (const detail of episodeDetailsArray) {
      episodeDetailMap[detail.showId] = detail;
    }

    const lines = ['#EXTM3U'];
    let validEpisodeCount = 0;

    for (const [episodeId, show] of episodeIdToShowMap) {
      const detail = episodeDetailMap[episodeId];
      if (!detail) continue;

      if (!detail.seasons) continue;
      for (const season of detail.seasons) {
        if (!season.episodes) continue;
        for (const episode of season.episodes) {
          const streamUrl = buildStreamUrl(episode);
          if (!streamUrl) continue;

          let logo = '';
          const landscape = episode.imageInfo?.find(img => img.type === 'landscape');
          if (landscape && landscape.url) {
            logo = buildImageUrl(landscape.url);
          }

          const title = `${show.title} - S${season.seasonNumber}E${episode.episodeNo} - ${episode.title}`;
          lines.push(`#EXTINF:-1 tvg-id="${show.id}" tvg-logo="${logo}" group-title="TV Show || ${genre.name}", ${title}`);
          lines.push(`${streamUrl}#.mp4`);
          validEpisodeCount++;
        }
      }
    }

    console.log(`[SHOWS:${genre.name}] valid episodes = ${validEpisodeCount}`);

    const playlist = lines.join('\n');
    cache.shows[genre.name] = { playlist, totalCount: validEpisodeCount };
    showJobs[genre.name].status = 'done';
    showJobs[genre.name].completedShows = episodeIds.length;
    showJobs[genre.name].lastProcessed = new Date().toISOString();
    showJobs[genre.name].playlist = playlist;
    showJobs[genre.name].validEpisodeCount = validEpisodeCount;
  } catch (err) {
    console.error(`[SHOWS:${genre.name}] processing error:`, err.message);
    showJobs[genre.name].status = 'error';
    showJobs[genre.name].lastProcessed = new Date().toISOString();
    showJobs[genre.name].error = err.message;
  }
}

// ─── UPDATE ALL MOVIES (all + genres) ───────────────────────────
async function updateAllMovies() {
  if (isBuildingMovies) return;
  isBuildingMovies = true;
  try {
    // 1. All Hindi movies (group title "All Hindi Movie")
    const totalAll = await fetchTotalCount(1);
    if (cache.movies.playlist === null || cache.movies.totalCount !== totalAll) {
      console.log('[MOVIES] rebuilding all Hindi movies...');
      const { items } = await fetchAllItems(1);
      const { playlist } = buildMoviesM3U(items, 'All Hindi Movie');
      cache.movies = { playlist, totalCount: totalAll };
    }

    // 2. Each movie genre (separate endpoints)
    for (const genre of movieGenres) {
      const totalGenre = await fetchTotalCount(1, genre.filterId);
      const cacheKey = genre.name;
      if (!cache.movieGenres[cacheKey] || cache.movieGenres[cacheKey].totalCount !== totalGenre) {
        console.log(`[MOVIES:${genre.name}] rebuilding...`);
        const { items } = await fetchAllItems(1, genre.filterId);
        const { playlist } = buildMoviesM3U(items, `MOVIE || ${genre.name}`);
        cache.movieGenres[cacheKey] = { playlist, totalCount: totalGenre };
      }
    }
  } catch (err) {
    console.error('[MOVIES] update error:', err.message);
  } finally {
    isBuildingMovies = false;
  }
}

// ─── SCHEDULE MOVIES UPDATE (12:00 AM IST) ──────────────────────
cron.schedule('0 0 * * *', () => {
  console.log('[CRON] Movies update');
  updateAllMovies();
}, { timezone: 'Asia/Kolkata' });

// Initial movies build on startup
updateAllMovies().catch(err => console.error('[STARTUP] Movies build failed:', err));

// ─── ROUTES ──────────────────────────────────────────────────────
app.get('/trigger/:genre', (req, res) => {
  const genreName = req.params.genre;
  const genre = showGenres.find(g => g.name.toLowerCase() === genreName.toLowerCase());

  if (!genre) {
    return res.status(404).json({ error: 'Show genre not found' });
  }

  const job = showJobs[genre.name];
  if (job && job.status === 'processing') {
    return res.json({
      status: 'processing',
      genre: genre.name,
      totalShows: job.totalShows,
      completedShows: job.completedShows
    });
  }

  processShowGenre(genre).catch(err => console.error(`[TRIGGER] ${genre.name} failed:`, err));

  return res.json({
    status: 'started',
    genre: genre.name,
    message: 'Processing started. Check back later for status.'
  });
});

app.get('/status/:genre', (req, res) => {
  const genreName = req.params.genre;
  const genre = showGenres.find(g => g.name.toLowerCase() === genreName.toLowerCase());
  if (!genre) return res.status(404).json({ error: 'Show genre not found' });

  const job = showJobs[genre.name];
  if (!job) return res.json({ status: 'idle' });
  return res.json(job);
});

// All Hindi movies
app.get('/hindi.m3u', (req, res) => {
  if (cache.movies.playlist) {
    res.setHeader('Content-Type', 'audio/x-mpegurl');
    res.setHeader('Cache-Control', 'public, max-age=1800');
    res.send(cache.movies.playlist);
  } else {
    res.status(503).send('Playlist is being generated. Please try again shortly.');
  }
});

// Movie genre endpoints
for (const genre of movieGenres) {
  app.get(genre.endpoint, (req, res) => {
    const genreCache = cache.movieGenres[genre.name];
    if (genreCache && genreCache.playlist) {
      res.setHeader('Content-Type', 'audio/x-mpegurl');
      res.setHeader('Cache-Control', 'public, max-age=1800');
      res.send(genreCache.playlist);
    } else {
      res.status(503).send('Playlist is being generated. Please try again shortly.');
    }
  });
}

// Show genre endpoints
for (const genre of showGenres) {
  app.get(genre.endpoint, (req, res) => {
    const genreCache = cache.shows[genre.name];
    if (genreCache && genreCache.playlist) {
      res.setHeader('Content-Type', 'audio/x-mpegurl');
      res.setHeader('Cache-Control', 'public, max-age=1800');
      res.send(genreCache.playlist);
    } else {
      res.status(503).send('Playlist not ready. Trigger /trigger/' + genre.name + ' to generate.');
    }
  });
}

// Combined index: All Hindi Movie + movie genres + all shows
app.get('/index.m3u', (req, res) => {
  if (cache.movies.playlist) {
    let combined = '#EXTM3U\n';
    combined += cache.movies.playlist + '\n';

    // Movie genres
    for (const genre of movieGenres) {
      const gc = cache.movieGenres[genre.name];
      if (gc && gc.playlist && gc.playlist.trim() !== '#EXTM3U') {
        const lines = gc.playlist.split('\n');
        if (lines[0] === '#EXTM3U') lines.shift();
        combined += lines.join('\n') + '\n';
      }
    }

    // Shows
    for (const genre of showGenres) {
      const gc = cache.shows[genre.name];
      if (gc && gc.playlist && gc.playlist.trim() !== '#EXTM3U') {
        const lines = gc.playlist.split('\n');
        if (lines[0] === '#EXTM3U') lines.shift();
        combined += lines.join('\n') + '\n';
      }
    }

    res.setHeader('Content-Type', 'audio/x-mpegurl');
    res.setHeader('Cache-Control', 'public, max-age=1800');
    res.send(combined);
  } else {
    res.status(503).send('Movies playlist not ready yet.');
  }
});

app.get('/', (req, res) => {
  res.send(`
    <h1>MX Player M3U Service</h1>
    <p>Available endpoints:</p>
    <ul>
      <li><a href="/hindi.m3u">/hindi.m3u</a> (All Hindi Movie)</li>
      <li>Movie genres: /movie-romance.m3u, /movie-comedy.m3u, /movie-action.m3u, /movie-crime.m3u, /movie-horror.m3u, /movie-animation.m3u, /movie-thriller.m3u, /movie-mystery.m3u</li>
      <li>Show genres: /romance.m3u, /drama.m3u, /comedy.m3u, /thriller.m3u, /crime.m3u, /horror.m3u, /action.m3u, /reality.m3u, /kdrama.m3u</li>
      <li>Trigger show processing: /trigger/Romance, /trigger/Drama, etc.</li>
      <li><a href="/index.m3u">/index.m3u</a> (All Hindi Movie + Movie genres + TV shows)</li>
    </ul>
  `);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
