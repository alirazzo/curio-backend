'use strict';

const express   = require('express');
const RSSParser = require('rss-parser');
const cors      = require('cors');
const SOURCES   = require('./sources');

const app = express();

// ─── RSS Parser ────────────────────────────────────────────────────────────────
const parser = new RSSParser({
  timeout: 4000,
  headers: { 'User-Agent': 'Curio/1.0 RSS Reader' },
  customFields: {
    item: [
      ['media:content',   'mediaContent',   { keepArray: false }],
      ['media:thumbnail', 'mediaThumbnail', { keepArray: false }],
      ['content:encoded', 'contentEncoded'],
    ],
  },
});

// ─── CORS ──────────────────────────────────────────────────────────────────────
// In production, replace '*' with your Netlify URL, e.g.:
// app.use(cors({ origin: 'https://your-app.netlify.app' }));
app.use(cors());

// ─── In-Memory Cache ───────────────────────────────────────────────────────────
const cache    = new Map();
const CACHE_MS = 15 * 60 * 1000; // 15 minutes

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_MS) { cache.delete(key); return null; }
  return entry.data;
}

function setCache(key, data) {
  cache.set(key, { data, ts: Date.now() });
  // Evict oldest if cache grows too large
  if (cache.size > 300) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) cache.delete(oldest[0]);
  }
}

// ─── Utilities ─────────────────────────────────────────────────────────────────
function stripHtml(html) {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function readTime(text) {
  if (!text) return '2 min';
  const words = text.trim().split(/\s+/).length;
  return Math.max(1, Math.round(words / 200)) + ' min';
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── Image Extraction ──────────────────────────────────────────────────────────
function extractImage(item) {
  // 1. media:content
  if (item.mediaContent) {
    const mc = Array.isArray(item.mediaContent) ? item.mediaContent[0] : item.mediaContent;
    const url = mc?.$?.url || mc?.url;
    if (url && isImageUrl(url)) return url;
  }
  // 2. media:thumbnail
  if (item.mediaThumbnail) {
    const mt = Array.isArray(item.mediaThumbnail) ? item.mediaThumbnail[0] : item.mediaThumbnail;
    const url = mt?.$?.url || mt?.url;
    if (url && isImageUrl(url)) return url;
  }
  // 3. RSS enclosure
  if (item.enclosure?.url && isImageUrl(item.enclosure.url)) {
    return item.enclosure.url;
  }
  // 4. First <img> in content:encoded or content
  const html = item.contentEncoded || item['content:encoded'] || item.content || '';
  const match = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (match && isImageUrl(match[1])) return match[1];
  return null;
}

function isImageUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (!url.startsWith('http')) return false;
  // Accept any URL — many CDNs don't use image extensions
  return true;
}

// ─── Normalize RSS Item → Curio Card ──────────────────────────────────────────
function normalizeItem(item, source) {
  if (!item.title || !item.link) return null;
  const image = extractImage(item);
  // Skip items without images (unless it's a trusted visual source)
  if (!image) return null;

  const rawText  = stripHtml(item.contentEncoded || item.content || item.contentSnippet || '');
  const excerpt  = rawText.slice(0, 240) + (rawText.length > 240 ? '…' : '');
  const idSeed   = (item.link || item.title || '').slice(0, 40);
  const id       = `${source.id}_${Buffer.from(idSeed).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 16)}`;

  const card = {
    id,
    source:      source.domain,
    sourceLabel: source.name,
    verified:    true,
    title:       item.title.trim(),
    excerpt:     excerpt || item.contentSnippet?.slice(0, 240) || '',
    image,
    url:         item.link,
    topic:       source.category,
    readTime:    readTime(rawText),
    type:        source.type,
    pubDate:     item.pubDate || item.isoDate || null,
  };

  // Attach bias data for news sources
  if (source.type === 'news' && source.reliability) {
    card.reliability = source.reliability;
    card.stance      = source.stance  || 'Unknown';
    card.funding     = source.funding || 'See source website for funding information.';
  }

  return card;
}

// ─── Fetch & Cache Single Feed ─────────────────────────────────────────────────
async function fetchFeed(source) {
  const cacheKey = 'feed_' + source.id;
  const cached   = getCached(cacheKey);
  if (cached) return cached;

  try {
    const feed  = await parser.parseURL(source.rss);
    const items = (feed.items || [])
      .map(item => normalizeItem(item, source))
      .filter(Boolean);

    setCache(cacheKey, items);
    return items;
  } catch (err) {
    // Don't crash the whole request for one bad feed
    console.warn(`[feed error] ${source.name}: ${err.message}`);
    return [];
  }
}

// ─── Aggregate Multiple Feeds ──────────────────────────────────────────────────
async function fetchSources(sourceList, limit) {
  // Pick a random spread from the source list for variety
  const selected = shuffle(sourceList).slice(0, Math.min(8, sourceList.length));

  const results = await Promise.allSettled(selected.map(s => fetchFeed(s)));

  const all = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value);

  // Deduplicate by URL
  const seen = new Set();
  const deduped = all.filter(c => {
    if (seen.has(c.url)) return false;
    seen.add(c.url);
    return true;
  });

  return shuffle(deduped).slice(0, limit);
}

// ─── Routes ────────────────────────────────────────────────────────────────────

// GET /api/feed?category=all&limit=50
// Returns learning content cards
app.get('/api/feed', async (req, res) => {
  try {
    const category = req.query.category || 'all';
    const limit    = Math.min(parseInt(req.query.limit) || 50, 100);

    const learnSources = SOURCES.filter(s =>
      s.type === 'learn' &&
      (category === 'all' || s.category === category)
    );

    if (!learnSources.length) {
      return res.status(400).json({ error: `Unknown category: ${category}` });
    }

    const items = await fetchSources(learnSources, limit);
    res.json({ items, count: items.length, category });
  } catch (err) {
    console.error('[/api/feed]', err);
    res.status(500).json({ error: 'Feed error', detail: err.message });
  }
});

// GET /api/news?limit=30
// Returns news cards with bias/reliability data
app.get('/api/news', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 30, 60);

    // Only use high-reliability news sources (≥82) to keep response fast
    // Priority sources always included; rest sampled randomly
    const PRIORITY_IDS = [
      'ap_news', 'reuters', 'bbc_news', 'guardian_world', 'npr_news',
      'dw_news', 'france24', 'propublica', 'un_news', 'noaa_news',
      'fda_press', 'fda_drugs', 'ema_news', 'reuters_health', 'statnews',
    ];

    const prioritySources = SOURCES.filter(s =>
      s.type === 'news' && PRIORITY_IDS.includes(s.id)
    );

    const otherSources = SOURCES.filter(s =>
      s.type === 'news' &&
      !PRIORITY_IDS.includes(s.id) &&
      (s.reliability || 0) >= 82
    );

    // Always fetch all priority sources + a random sample of others
    const selected = [
      ...prioritySources,
      ...shuffle(otherSources).slice(0, 3),
    ];

    const results = await Promise.allSettled(selected.map(s => fetchFeed(s)));

    const all = results
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.value);

    const seen = new Set();
    const deduped = all.filter(c => {
      if (seen.has(c.url)) return false;
      seen.add(c.url);
      return true;
    });

    const items = shuffle(deduped).slice(0, limit);
    res.json({ items, count: items.length });
  } catch (err) {
    console.error('[/api/news]', err);
    res.status(500).json({ error: 'News error', detail: err.message });
  }
});

// GET /api/categories
// Returns all available categories + source counts
app.get('/api/categories', (req, res) => {
  const counts = {};
  SOURCES.forEach(s => { counts[s.category] = (counts[s.category] || 0) + 1; });
  res.json({ categories: counts, total: SOURCES.length });
});

// GET /health
app.get('/health', (req, res) => {
  res.json({
    status:      'ok',
    sources:     SOURCES.length,
    cached:      cache.size,
    uptime:      Math.round(process.uptime()) + 's',
  });
});

// ─── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Curio backend running on port ${PORT}`);
  console.log(`${SOURCES.length} sources loaded across ${new Set(SOURCES.map(s => s.category)).size} categories`);
});
