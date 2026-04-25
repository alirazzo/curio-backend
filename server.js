'use strict';

const express   = require('express');
const RSSParser = require('rss-parser');
const cors      = require('cors');
const app       = express();

// ─── Keys ─────────────────────────────────────────────────────────────────────
const GUARDIAN_KEY = process.env.GUARDIAN_KEY || 'test';
const NASA_KEY     = process.env.NASA_KEY     || 'DEMO_KEY';
const PIXABAY_KEY  = process.env.PIXABAY_KEY  || '';

// ─── RSS Parser ────────────────────────────────────────────────────────────────
const parser = new RSSParser({
  timeout: 6000,
  headers: { 'User-Agent': 'Curio/1.0 (+https://curio-app.netlify.app)' },
  customFields: { item: [
    ['media:content',   'mediaContent',   { keepArray: false }],
    ['media:thumbnail', 'mediaThumbnail', { keepArray: false }],
    ['content:encoded', 'contentEncoded'],
  ]},
});

app.use(cors());

// ─── In-Memory Cache ───────────────────────────────────────────────────────────
const cache = new Map();
function getCached(key, ttl = 15 * 60 * 1000) {
  const e = cache.get(key);
  if (!e || Date.now() - e.ts > ttl) { cache.delete(key); return null; }
  return e.data;
}
function setCache(key, data) {
  cache.set(key, { data, ts: Date.now() });
  if (cache.size > 600) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) cache.delete(oldest[0]);
  }
}

// ─── Pixabay Image Pools ────────────────────────────────────────────────────────
// Pre-loaded at startup per topic — zero latency at display time
const imagePool = new Map(); // topic -> [url, url, ...]

const PIXABAY_QUERIES = {
  pharma:       'pharmaceutical laboratory scientist research',
  medicine:     'medical hospital doctor healthcare',
  microbiology: 'microscope bacteria cells biology laboratory',
  science:      'science laboratory research experiment',
  ai:           'artificial intelligence technology neural network',
  chemistry:    'chemistry laboratory molecules chemical',
  space:        'galaxy nebula cosmos stars astronomy',
  biology:      'nature biology wildlife organism',
  technology:   'technology computer digital innovation',
  history:      'ancient history civilization architecture monument',
  geography:    'landscape geography mountains earth aerial',
  economics:    'finance economics city business skyline',
  environment:  'nature environment forest ecology climate',
  geopolitics:  'world map globe politics diplomacy',
  psychology:   'brain mind psychology human thinking',
  art:          'art painting gallery museum creative',
  literature:   'books library reading literature',
  philosophy:   'philosophy thinking contemplation wisdom',
  news:         'newspaper journalism media press',
  general:      'knowledge learning education curiosity',
};

async function loadPixabayPool(topic, query) {
  if (!PIXABAY_KEY) return;
  try {
    const url = `https://pixabay.com/api/?key=${PIXABAY_KEY}&q=${encodeURIComponent(query)}&image_type=photo&orientation=horizontal&per_page=100&safesearch=true&min_width=640`;
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const data = await r.json();
    const urls = (data.hits || []).map(h => h.webformatURL).filter(Boolean);
    if (urls.length > 0) {
      imagePool.set(topic, urls);
      console.log(`[pixabay] ${topic}: ${urls.length} images loaded`);
    }
  } catch (e) {
    console.warn(`[pixabay] ${topic} failed:`, e.message);
  }
}

function pickImage(topic) {
  const pool = imagePool.get(topic) || imagePool.get('general') || [];
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

async function preloadAllPools() {
  if (!PIXABAY_KEY) {
    console.log('[pixabay] No key set — skipping image pools. Set PIXABAY_KEY in Render environment variables.');
    return;
  }
  console.log('[pixabay] Pre-loading image pools...');
  const entries = Object.entries(PIXABAY_QUERIES);
  // Load in batches of 5 to respect rate limits
  for (let i = 0; i < entries.length; i += 5) {
    await Promise.all(entries.slice(i, i + 5).map(([t, q]) => loadPixabayPool(t, q)));
    if (i + 5 < entries.length) await new Promise(r => setTimeout(r, 1000));
  }
  console.log('[pixabay] All pools ready');
}

// Refresh pools every 24 hours for freshness
setInterval(preloadAllPools, 24 * 60 * 60 * 1000);

// ─── Utilities ─────────────────────────────────────────────────────────────────
function strip(html) {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#\d+;/g, '')
    .replace(/\s+/g, ' ').trim();
}
function readTime(t) { return Math.max(1, Math.round((t || '').trim().split(/\s+/).length / 200)) + ' min'; }
function shuffle(a) {
  const b = a.slice();
  for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; }
  return b;
}
function dedup(items) {
  const s = new Set();
  return items.filter(c => { if (s.has(c.url)) return false; s.add(c.url); return true; });
}

// Max 2 articles per source in the final shuffled result
function distributeBySource(items, limit) {
  const bySource = {};
  items.forEach(item => {
    if (!bySource[item.source]) bySource[item.source] = [];
    bySource[item.source].push(item);
  });
  const groups = shuffle(Object.values(bySource).map(a => shuffle(a)));
  const result = [];
  for (let round = 0; round < 3; round++) {
    for (const arr of groups) {
      if (arr[round]) {
        result.push(arr[round]);
        if (result.length >= limit) return shuffle(result);
      }
    }
  }
  return shuffle(result);
}

function withImage(item) {
  if (!item.image) item.image = pickImage(item.topic);
  return item;
}

// ─── Image Extraction from RSS ──────────────────────────────────────────────────
function extractRSSImage(item) {
  if (item.mediaContent) {
    const m = Array.isArray(item.mediaContent) ? item.mediaContent[0] : item.mediaContent;
    const u = m?.$?.url || m?.url;
    if (u?.startsWith('http')) return u;
  }
  if (item.mediaThumbnail) {
    const m = Array.isArray(item.mediaThumbnail) ? item.mediaThumbnail[0] : item.mediaThumbnail;
    const u = m?.$?.url || m?.url;
    if (u?.startsWith('http')) return u;
  }
  if (item.enclosure?.url?.startsWith('http')) return item.enclosure.url;
  const html = item.contentEncoded || item['content:encoded'] || item.content || '';
  const match = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (match?.[1]?.startsWith('http')) return match[1];
  return null;
}

// ─── RSS Fetcher ────────────────────────────────────────────────────────────────
async function fetchRSS(id, url, sourceLabel, domain, topic) {
  const cacheKey = 'rss_' + id;
  const cached   = getCached(cacheKey, 30 * 60 * 1000);
  if (cached) return cached;
  try {
    const feed  = await parser.parseURL(url);
    const items = (feed.items || []).slice(0, 20).map(item => {
      if (!item.title || !item.link) return null;
      const text = strip(item.contentEncoded || item.content || item.contentSnippet || '');
      const img  = extractRSSImage(item);
      return {
        id:          id + '_' + Buffer.from((item.link || item.title).slice(-24)).toString('base64').replace(/\W/g, '').slice(0, 12),
        source:      domain,
        sourceLabel: sourceLabel,
        verified:    true,
        title:       item.title.trim(),
        excerpt:     text.slice(0, 240) + (text.length > 240 ? '…' : ''),
        image:       img || null,
        url:         item.link,
        topic:       topic,
        readTime:    readTime(text),
        type:        'learn',
      };
    }).filter(Boolean).map(withImage);
    setCache(cacheKey, items);
    return items;
  } catch (e) {
    console.warn('[rss]', sourceLabel, e.message);
    return [];
  }
}

// ─── Wikipedia ──────────────────────────────────────────────────────────────────
async function fetchWikipedia(count = 10, topic = 'general') {
  const key    = `wiki_${topic}_${Math.floor(Date.now() / (10 * 60 * 1000))}`;
  const cached = getCached(key, 10 * 60 * 1000);
  if (cached) return cached;
  try {
    const r = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&generator=random&grnnamespace=0&grnlimit=${count}&prop=extracts|pageimages|info&exintro=true&exsentences=3&piprop=thumbnail&pithumbsize=800&inprop=url&format=json&origin=*`,
      { signal: AbortSignal.timeout(8000) }
    );
    const data  = await r.json();
    const items = Object.values(data.query?.pages || {})
      .filter(p => p.extract)
      .map(p => {
        const img = p.thumbnail ? p.thumbnail.source : pickImage(topic);
        return {
          id:          'wiki_' + p.pageid,
          source:      'wikipedia.org',
          sourceLabel: 'Wikipedia',
          verified:    true,
          title:       p.title,
          excerpt:     strip(p.extract).slice(0, 240) + '…',
          image:       img,
          url:         p.fullurl || `https://en.wikipedia.org/wiki/${encodeURIComponent(p.title)}`,
          topic,
          readTime:    '3 min',
          type:        'learn',
        };
      });
    setCache(key, items);
    return items;
  } catch (e) { console.warn('[wiki]', e.message); return []; }
}

// ─── NASA APOD ──────────────────────────────────────────────────────────────────
async function fetchNASA(count = 10) {
  const cached = getCached('nasa', 60 * 60 * 1000);
  if (cached) return cached;
  try {
    const r = await fetch(
      `https://api.nasa.gov/planetary/apod?api_key=${NASA_KEY}&count=${count}`,
      { signal: AbortSignal.timeout(8000) }
    );
    const data  = await r.json();
    if (!Array.isArray(data)) return [];
    const items = data.filter(d => d.media_type === 'image' && d.url).map(d => ({
      id:          'nasa_' + d.date,
      source:      'nasa.gov',
      sourceLabel: 'NASA',
      verified:    true,
      title:       d.title,
      excerpt:     (d.explanation || '').slice(0, 240) + '…',
      image:       d.url,
      url:         `https://apod.nasa.gov/apod/ap${(d.date || '').replace(/-/g, '').slice(2)}.html`,
      topic:       'space',
      readTime:    readTime(d.explanation),
      type:        'learn',
    }));
    setCache('nasa', items);
    return items;
  } catch (e) { console.warn('[nasa]', e.message); return []; }
}

// ─── Guardian API ───────────────────────────────────────────────────────────────
async function fetchGuardian(section, topic, pageSize = 15, orderBy = 'relevance') {
  const key    = `g_${section}_${orderBy}_${Math.floor(Date.now() / (15 * 60 * 1000))}`;
  const ttl    = orderBy === 'newest' ? 15 * 60 * 1000 : 60 * 60 * 1000;
  const cached = getCached(key, ttl);
  if (cached) return cached;
  try {
    const sp = section ? `&section=${section}` : '';
    const r  = await fetch(
      `https://content.guardianapis.com/search?show-fields=thumbnail,trailText,sectionId&page-size=${pageSize}&order-by=${orderBy}${sp}&api-key=${GUARDIAN_KEY}`,
      { signal: AbortSignal.timeout(8000) }
    );
    const data  = await r.json();
    const items = (data.response?.results || []).map(a => {
      const img = a.fields?.thumbnail || pickImage(topic);
      return {
        id:          'g_' + a.id.replace(/\W/g, '_').slice(-18),
        source:      'theguardian.com',
        sourceLabel: 'The Guardian',
        verified:    true,
        title:       a.webTitle,
        excerpt:     strip(a.fields?.trailText || '').slice(0, 240) + '…',
        image:       img,
        url:         a.webUrl,
        topic:       topic || 'news',
        readTime:    '4 min',
        type:        orderBy === 'newest' ? 'news' : 'learn',
        pubDate:     a.webPublicationDate || null,
      };
    });
    setCache(key, items);
    return items;
  } catch (e) { console.warn('[guardian]', section, e.message); return []; }
}

// ─── arXiv API ─────────────────────────────────────────────────────────────────
// arXiv.org never blocks — no Cloudflare, purpose-built for programmatic access
async function fetchArxiv(query, category, topic, maxResults = 10) {
  const key    = `arxiv_${category}_${Math.floor(Date.now() / (30 * 60 * 1000))}`;
  const cached = getCached(key, 30 * 60 * 1000);
  if (cached) return cached;
  try {
    const r = await fetch(
      `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(query)}&start=0&max_results=${maxResults}&sortBy=submittedDate&sortOrder=descending`,
      { signal: AbortSignal.timeout(10000) }
    );
    const xml  = await r.text();
    const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
    const items   = entries.map((m, i) => {
      const e       = m[1];
      const title   = strip((e.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '').replace(/\n/g, ' '));
      const summary = strip((e.match(/<summary>([\s\S]*?)<\/summary>/)?.[1] || '').replace(/\n/g, ' '));
      const link    = (e.match(/<id>([\s\S]*?)<\/id>/)?.[1] || '').replace('http://', 'https://').trim();
      const authors = [...e.matchAll(/<name>([\s\S]*?)<\/name>/g)].map(a => a[1].trim()).slice(0, 3).join(', ');
      if (!title || !link) return null;
      return {
        id:          'arxiv_' + category + '_' + i,
        source:      'arxiv.org',
        sourceLabel: 'arXiv',
        verified:    true,
        title:       title,
        excerpt:     (authors ? authors + ' — ' : '') + summary.slice(0, 220) + '…',
        image:       pickImage(topic),
        url:         link,
        topic:       topic,
        readTime:    '5 min',
        type:        'learn',
      };
    }).filter(Boolean);
    setCache(key, items);
    return items;
  } catch (e) { console.warn('[arxiv]', category, e.message); return []; }
}

// ─── PubMed API ────────────────────────────────────────────────────────────────
// NCBI E-utilities — free, no key needed, designed for programmatic access
async function fetchPubMed(query, topic, retmax = 8) {
  const key    = `pubmed_${topic}_${Math.floor(Date.now() / (30 * 60 * 1000))}`;
  const cached = getCached(key, 30 * 60 * 1000);
  if (cached) return cached;
  try {
    // Step 1: search for IDs
    const searchR = await fetch(
      `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmax=${retmax}&sort=date&format=json&tool=curio&email=curio@curio.app`,
      { signal: AbortSignal.timeout(8000) }
    );
    const searchData = await searchR.json();
    const ids = (searchData.esearchresult?.idlist || []).join(',');
    if (!ids) return [];

    // Step 2: fetch summaries
    const summaryR = await fetch(
      `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${ids}&format=json&tool=curio&email=curio@curio.app`,
      { signal: AbortSignal.timeout(8000) }
    );
    const summaryData = await summaryR.json();
    const uids = summaryData.result?.uids || [];
    const items = uids.map(uid => {
      const rec = summaryData.result[uid];
      if (!rec || !rec.title) return null;
      const authors = (rec.authors || []).slice(0, 3).map(a => a.name).join(', ');
      const journal = rec.fulljournalname || rec.source || '';
      return {
        id:          'pubmed_' + uid,
        source:      'pubmed.ncbi.nlm.nih.gov',
        sourceLabel: 'PubMed / ' + (journal.length > 30 ? journal.slice(0, 30) + '…' : journal),
        verified:    true,
        title:       strip(rec.title),
        excerpt:     (authors ? authors + ' · ' : '') + journal + (rec.pubdate ? ' (' + rec.pubdate.slice(0, 4) + ')' : ''),
        image:       pickImage(topic),
        url:         'https://pubmed.ncbi.nlm.nih.gov/' + uid + '/',
        topic:       topic,
        readTime:    '6 min',
        type:        'learn',
      };
    }).filter(Boolean);
    setCache(key, items);
    return items;
  } catch (e) { console.warn('[pubmed]', topic, e.message); return []; }
}

// ─── PLOS API ──────────────────────────────────────────────────────────────────
// Public Library of Science — fully open access, free API
async function fetchPLOS(query, topic, rows = 8) {
  const key    = `plos_${topic}_${Math.floor(Date.now() / (30 * 60 * 1000))}`;
  const cached = getCached(key, 30 * 60 * 1000);
  if (cached) return cached;
  try {
    const r = await fetch(
      `https://api.plos.org/search?q=${encodeURIComponent(query)}&fl=id,title,abstract,author_display,journal&rows=${rows}&sort=publication_date+desc&wt=json`,
      { signal: AbortSignal.timeout(8000) }
    );
    const data  = await r.json();
    const docs  = data.response?.docs || [];
    const items = docs.map(d => {
      const doi = d.id || '';
      if (!d.title || !doi) return null;
      const authors = (d.author_display || []).slice(0, 3).join(', ');
      const abstract = Array.isArray(d.abstract) ? d.abstract[0] : (d.abstract || '');
      return {
        id:          'plos_' + doi.replace(/\W/g, '_').slice(-14),
        source:      'plos.org',
        sourceLabel: 'PLOS ' + (d.journal || 'ONE'),
        verified:    true,
        title:       Array.isArray(d.title) ? d.title[0] : d.title,
        excerpt:     (authors ? authors + ' — ' : '') + strip(abstract).slice(0, 220) + '…',
        image:       pickImage(topic),
        url:         'https://doi.org/' + doi,
        topic:       topic,
        readTime:    '6 min',
        type:        'learn',
      };
    }).filter(Boolean);
    setCache(key, items);
    return items;
  } catch (e) { console.warn('[plos]', topic, e.message); return []; }
}

// ─── Working RSS Feeds (no Cloudflare blocking) ─────────────────────────────────
// Sources confirmed to work from server IPs:
// - .gov and .edu domains never block
// - theconversation.com (purpose-built for RSS syndication)
// - quantamagazine.org (no Cloudflare)
// - carbonbrief.org (no Cloudflare)
// - atlasobscura.com (works from servers)
// - warontherocks.com (no Cloudflare)
// - eurekalert.org (AAAS — designed for press pickup)
// - Substack feeds (explicitly open for syndication)

const RSS_SOURCES = [
  // Science & Research
  { id:'quanta',       url:'https://api.quantamagazine.org/feed/', label:'Quanta Magazine',   domain:'quantamagazine.org',   topic:'science'     },
  { id:'conversation_sci', url:'https://theconversation.com/science/rss.xml', label:'The Conversation', domain:'theconversation.com', topic:'science' },
  { id:'eurekalert',   url:'https://www.eurekalert.org/rss/',     label:'EurekAlert (AAAS)', domain:'eurekalert.org',       topic:'science'     },
  { id:'futurity',     url:'https://www.futurity.org/feed/',       label:'Futurity',          domain:'futurity.org',         topic:'science'     },
  { id:'mit_news',     url:'https://news.mit.edu/rss/research',   label:'MIT News',          domain:'news.mit.edu',         topic:'technology'  },
  { id:'stanford',     url:'https://news.stanford.edu/feed/',     label:'Stanford News',     domain:'news.stanford.edu',    topic:'science'     },
  // AI / ML (Substack + open blogs)
  { id:'import_ai',    url:'https://importai.substack.com/feed',  label:'Import AI',         domain:'importai.substack.com', topic:'ai'         },
  { id:'ahead_of_ai',  url:'https://magazine.sebastianraschka.com/feed', label:'Ahead of AI', domain:'sebastianraschka.com', topic:'ai'        },
  { id:'bair_blog',    url:'https://bair.berkeley.edu/blog/feed.xml', label:'BAIR Blog (Berkeley)', domain:'bair.berkeley.edu', topic:'ai'      },
  { id:'gradient',     url:'https://thegradient.pub/rss/',        label:'The Gradient',      domain:'thegradient.pub',      topic:'ai'          },
  { id:'last_week_ai', url:'https://lastweekin.ai/feed',          label:'Last Week in AI',   domain:'lastweekin.ai',        topic:'ai'          },
  { id:'interconnects', url:'https://www.interconnects.ai/feed',  label:'Interconnects',     domain:'interconnects.ai',     topic:'ai'          },
  // Environment / Climate
  { id:'carbonbrief',  url:'https://www.carbonbrief.org/feed',    label:'Carbon Brief',      domain:'carbonbrief.org',      topic:'environment' },
  { id:'mongabay',     url:'https://news.mongabay.com/feed/',     label:'Mongabay',          domain:'mongabay.com',         topic:'environment' },
  { id:'inside_climate', url:'https://insideclimatenews.org/feed/', label:'Inside Climate News', domain:'insideclimatenews.org', topic:'environment' },
  { id:'noaa',         url:'https://www.noaa.gov/news-release/rss.xml', label:'NOAA',       domain:'noaa.gov',             topic:'environment' },
  // Geography / History
  { id:'atlas_obscura', url:'https://www.atlasobscura.com/feeds/latest', label:'Atlas Obscura', domain:'atlasobscura.com', topic:'geography' },
  { id:'smithsonian',  url:'https://www.smithsonianmag.com/rss/history-archaeology/', label:'Smithsonian History', domain:'smithsonianmag.com', topic:'history' },
  { id:'archaeology',  url:'https://www.archaeology.org/feed',   label:'Archaeology Magazine', domain:'archaeology.org',  topic:'history'     },
  { id:'history_today', url:'https://www.historytoday.com/feed/', label:'History Today',    domain:'historytoday.com',     topic:'history'     },
  // Geopolitics
  { id:'warontherocks', url:'https://warontherocks.com/feed/',    label:'War on the Rocks',  domain:'warontherocks.com',    topic:'geopolitics' },
  { id:'crisis_group', url:'https://www.crisisgroup.org/rss.xml', label:'Crisis Group',     domain:'crisisgroup.org',      topic:'geopolitics' },
  { id:'lawfare',      url:'https://www.lawfaremedia.org/feed',   label:'Lawfare',           domain:'lawfaremedia.org',     topic:'geopolitics' },
  { id:'cfr',          url:'https://www.cfr.org/rss.xml',         label:'Council on Foreign Relations', domain:'cfr.org', topic:'geopolitics' },
  // Medicine / Pharma
  { id:'fiercepharma', url:'https://www.fiercepharma.com/rss/xml', label:'FiercePharma',   domain:'fiercepharma.com',     topic:'pharma'      },
  { id:'statnews',     url:'https://www.statnews.com/feed/',       label:'STAT News',        domain:'statnews.com',         topic:'pharma'      },
  { id:'fda_press',    url:'https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/press-releases/rss.xml', label:'FDA Press Releases', domain:'fda.gov', topic:'pharma' },
  { id:'nih_news',     url:'https://www.nih.gov/research-training/research-matters/rss', label:'NIH Research Matters', domain:'nih.gov', topic:'medicine' },
  { id:'who_news',     url:'https://www.who.int/rss-feeds/news-english.xml', label:'WHO News', domain:'who.int',          topic:'medicine'    },
  // Economics
  { id:'bruegel',      url:'https://www.bruegel.org/feed',         label:'Bruegel',          domain:'bruegel.org',          topic:'economics'   },
  { id:'voxeu',        url:'https://voxeu.org/feed',               label:'VoxEU',            domain:'voxeu.org',            topic:'economics'   },
  { id:'imf_blog',     url:'https://www.imf.org/en/Blogs/rss',     label:'IMF Blog',         domain:'imf.org',              topic:'economics'   },
  { id:'owid',         url:'https://ourworldindata.org/atom.xml',  label:'Our World in Data', domain:'ourworldindata.org',  topic:'economics'   },
  // Art / Literature
  { id:'hyperallergic', url:'https://hyperallergic.com/feed/',     label:'Hyperallergic',    domain:'hyperallergic.com',    topic:'art'         },
  { id:'lithub',       url:'https://lithub.com/feed/',             label:'Literary Hub',     domain:'lithub.com',           topic:'literature'  },
  { id:'paris_review', url:'https://www.theparisreview.org/feed/', label:'Paris Review',     domain:'theparisreview.org',   topic:'literature'  },
  { id:'aeon',         url:'https://aeon.co/feed.rss',             label:'Aeon',             domain:'aeon.co',              topic:'philosophy'  },
  // Philosophy
  { id:'sep_shorts',   url:'https://plato.stanford.edu/rss/sep.xml', label:'Stanford Encyclopedia', domain:'plato.stanford.edu', topic:'philosophy' },
  { id:'iai_news',     url:'https://iai.tv/rss',                   label:'IAI News',         domain:'iai.tv',               topic:'philosophy'  },
  // Psychology
  { id:'bps_digest',   url:'https://digest.bps.org.uk/feed/',      label:'BPS Research Digest', domain:'bps.org.uk',       topic:'psychology'  },
  { id:'neuro_news',   url:'https://neurosciencenews.com/feed/',   label:'Neuroscience News', domain:'neurosciencenews.com', topic:'psychology' },
  // Chemistry
  { id:'chem_world',   url:'https://www.chemistryworld.com/feeds/news', label:'Chemistry World', domain:'chemistryworld.com', topic:'chemistry' },
  // Space (supplemental)
  { id:'eso',          url:'https://www.eso.org/public/news/rss/',  label:'ESO',              domain:'eso.org',              topic:'space'       },
  { id:'space_com',    url:'https://www.space.com/feeds/all',       label:'Space.com',        domain:'space.com',            topic:'space'       },
  { id:'planetary_org', url:'https://www.planetary.org/feed',      label:'Planetary Society', domain:'planetary.org',       topic:'space'       },
];

// ─── Category Fetchers ──────────────────────────────────────────────────────────
const CATEGORY_FETCHERS = {
  pharma: () => Promise.all([
    fetchGuardian('science', 'pharma', 10),
    fetchPubMed('drug discovery clinical trial pharmaceutical', 'pharma', 8),
    fetchRSS_by_topic('pharma', 3),
  ]).then(r => r.flat()),

  medicine: () => Promise.all([
    fetchGuardian('health', 'medicine', 12),
    fetchPubMed('clinical medicine treatment therapy', 'medicine', 8),
    fetchPLOS('medicine clinical', 'medicine', 6),
    fetchRSS_by_topic('medicine', 3),
  ]).then(r => r.flat()),

  microbiology: () => Promise.all([
    fetchPubMed('microbiology bacteria virus infection', 'microbiology', 8),
    fetchPLOS('microbiology infection pathogen', 'microbiology', 6),
    fetchArxiv('cat:q-bio.MN OR cat:q-bio.PE', 'microbiology', 'microbiology', 8),
    fetchWikipedia(6, 'microbiology'),
  ]).then(r => r.flat()),

  science: () => Promise.all([
    fetchGuardian('science', 'science', 12),
    fetchRSS_by_topic('science', 4),
    fetchArxiv('cat:physics OR cat:cond-mat', 'physics', 'science', 6),
    fetchWikipedia(6, 'science'),
  ]).then(r => r.flat()),

  ai: () => Promise.all([
    fetchGuardian('technology', 'ai', 8),
    fetchArxiv('cat:cs.AI OR cat:cs.LG OR cat:cs.CL', 'cs_ai', 'ai', 10),
    fetchRSS_by_topic('ai', 6),
  ]).then(r => r.flat()),

  chemistry: () => Promise.all([
    fetchArxiv('cat:chem-ph OR cat:physics.chem-ph', 'chemistry', 'chemistry', 8),
    fetchPubMed('chemistry synthesis molecular', 'chemistry', 6),
    fetchRSS_by_topic('chemistry', 3),
    fetchWikipedia(5, 'chemistry'),
  ]).then(r => r.flat()),

  space: () => Promise.all([
    fetchNASA(12),
    fetchArxiv('cat:astro-ph', 'astrophysics', 'space', 8),
    fetchRSS_by_topic('space', 4),
  ]).then(r => r.flat()),

  biology: () => Promise.all([
    fetchPLOS('biology ecology evolution genetics', 'biology', 8),
    fetchArxiv('cat:q-bio', 'qbio', 'biology', 8),
    fetchWikipedia(8, 'biology'),
  ]).then(r => r.flat()),

  technology: () => Promise.all([
    fetchGuardian('technology', 'technology', 12),
    fetchArxiv('cat:cs.SE OR cat:cs.NI OR cat:cs.CR', 'cs_tech', 'technology', 6),
    fetchRSS_by_topic('technology', 3),
  ]).then(r => r.flat()),

  history: () => Promise.all([
    fetchWikipedia(14, 'history'),
    fetchRSS_by_topic('history', 4),
  ]).then(r => r.flat()),

  geography: () => Promise.all([
    fetchWikipedia(12, 'geography'),
    fetchRSS_by_topic('geography', 3),
  ]).then(r => r.flat()),

  economics: () => Promise.all([
    fetchGuardian('business', 'economics', 10),
    fetchArxiv('cat:econ', 'econ', 'economics', 6),
    fetchRSS_by_topic('economics', 4),
  ]).then(r => r.flat()),

  environment: () => Promise.all([
    fetchGuardian('environment', 'environment', 10),
    fetchRSS_by_topic('environment', 5),
  ]).then(r => r.flat()),

  geopolitics: () => Promise.all([
    fetchGuardian('world', 'geopolitics', 10),
    fetchRSS_by_topic('geopolitics', 5),
  ]).then(r => r.flat()),

  psychology: () => Promise.all([
    fetchPubMed('psychology cognitive neuroscience behaviour', 'psychology', 8),
    fetchArxiv('cat:q-bio.NC', 'neuroscience', 'psychology', 6),
    fetchRSS_by_topic('psychology', 3),
    fetchWikipedia(5, 'psychology'),
  ]).then(r => r.flat()),

  art: () => Promise.all([
    fetchGuardian('culture', 'art', 10),
    fetchRSS_by_topic('art', 4),
    fetchWikipedia(6, 'art'),
  ]).then(r => r.flat()),

  literature: () => Promise.all([
    fetchGuardian('books', 'literature', 10),
    fetchRSS_by_topic('literature', 4),
  ]).then(r => r.flat()),

  philosophy: () => Promise.all([
    fetchWikipedia(10, 'philosophy'),
    fetchRSS_by_topic('philosophy', 4),
  ]).then(r => r.flat()),

  news: () => fetchGuardian('', 'news', 20, 'newest'),
};

// Helper: get RSS sources for a topic and fetch them in parallel (max 3 per topic)
async function fetchRSS_by_topic(topic, maxSources = 3) {
  const sources = shuffle(RSS_SOURCES.filter(s => s.topic === topic)).slice(0, maxSources);
  const results = await Promise.allSettled(
    sources.map(s => fetchRSS(s.id, s.url, s.label, s.domain, s.topic))
  );
  return results.filter(r => r.status === 'fulfilled').flatMap(r => r.value);
}

// ─── Route: /api/feed ───────────────────────────────────────────────────────────
app.get('/api/feed', async (req, res) => {
  try {
    const category = req.query.category || 'all';
    const limit    = Math.min(parseInt(req.query.limit) || 50, 100);

    if (category === 'all') {
      // Fetch ALL categories in parallel, take up to 3 per category
      const entries = Object.entries(CATEGORY_FETCHERS);
      const results = await Promise.allSettled(
        entries.map(([, fn]) => fn().catch(() => []))
      );
      const pools = results.map((r, i) => ({
        cat:   entries[i][0],
        items: (r.status === 'fulfilled' ? r.value : []).slice(0, 3),
      }));
      // Interleave one article per category to ensure diversity
      const interleaved = [];
      for (let round = 0; round < 4; round++) {
        for (const pool of shuffle(pools)) {
          if (pool.items[round]) interleaved.push(pool.items[round]);
          if (interleaved.length >= limit) break;
        }
        if (interleaved.length >= limit) break;
      }
      const items = dedup(shuffle(interleaved)).slice(0, limit);
      res.json({ items, count: items.length, category });

    } else {
      const fn = CATEGORY_FETCHERS[category];
      if (!fn) return res.status(400).json({ error: 'Unknown: ' + category });
      const raw   = await fn().catch(() => []);
      const items = dedup(distributeBySource(raw, limit));
      res.json({ items, count: items.length, category });
    }
  } catch (e) {
    console.error('[/api/feed]', e);
    res.status(500).json({ error: 'Feed error', detail: e.message });
  }
});

// ─── Route: /api/categories ────────────────────────────────────────────────────
app.get('/api/categories', (req, res) => {
  const cats = Object.keys(CATEGORY_FETCHERS);
  res.json({ categories: cats, rss_sources: RSS_SOURCES.length });
});

// ─── Route: /health ────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  const poolStatus = {};
  Object.keys(PIXABAY_QUERIES).forEach(t => {
    poolStatus[t] = imagePool.get(t)?.length || 0;
  });
  res.json({
    status:       'ok',
    uptime:       Math.round(process.uptime()) + 's',
    cached:       cache.size,
    rss_sources:  RSS_SOURCES.length,
    categories:   Object.keys(CATEGORY_FETCHERS).length,
    pixabay_key:  PIXABAY_KEY ? 'set ✓' : 'NOT SET — add PIXABAY_KEY in Render env vars',
    image_pools:  poolStatus,
  });
});

// ─── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`Curio backend on port ${PORT}`);
  console.log(`${RSS_SOURCES.length} RSS sources · ${Object.keys(CATEGORY_FETCHERS).length} categories · Guardian key: ${GUARDIAN_KEY === 'test' ? 'test' : 'custom ✓'}`);
  // Pre-load Pixabay image pools in background (doesn't block server start)
  preloadAllPools();
});
