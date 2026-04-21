'use strict';

const express   = require('express');
const RSSParser = require('rss-parser');
const cors      = require('cors');
const SOURCES   = require('./sources');

const app = express();

const GUARDIAN_KEY = process.env.GUARDIAN_KEY || 'test';

const GUARDIAN_TOPIC_MAP = {
  science: 'science', environment: 'environment', technology: 'technology',
  business: 'economics', 'us-news': 'news', world: 'news',
  politics: 'geopolitics', culture: 'art', books: 'literature',
  film: 'art', music: 'art', society: 'news', health: 'medicine',
};

const parser = new RSSParser({
  timeout: 5000,
  headers: { 'User-Agent': 'Curio/1.0 RSS Reader' },
  customFields: { item: [['media:content','mediaContent',{keepArray:false}],['media:thumbnail','mediaThumbnail',{keepArray:false}],['content:encoded','contentEncoded']] },
});

app.use(cors());

const cache = new Map();

function getCached(key, ttlMs = 15*60*1000) {
  const e = cache.get(key);
  if (!e || Date.now() - e.ts > ttlMs) { cache.delete(key); return null; }
  return e.data;
}
function setCache(key, data) {
  cache.set(key, { data, ts: Date.now() });
  if (cache.size > 500) { const oldest = [...cache.entries()].sort((a,b)=>a[1].ts-b[1].ts)[0]; if(oldest) cache.delete(oldest[0]); }
}

function stripHtml(html) {
  return (html||'').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/\s+/g,' ').trim();
}
function readTime(text) { return Math.max(1, Math.round((text||'').trim().split(/\s+/).length/200)) + ' min'; }
function shuffle(arr) { const a=arr.slice(); for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }
function dedup(items) { const seen=new Set(); return items.filter(c=>{ if(seen.has(c.url)) return false; seen.add(c.url); return true; }); }

function extractImage(item) {
  if (item.mediaContent) { const mc=Array.isArray(item.mediaContent)?item.mediaContent[0]:item.mediaContent; const u=mc?.$?.url||mc?.url; if(u?.startsWith('http')) return u; }
  if (item.mediaThumbnail) { const mt=Array.isArray(item.mediaThumbnail)?item.mediaThumbnail[0]:item.mediaThumbnail; const u=mt?.$?.url||mt?.url; if(u?.startsWith('http')) return u; }
  if (item.enclosure?.url?.startsWith('http')) return item.enclosure.url;
  const html = item.contentEncoded||item['content:encoded']||item.content||'';
  const match = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (match?.[1]?.startsWith('http')) return match[1];
  return null;
}

async function fetchFeed(source) {
  const cached = getCached('feed_'+source.id);
  if (cached) return cached;
  try {
    const feed = await parser.parseURL(source.rss);
    const items = (feed.items||[]).map(item => {
      if (!item.title||!item.link) return null;
      const image = extractImage(item); if(!image) return null;
      const text = stripHtml(item.contentEncoded||item.content||item.contentSnippet||'');
      return { id:source.id+'_'+Buffer.from(item.link.slice(-30)).toString('base64').replace(/\W/g,'').slice(0,14), source:source.domain, sourceLabel:source.name, verified:true, title:item.title.trim(), excerpt:text.slice(0,240)+(text.length>240?'…':''), image, url:item.link, topic:source.category, readTime:readTime(text), type:'learn' };
    }).filter(Boolean);
    setCache('feed_'+source.id, items);
    return items;
  } catch(err) { console.warn('[rss]', source.name, err.message); return []; }
}

async function fetchWikipedia(count=10, topic='general') {
  const cacheKey = `wiki_${topic}_${Math.floor(Date.now()/(10*60*1000))}`;
  const cached = getCached(cacheKey, 10*60*1000); if(cached) return cached;
  try {
    const r = await fetch(`https://en.wikipedia.org/w/api.php?action=query&generator=random&grnnamespace=0&grnlimit=${count}&prop=extracts|pageimages|info&exintro=true&exsentences=3&piprop=thumbnail&pithumbsize=800&inprop=url&format=json&origin=*`, {signal:AbortSignal.timeout(8000)});
    const data = await r.json();
    const items = Object.values(data.query?.pages||{}).filter(p=>p.thumbnail&&p.extract&&p.thumbnail.width>100).map(p=>({ id:'wiki_'+p.pageid, source:'wikipedia.org', sourceLabel:'Wikipedia', verified:true, title:p.title, excerpt:stripHtml(p.extract).slice(0,240)+'…', image:p.thumbnail.source, url:p.fullurl||`https://en.wikipedia.org/wiki/${encodeURIComponent(p.title)}`, topic, readTime:'3 min', type:'learn' }));
    setCache(cacheKey, items); return items;
  } catch(err) { console.warn('[wiki]', err.message); return []; }
}

async function fetchNASA(count=8) {
  const cached = getCached('nasa_apod', 60*60*1000); if(cached) return cached;
  try {
    const r = await fetch(`https://api.nasa.gov/planetary/apod?api_key=${process.env.NASA_KEY||'DEMO_KEY'}&count=${count}`, {signal:AbortSignal.timeout(8000)});
    const data = await r.json();
    if (!Array.isArray(data)) return [];
    const items = data.filter(d=>d.media_type==='image'&&d.url).map(d=>({ id:'nasa_'+d.date, source:'nasa.gov', sourceLabel:'NASA', verified:true, title:d.title, excerpt:(d.explanation||'').slice(0,240)+'…', image:d.url, url:`https://apod.nasa.gov/apod/ap${(d.date||'').replace(/-/g,'').slice(2)}.html`, topic:'space', readTime:readTime(d.explanation), type:'learn' }));
    setCache('nasa_apod', items); return items;
  } catch(err) { console.warn('[nasa]', err.message); return []; }
}

async function fetchGuardianSection(section, topic, pageSize=15, orderBy='relevance') {
  const cacheKey = `g_${section}_${orderBy}`;
  const ttl = orderBy === 'newest' ? 10*60*1000 : 60*60*1000;
  const cached = getCached(cacheKey, ttl); if(cached) return cached;
  try {
    const sectionParam = section ? `&section=${section}` : '';
    const r = await fetch(`https://content.guardianapis.com/search?show-fields=thumbnail,trailText,sectionId&page-size=${pageSize}&order-by=${orderBy}${sectionParam}&api-key=${GUARDIAN_KEY}`, {signal:AbortSignal.timeout(8000)});
    const data = await r.json();
    const items = (data.response?.results||[]).filter(a=>a.fields?.thumbnail).map(a=>({ id:'g_'+a.id.replace(/\W/g,'_').slice(-20), source:'theguardian.com', sourceLabel:'The Guardian', verified:true, title:a.webTitle, excerpt:stripHtml(a.fields.trailText||'').slice(0,240)+'…', image:a.fields.thumbnail, url:a.webUrl, topic: topic || GUARDIAN_TOPIC_MAP[a.sectionId] || 'news', readTime:'3 min', type: orderBy==='newest' ? 'news' : 'learn', ...(orderBy==='newest' ? { reliability:84, stance:'Centre-Left', funding:'Scott Trust (not-for-profit). No paywall. No single commercial owner.' } : {}), pubDate:a.webPublicationDate||null }));
    setCache(cacheKey, items); return items;
  } catch(err) { console.warn('[guardian]', section, err.message); return []; }
}

// ─── Routes ────────────────────────────────────────────────────────────────────

app.get('/api/feed', async (req, res) => {
  try {
    const category = req.query.category || 'all';
    const limit    = Math.min(parseInt(req.query.limit)||50, 100);
    let items = [];

    if (category === 'all') {
      const fetchers = [
        fetchNASA(8),
        fetchGuardianSection('science',     'science',     15),
        fetchGuardianSection('environment', 'environment', 15),
        fetchGuardianSection('technology',  'technology',  15),
        fetchGuardianSection('business',    'economics',   15),
        fetchGuardianSection('culture',     'art',         15),
        fetchGuardianSection('books',       'literature',  15),
        fetchGuardianSection('health',      'medicine',    15),
        fetchWikipedia(10, 'history'),
        fetchWikipedia(8,  'geography'),
        fetchWikipedia(8,  'biology'),
        fetchWikipedia(8,  'psychology'),
        fetchWikipedia(8,  'chemistry'),
        fetchWikipedia(8,  'philosophy'),
        fetchGuardianSection('science',     'pharma',      12),
        fetchGuardianSection('world',       'geopolitics', 12),
        fetchGuardianSection('technology',  'ai',          12),
        fetchWikipedia(8,  'microbiology'),
      ];
      const results = await Promise.allSettled(fetchers);
      const all = results.filter(r=>r.status==='fulfilled').flatMap(r=>r.value.slice(0,4));
      items = shuffle(dedup(all)).slice(0, limit);
    } else {
      const pool = SOURCES.filter(s=>s.type==='learn'&&s.category===category);
      const results = await Promise.allSettled(shuffle(pool).slice(0,6).map(s=>fetchFeed(s)));
      items = shuffle(dedup(results.filter(r=>r.status==='fulfilled').flatMap(r=>r.value))).slice(0, limit);
    }

    res.json({ items, count: items.length, category });
  } catch(err) { console.error('[/api/feed]', err); res.status(500).json({ error: 'Feed error' }); }
});

// GET /api/news — Guardian API only (RSS feeds are Cloudflare-blocked from servers)
app.get('/api/news', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit)||30, 60);
    const sections = ['world','us-news','environment','technology','business','science','society'];
    const results = await Promise.allSettled(sections.map(s => fetchGuardianSection(s, null, 10, 'newest')));
    const all = results.filter(r=>r.status==='fulfilled').flatMap(r=>r.value);
    const items = shuffle(dedup(all)).slice(0, limit);
    res.json({ items, count: items.length });
  } catch(err) { console.error('[/api/news]', err); res.status(500).json({ error: 'News error' }); }
});

app.get('/api/categories', (req, res) => {
  const counts = {};
  SOURCES.forEach(s=>{ counts[s.category]=(counts[s.category]||0)+1; });
  res.json({ categories: counts, total: SOURCES.length });
});

app.get('/health', (req, res) => {
  res.json({ status:'ok', sources:SOURCES.length, cached:cache.size, uptime:Math.round(process.uptime())+'s', guardianKey: GUARDIAN_KEY==='test'?'test (limited)':'custom ✓' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Curio backend on port ${PORT} — Guardian key: ${GUARDIAN_KEY==='test'?'test':'custom'}`);
});
