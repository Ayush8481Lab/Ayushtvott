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
  movies: { playlist: null, totalCount: null },
  shows: {} // genre name -> { playlist, totalCount }
};

const showJobs = {}; // genre -> { status, totalShows, completedShows, lastProcessed, playlist, error? }

let isBuildingMovies = false;

// ─── GENRE DEFINITIONS ──────────────────────────────────────────
const genres = [
  { name: 'Romance', filterId: '1dfb3454a9898389b8eae7ba7d664bc0', endpoint: '/romance.m3u' },
  { name: 'Drama', filterId: '48efa872f6f17facebf6149dfc536ee1', endpoint: '/drama.m3u' },
  { name: 'Comedy', filterId: 'a24ddcadde26310ddfdb674e09e38eb5', endpoint: '/comedy.m3u' },
  { name: 'Thriller', filterId: '2dd5daf25be5619543524f360c73c3d8', endpoint: '/thriller.m3u' },
  { name: 'Crime', filterId: 'b413dff55bdad743c577a8bea3b65044', endpoint: '/crime.m3u' },
  { name: 'Horror', filterId: '2bab9af055150068ef74b58163dc638b', endpoint: '/horror.m3u' },
  { name: 'Action', filterId: '426ce788509fd7ac2814ae1639907fe3', endpoint: '/action.m3u' },
  { name: 'Reality Show', filterId: 'd63bdd9c0381a0cdd1e38a3cc9439e2c', endpoint: '/reality.m3u' },
  { name: 'K Drama', filterId: '0681d37530f4e2a8fc1f99bce0b707e4', endpoint: '/kdrama.m3u' }
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

// Fetch episode details using firstVideo.id (episode id) in batches of 5 with delay
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

// ─── PROCESS ONE GENRE (ALL EPISODES) ───────────────────────────
async function processGenre(genre) {
  showJobs[genre.name] = {
    status: 'processing',
    totalShows: 0,
    completedShows: 0,
    lastProcessed: null,
    playlist: null,
    error: null
  };

  try {
    const { items: shows, totalCount } = await fetchAllItems(2, genre.filterId);

    // Extract episode IDs from firstVideo.id (only those with type 'episode')
    const episodeIdToShowMap = new Map();
    for (const show of shows) {
      if (show.firstVideo && show.firstVideo.type === 'episode' && show.firstVideo.id) {
        episodeIdToShowMap.set(show.firstVideo.id, show);
      }
    }

    const episodeIds = [...episodeIdToShowMap.keys()];
    showJobs[genre.name].totalShows = episodeIds.length;
    console.log(`[SHOWS:${genre.name}] total shows with valid firstVideo = ${episodeIds.length}`);

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

    // Map by episode id (showId in response == the episode id we sent)
    const episodeDetailMap = {};
    for (const detail of episodeDetailsArray) {
      episodeDetailMap[detail.showId] = detail;
    }

    const lines = ['#EXTM3U'];
    let validEpisodeCount = 0;
    let missingDetails = 0;
    let missingStreamEpisodes = 0;

    for (const [episodeId, show] of episodeIdToShowMap) {
      const detail = episodeDetailMap[episodeId];
      if (!detail) {
        missingDetails++;
        continue;
      }

      // Iterate through all seasons and episodes
      if (!detail.seasons) continue;
      for (const season of detail.seasons) {
        if (!season.episodes) continue;
        for (const episode of season.episodes) {
          const streamUrl = buildStreamUrl(episode);
          if (!streamUrl) {
            missingStreamEpisodes++;
            continue;
          }

          let logo = '';
          const landscape = episode.imageInfo?.find(img => img.type === 'landscape');
          if (landscape && landscape.url) {
            logo = buildImageUrl(landscape.url);
          }

          const title = `${show.title} - S${season.seasonNumber}E${episode.episodeNo} - ${episode.title}`;
          lines.push(`#EXTINF:-1 tvg-id="${show.id}" tvg-logo="${logo}" group-title="${genre.name}", ${title}`);
          lines.push(`${streamUrl}#.mp4`);
          validEpisodeCount++;
        }
      }
    }

    console.log(`[SHOWS:${genre.name}] valid episodes: ${validEpisodeCount}, missing details: ${missingDetails}, missing stream episodes: ${missingStreamEpisodes}`);

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

// ─── UPDATE MOVIES (automatic) ──────────────────────────────────
async function updateMovies() {
  if (isBuildingMovies) return;
  isBuildingMovies = true;
  try {
    const total = await fetchTotalCount(1);
    if (cache.movies.playlist === null || cache.movies.totalCount !== total) {
      console.log('[MOVIES] rebuilding...');
      const { items } = await fetchAllItems(1);
      const { playlist } = buildMoviesM3U(items);
      cache.movies = { playlist, totalCount: total };
    }
  } catch (err) {
    console.error('[MOVIES] update error:', err.message);
  } finally {
    isBuildingMovies = false;
  }
}

// ─── SCHEDULE MOVIES UPDATE ─────────────────────────────────────
cron.schedule('0 0 * * *', () => {
  console.log('[CRON] Movies update');
  updateMovies();
}, { timezone: 'Asia/Kolkata' });

// Initial movies build on startup
updateMovies().catch(err => console.error('[STARTUP] Movies build failed:', err));

// ─── ROUTES ──────────────────────────────────────────────────────
app.get('/trigger/:genre', (req, res) => {
  const genreName = req.params.genre;
  const genre = genres.find(g => g.name.toLowerCase() === genreName.toLowerCase());

  if (!genre) {
    return res.status(404).json({ error: 'Genre not found' });
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

  processGenre(genre).catch(err => console.error(`[TRIGGER] ${genre.name} failed:`, err));

  return res.json({
    status: 'started',
    genre: genre.name,
    message: 'Processing started. Check back later for status.'
  });
});

app.get('/status/:genre', (req, res) => {
  const genreName = req.params.genre;
  const genre = genres.find(g => g.name.toLowerCase() === genreName.toLowerCase());
  if (!genre) return res.status(404).json({ error: 'Genre not found' });

  const job = showJobs[genre.name];
  if (!job) return res.json({ status: 'idle' });
  return res.json(job);
});

// Movies playlist
app.get('/hindi.m3u', (req, res) => {
  if (cache.movies.playlist) {
    res.setHeader('Content-Type', 'audio/x-mpegurl');
    res.setHeader('Cache-Control', 'public, max-age=1800');
    res.send(cache.movies.playlist);
  } else {
    res.status(503).send('Playlist is being generated. Please try again shortly.');
  }
});

// Genre playlist endpoints
for (const genre of genres) {
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

// Combined index
app.get('/index.m3u', (req, res) => {
  if (cache.movies.playlist) {
    let combined = '#EXTM3U\n';
    combined += cache.movies.playlist + '\n';
    for (const genre of genres) {
      const genreCache = cache.shows[genre.name];
      if (genreCache && genreCache.playlist && genreCache.playlist.trim() !== '#EXTM3U') {
        const lines = genreCache.playlist.split('\n');
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
      <li><a href="/hindi.m3u">/hindi.m3u</a> (movies)</li>
      <li><a href="/index.m3u">/index.m3u</a> (movies + all processed shows)</li>
      <li>Show genre playlists: /romance.m3u, /drama.m3u, /comedy.m3u, /thriller.m3u, /crime.m3u, /horror.m3u, /action.m3u, /reality.m3u, /kdrama.m3u</li>
      <li>Trigger processing: /trigger/Romance, /trigger/Drama, etc.</li>
    </ul>
  `);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
