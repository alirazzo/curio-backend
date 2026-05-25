'use strict';

const express   = require('express');
const RSSParser = require('rss-parser');
const cors      = require('cors');
const app       = express();

// ─── Keys ─────────────────────────────────────────────────────────────────────
const NASA_KEY    = process.env.NASA_KEY    || 'DEMO_KEY';
const PIXABAY_KEY = process.env.PIXABAY_KEY || '';

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

// ─── Cache ─────────────────────────────────────────────────────────────────────
const cache = new Map();
function getCached(key, ttl = 20 * 60 * 1000) {
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
const imagePool = new Map();

const PIXABAY_QUERIES = {
  'life-sciences-pharma': 'biology cell microscope dna genetics pharmaceutical laboratory',
  'medicine':             'medical doctor hospital healthcare research',
  'ai-tech':              'artificial intelligence technology computer circuit',
  'physical-sciences': 'physics chemistry laboratory molecules science',
  'space':             'galaxy nebula cosmos stars astronomy',
  'earth':             'earth landscape environment nature aerial',
  'society-economics': 'city society people economics global',
  'history':           'ancient history ruins civilization archaeology',
  'arts-culture':      'art museum painting books culture library',
};

async function loadPixabayPool(topic, query) {
  if (!PIXABAY_KEY) return;
  try {
    const r = await fetch(
      `https://pixabay.com/api/?key=${PIXABAY_KEY}&q=${encodeURIComponent(query)}&image_type=photo&orientation=horizontal&per_page=100&safesearch=true&min_width=640`,
      { signal: AbortSignal.timeout(10000) }
    );
    const data = await r.json();
    const urls = (data.hits || []).map(h => h.webformatURL).filter(Boolean);
    if (urls.length) imagePool.set(topic, urls);
    console.log(`[pixabay] ${topic}: ${urls.length} images`);
  } catch (e) { console.warn(`[pixabay] ${topic}:`, e.message); }
}

function pickImage(topic) {
  const pool = imagePool.get(topic) || imagePool.get('physical-sciences') || [];
  return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
}

async function preloadAllPools() {
  if (!PIXABAY_KEY) {
    console.log('[pixabay] No key — set PIXABAY_KEY in Render env vars for images');
    return;
  }
  const entries = Object.entries(PIXABAY_QUERIES);
  for (let i = 0; i < entries.length; i += 4) {
    await Promise.all(entries.slice(i, i + 4).map(([t, q]) => loadPixabayPool(t, q)));
    if (i + 4 < entries.length) await new Promise(r => setTimeout(r, 1200));
  }
  console.log('[pixabay] All pools ready');
}
setInterval(preloadAllPools, 24 * 60 * 60 * 1000);

// ─── Utilities ─────────────────────────────────────────────────────────────────
function strip(html) {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#\d+;/g, '')
    .replace(/\s+/g, ' ').trim();
}
function readTime(t) {
  return Math.max(1, Math.round((t || '').trim().split(/\s+/).length / 200)) + ' min';
}
function shuffle(a) {
  const b = a.slice();
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}
function dedup(items) {
  const s = new Set();
  return items.filter(c => { if (s.has(c.url)) return false; s.add(c.url); return true; });
}

// One year ago timestamp for filtering recent content
function oneYearAgo() {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  return d;
}

function isRecent(dateStr) {
  if (!dateStr) return true; // assume recent if no date
  try {
    return new Date(dateStr) >= oneYearAgo();
  } catch { return true; }
}

// Ensure image fallback
function withImage(item) {
  if (!item.image) item.image = pickImage(item.topic);
  return item;
}

// Hard cap: max 2 articles per source domain in any final result set
function distributeBySource(items, limit) {
  const bySource = {};
  items.forEach(item => {
    const key = item.source || 'unknown';
    if (!bySource[key]) bySource[key] = [];
    bySource[key].push(item);
  });

  // Shuffle within each source group
  Object.values(bySource).forEach(arr => arr.sort(() => Math.random() - 0.5));

  // Round-robin: one article per source at a time, max 2 rounds
  const groups = shuffle(Object.values(bySource));
  const result = [];

  for (let round = 0; round < 2; round++) {
    for (const arr of groups) {
      if (arr[round]) {
        result.push(arr[round]);
        if (result.length >= limit) return shuffle(result);
      }
    }
  }
  return shuffle(result);
}

// Apply source cap as a standalone filter (used as final pass)
function capBySource(items, maxPerSource = 2) {
  const counts = {};
  return items.filter(item => {
    const key = item.source || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
    return counts[key] <= maxPerSource;
  });
}

// ─── RSS Image Extraction ───────────────────────────────────────────────────────
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
async function fetchRSS(id, url, label, domain, topic, lang = 'en') {
  const cached = getCached('rss_' + id, 30 * 60 * 1000);
  if (cached) return cached;
  try {
    const feed  = await parser.parseURL(url);
    const cutoff = oneYearAgo();
    const items = (feed.items || [])
      .filter(item => {
        if (!item.title || !item.link) return false;
        if (item.pubDate || item.isoDate) {
          try { return new Date(item.pubDate || item.isoDate) >= cutoff; } catch {}
        }
        return true;
      })
      .slice(0, 15)
      .map(item => {
        const text = strip(item.contentEncoded || item.content || item.contentSnippet || '');
        const img  = extractRSSImage(item);
        return {
          id:          id + '_' + Buffer.from((item.link || item.title).slice(-24)).toString('base64').replace(/\W/g, '').slice(0, 12),
          source:      domain,
          sourceLabel: label,
          verified:    true,
          title:       item.title.trim(),
          excerpt:     text.slice(0, 240) + (text.length > 240 ? '…' : ''),
          image:       img,
          url:         item.link,
          topic,
          lang,
          readTime:    readTime(text),
          type:        'learn',
          pubDate:     item.isoDate || item.pubDate || null,
        };
      })
      .map(withImage);
    setCache('rss_' + id, items);
    return items;
  } catch (e) {
    console.warn('[rss]', label, e.message);
    return [];
  }
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
    const cutoff = oneYearAgo();
    const items  = data
      .filter(d => d.media_type === 'image' && d.url)
      .filter(d => !d.date || new Date(d.date) >= cutoff)
      .map(d => ({
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
        pubDate:     d.date,
      }));
    setCache('nasa', items);
    return items;
  } catch (e) { console.warn('[nasa]', e.message); return []; }
}

// ─── PubMed / NCBI E-utilities ─────────────────────────────────────────────────
// Free, no key needed, designed for programmatic access, returns last-12-months by default
async function fetchPubMed(query, topic, retmax = 10) {
  const key    = `pubmed_${topic}_${Math.floor(Date.now() / (30 * 60 * 1000))}`;
  const cached = getCached(key, 30 * 60 * 1000);
  if (cached) return cached;
  try {
    // mindate = 1 year ago enforces the 85% recent rule
    const mindate = oneYearAgo().toISOString().slice(0, 10).replace(/-/g, '/');
    const maxdate = new Date().toISOString().slice(0, 10).replace(/-/g, '/');
    const searchR = await fetch(
      `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmax=${retmax}&sort=date&mindate=${mindate}&maxdate=${maxdate}&datetype=pdat&format=json&tool=curio&email=curio@curio.app`,
      { signal: AbortSignal.timeout(8000) }
    );
    const searchData = await searchR.json();
    const ids = (searchData.esearchresult?.idlist || []).join(',');
    if (!ids) return [];

    const summaryR = await fetch(
      `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${ids}&format=json&tool=curio&email=curio@curio.app`,
      { signal: AbortSignal.timeout(8000) }
    );
    const summaryData = await summaryR.json();
    const uids  = summaryData.result?.uids || [];
    const items = uids.map(uid => {
      const rec = summaryData.result[uid];
      if (!rec || !rec.title) return null;
      const authors = (rec.authors || []).slice(0, 3).map(a => a.name).join(', ');
      const journal = rec.fulljournalname || rec.source || '';
      return {
        id:          'pubmed_' + uid,
        source:      'pubmed.ncbi.nlm.nih.gov',
        sourceLabel: journal.length > 35 ? journal.slice(0, 35) + '…' : (journal || 'PubMed'),
        verified:    true,
        title:       strip(rec.title),
        excerpt:     (authors ? authors + ' · ' : '') + journal + (rec.pubdate ? ' · ' + rec.pubdate.slice(0, 4) : ''),
        image:       pickImage(topic),
        url:         'https://pubmed.ncbi.nlm.nih.gov/' + uid + '/',
        topic,
        readTime:    '6 min',
        type:        'learn',
        pubDate:     rec.pubdate || null,
      };
    }).filter(Boolean);
    setCache(key, items);
    return items;
  } catch (e) { console.warn('[pubmed]', topic, e.message); return []; }
}

// ─── Government RSS (always open — no Cloudflare on .gov / .int) ───────────────
async function fetchGovRSS(id, url, label, domain, topic) {
  return fetchRSS(id, url, label, domain, topic);
}

// ─── Confirmed working RSS (non-Cloudflare) ────────────────────────────────────
const RSS_CONFIRMED = [
  // AI/Tech — Substack never blocks servers
  { id:'import_ai',     url:'https://importai.substack.com/feed',             label:'Import AI',           domain:'importai.substack.com',  topic:'ai-tech', lang:'en' },
  { id:'ahead_ai',      url:'https://magazine.sebastianraschka.com/feed',     label:'Ahead of AI',         domain:'sebastianraschka.com',   topic:'ai-tech', lang:'en' },
  { id:'bair',          url:'https://bair.berkeley.edu/blog/feed.xml',        label:'BAIR (Berkeley)',     domain:'bair.berkeley.edu',      topic:'ai-tech', lang:'en' },
  { id:'gradient',      url:'https://thegradient.pub/rss/',                   label:'The Gradient',        domain:'thegradient.pub',        topic:'ai-tech', lang:'en' },
  { id:'interconnects', url:'https://www.interconnects.ai/feed',              label:'Interconnects',       domain:'interconnects.ai',       topic:'ai-tech', lang:'en' },
  { id:'last_week_ai',  url:'https://lastweekin.ai/feed',                     label:'Last Week in AI',     domain:'lastweekin.ai',          topic:'ai-tech', lang:'en' },
  { id:'mit_news',      url:'https://news.mit.edu/rss/research',              label:'MIT News',            domain:'news.mit.edu',           topic:'ai-tech', lang:'en' },
  { id:'stanford_news', url:'https://news.stanford.edu/feed/',                label:'Stanford News',       domain:'news.stanford.edu',      topic:'physical-sciences', lang:'en' },
  // Science
  { id:'quanta',        url:'https://api.quantamagazine.org/feed/',           label:'Quanta Magazine',     domain:'quantamagazine.org',     topic:'physical-sciences', lang:'en' },
  { id:'eurekalert',    url:'https://www.eurekalert.org/rss/',                label:'EurekAlert (AAAS)',   domain:'eurekalert.org',         topic:'physical-sciences', lang:'en' },
  { id:'futurity',      url:'https://www.futurity.org/feed/',                 label:'Futurity',            domain:'futurity.org',           topic:'physical-sciences', lang:'en' },
  { id:'conversation_sci', url:'https://theconversation.com/science/rss.xml', label:'The Conversation',   domain:'theconversation.com',    topic:'physical-sciences', lang:'en' },
  // Chemistry
  { id:'chem_world',    url:'https://www.chemistryworld.com/feeds/news',      label:'Chemistry World',     domain:'chemistryworld.com',     topic:'physical-sciences', lang:'en' },
  // Space
  { id:'eso',           url:'https://www.eso.org/public/news/rss/',           label:'ESO',                 domain:'eso.org',                topic:'space', lang:'en' },
  { id:'planetary',     url:'https://www.planetary.org/feed',                 label:'Planetary Society',  domain:'planetary.org',          topic:'space', lang:'en' },
  { id:'space_com',     url:'https://www.space.com/feeds/all',                label:'Space.com',           domain:'space.com',              topic:'space', lang:'en' },
  // Earth & Environment — .gov never blocks
  { id:'noaa',          url:'https://www.noaa.gov/news-release/rss.xml',      label:'NOAA',                domain:'noaa.gov',               topic:'earth', lang:'en' },
  { id:'usgs',          url:'https://www.usgs.gov/news/technical-announcement/rss.xml', label:'USGS',     domain:'usgs.gov',               topic:'earth', lang:'en' },
  { id:'carbonbrief',   url:'https://www.carbonbrief.org/feed',               label:'Carbon Brief',        domain:'carbonbrief.org',        topic:'earth', lang:'en' },
  { id:'mongabay',      url:'https://news.mongabay.com/feed/',                label:'Mongabay',            domain:'mongabay.com',           topic:'earth', lang:'en' },
  { id:'inside_climate',url:'https://insideclimatenews.org/feed/',            label:'Inside Climate News', domain:'insideclimatenews.org',  topic:'earth', lang:'en' },
  // Pharma — .gov never blocks
  { id:'fda',           url:'https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/press-releases/rss.xml', label:'FDA',  domain:'fda.gov', topic:'life-sciences-pharma', lang:'en' },
  { id:'nih',           url:'https://www.nih.gov/research-training/research-matters/rss', label:'NIH',    domain:'nih.gov',                topic:'medicine', lang:'en' },
  { id:'who',           url:'https://www.who.int/rss-feeds/news-english.xml', label:'WHO',                 domain:'who.int',                topic:'medicine', lang:'en' },
  { id:'fiercepharma',  url:'https://www.fiercepharma.com/rss/xml',           label:'FiercePharma',        domain:'fiercepharma.com',       topic:'life-sciences-pharma', lang:'en' },
  // Society & Geopolitics
  { id:'warontherocks', url:'https://warontherocks.com/feed/',                label:'War on the Rocks',    domain:'warontherocks.com',      topic:'society-economics', lang:'en' },
  { id:'crisis_group',  url:'https://www.crisisgroup.org/rss.xml',            label:'Crisis Group',        domain:'crisisgroup.org',        topic:'society-economics', lang:'en' },
  { id:'lawfare',       url:'https://www.lawfaremedia.org/feed',              label:'Lawfare',             domain:'lawfaremedia.org',       topic:'society-economics', lang:'en' },
  { id:'cfr',           url:'https://www.cfr.org/rss.xml',                    label:'CFR',                 domain:'cfr.org',                topic:'society-economics', lang:'en' },
  { id:'bruegel',       url:'https://www.bruegel.org/feed',                   label:'Bruegel',             domain:'bruegel.org',            topic:'society-economics', lang:'en' },
  { id:'voxeu',         url:'https://voxeu.org/feed',                         label:'VoxEU',               domain:'voxeu.org',              topic:'society-economics', lang:'en' },
  { id:'imf_blog',      url:'https://www.imf.org/en/Blogs/rss',               label:'IMF Blog',            domain:'imf.org',                topic:'society-economics', lang:'en' },
  { id:'bps',           url:'https://digest.bps.org.uk/feed/',                label:'BPS Research Digest', domain:'bps.org.uk',             topic:'society-economics', lang:'en' },
  { id:'neuro_news',    url:'https://neurosciencenews.com/feed/',             label:'Neuroscience News',   domain:'neurosciencenews.com',   topic:'society-economics', lang:'en' },
  // History & Arts — small sites, no Cloudflare
  { id:'smithsonian_h', url:'https://www.smithsonianmag.com/rss/history-archaeology/', label:'Smithsonian History', domain:'smithsonianmag.com', topic:'history', lang:'en' },
  { id:'archaeology',   url:'https://www.archaeology.org/feed',               label:'Archaeology Magazine',domain:'archaeology.org',        topic:'history', lang:'en' },
  { id:'history_today', url:'https://www.historytoday.com/feed/',             label:'History Today',       domain:'historytoday.com',       topic:'history', lang:'en' },
  { id:'atlas_obscura', url:'https://www.atlasobscura.com/feeds/latest',      label:'Atlas Obscura',       domain:'atlasobscura.com',       topic:'history', lang:'en' },
  { id:'marginalian',   url:'https://www.themarginalian.org/feed/',           label:'The Marginalian',       domain:'themarginalian.org',     topic:'arts-culture', lang:'en' },
  { id:'nautilus',      url:'https://nautil.us/feed/',                         label:'Nautilus',              domain:'nautil.us',              topic:'physical-sciences', lang:'en' },
  { id:'works_progress',url:'https://worksinprogress.co/feed/',               label:'Works in Progress',     domain:'worksinprogress.co',     topic:'society-economics', lang:'en' },
  { id:'psyche',        url:'https://psyche.co/feed',                          label:'Psyche',                domain:'psyche.co',              topic:'society-economics', lang:'en' },
  { id:'astral_codex',  url:'https://astralcodexten.substack.com/feed',       label:'Astral Codex Ten',      domain:'astralcodexten.substack.com', topic:'society-economics', lang:'en' },
  { id:'ribbonfarm',    url:'https://www.ribbonfarm.com/feed/',                label:'Ribbonfarm',            domain:'ribbonfarm.com',         topic:'society-economics', lang:'en' },
  { id:'lapham',        url:'https://www.laphamsquarterly.org/rss.xml',       label:"Lapham's Quarterly",    domain:'laphamsquarterly.org',   topic:'history', lang:'en' },
  { id:'american_scholar', url:'https://theamericanscholar.org/feed/',        label:'The American Scholar',  domain:'theamericanscholar.org', topic:'arts-culture', lang:'en' },
  { id:'emergence',     url:'https://emergencemagazine.org/feed/',            label:'Emergence Magazine',    domain:'emergencemagazine.org',  topic:'earth', lang:'en' },
  { id:'palladium',     url:'https://palladiummag.com/feed/',                 label:'Palladium Magazine',    domain:'palladiummag.com',       topic:'society-economics', lang:'en' },
  { id:'public_books',  url:'https://www.publicbooks.org/feed/',              label:'Public Books',          domain:'publicbooks.org',        topic:'arts-culture', lang:'en' },
  { id:'the_point',     url:'https://thepointmag.com/feed/',                  label:'The Point Magazine',    domain:'thepointmag.com',        topic:'arts-culture', lang:'en' },
  { id:'lithub',        url:'https://lithub.com/feed/',                       label:'Literary Hub',        domain:'lithub.com',             topic:'arts-culture', lang:'en' },
  { id:'paris_review',  url:'https://www.theparisreview.org/feed/',           label:'Paris Review',        domain:'theparisreview.org',     topic:'arts-culture', lang:'en' },
  { id:'aeon',          url:'https://aeon.co/feed.rss',                       label:'Aeon',                domain:'aeon.co',                topic:'arts-culture', lang:'en' },
  { id:'iai',           url:'https://iai.tv/rss',                             label:'IAI News',            domain:'iai.tv',                 topic:'arts-culture', lang:'en' },
  { id:'conversation_arts', url:'https://theconversation.com/arts/rss.xml',  label:'The Conversation Arts', domain:'theconversation.com',  topic:'arts-culture', lang:'en' },
  // Unbiased analysis — institutional, academic, data-driven
  { id:'pew',           url:'https://www.pewresearch.org/feed/',                    label:'Pew Research Center',   domain:'pewresearch.org',        topic:'society-economics', lang:'en' },
  { id:'carnegie',      url:'https://carnegieendowment.org/rss/solr/pubs/?lang=en', label:'Carnegie Endowment',    domain:'carnegieendowment.org',  topic:'society-economics', lang:'en' },
  { id:'chatham',       url:'https://www.chathamhouse.org/feeds/all',               label:'Chatham House',         domain:'chathamhouse.org',       topic:'society-economics', lang:'en' },
  { id:'wilson_ctr',    url:'https://www.wilsoncenter.org/rss.xml',                 label:'Wilson Center',         domain:'wilsoncenter.org',       topic:'society-economics', lang:'en' },
  { id:'sipri',         url:'https://www.sipri.org/rss.xml',                        label:'SIPRI',                 domain:'sipri.org',              topic:'society-economics', lang:'en' },
  { id:'rand',          url:'https://www.rand.org/pubs/rss/latest.xml',             label:'RAND Corporation',      domain:'rand.org',               topic:'society-economics', lang:'en' },
  { id:'knowable',      url:'https://knowablemagazine.org/feed',                    label:'Knowable Magazine',     domain:'knowablemagazine.org',   topic:'physical-sciences', lang:'en' },
  { id:'jstor_daily',   url:'https://daily.jstor.org/feed/',                        label:'JSTOR Daily',           domain:'daily.jstor.org',        topic:'history', lang:'en' },
  { id:'yale_e360',     url:'https://e360.yale.edu/feed',                           label:'Yale Environment 360',  domain:'e360.yale.edu',          topic:'earth', lang:'en' },
  { id:'acm_tech',      url:'https://technews.acm.org/rss.xml',                     label:'ACM TechNews',          domain:'technews.acm.org',       topic:'ai-tech', lang:'en' },
  { id:'ieee_spectrum', url:'https://spectrum.ieee.org/feeds/feed.rss',             label:'IEEE Spectrum',         domain:'spectrum.ieee.org',      topic:'ai-tech', lang:'en' },
  { id:'pub_seminar',   url:'https://publicseminar.org/feed/',                      label:'Public Seminar',        domain:'publicseminar.org',      topic:'arts-culture', lang:'en' },
  { id:'plough',        url:'https://www.plough.com/en/feed',                       label:'Plough Quarterly',      domain:'plough.com',             topic:'arts-culture', lang:'en' },

  // ── FRENCH SOURCES ──────────────────────────────────────────────────────
  { id:'fr_monde_dip',   url:'https://www.monde-diplomatique.fr/recents.atom',             label:'Le Monde Diplomatique', domain:'monde-diplomatique.fr',   topic:'society-economics',  lang:'fr' },
  { id:'fr_ifri',        url:'https://www.ifri.org/fr/rss.xml',                            label:'IFRI',                  domain:'ifri.org',                topic:'society-economics',  lang:'fr' },
  { id:'fr_orient_xxi',  url:'https://orientxxi.info/spip.php?page=backend',               label:'Orient XXI',            domain:'orientxxi.info',          topic:'society-economics',  lang:'fr' },
  { id:'fr_the_conv',    url:'https://theconversation.com/fr/articles.atom',               label:'The Conversation FR',   domain:'theconversation.com',     topic:'physical-sciences',  lang:'fr' },
  { id:'fr_slate',       url:'https://www.slate.fr/rss.xml',                               label:'Slate.fr',              domain:'slate.fr',                topic:'society-economics',  lang:'fr' },
  { id:'fr_aoc',         url:'https://aoc.media/feed',                                     label:'AOC Media',             domain:'aoc.media',               topic:'arts-culture',       lang:'fr' },
  { id:'fr_sci_hum',     url:'https://www.scienceshumaines.com/rss/actualites.xml',        label:'Sciences Humaines',     domain:'scienceshumaines.com',    topic:'society-economics',  lang:'fr' },
  { id:'fr_courrier',    url:'https://www.courrierinternational.com/feed/all/rss.xml',      label:'Courrier International',domain:'courrierinternational.com',topic:'society-economics', lang:'fr' },
  { id:'fr_esprit',      url:'https://esprit.presse.fr/feed',                              label:'Esprit Magazine',       domain:'esprit.presse.fr',        topic:'arts-culture',       lang:'fr' },
  { id:'fr_alternatives',url:'https://www.alternatives-economiques.fr/feed',               label:'Alternatives Économiques', domain:'alternatives-economiques.fr', topic:'society-economics', lang:'fr' },
  // ── ARABIC SOURCES ──────────────────────────────────────────────────────
  { id:'ar_raseef',      url:'https://raseef22.net/feed/',                                 label:'رصيف 22',               domain:'raseef22.net',            topic:'society-economics',  lang:'ar' },
  { id:'ar_mada',        url:'https://www.madamasr.com/ar/feed/',                          label:'مدى مصر',               domain:'madamasr.com',            topic:'society-economics',  lang:'ar' },
  { id:'ar_daraj',       url:'https://daraj.com/feed/',                                    label:'درج',                   domain:'daraj.com',               topic:'society-economics',  lang:'ar' },
  { id:'ar_reform',      url:'https://www.arab-reform.net/ar/feed/',                       label:'مبادرة الإصلاح العربي', domain:'arab-reform.net',         topic:'society-economics',  lang:'ar' },
  { id:'ar_assafir',     url:'https://assafirarabi.com/ar/feed/',                          label:'السفير العربي',         domain:'assafirarabi.com',        topic:'arts-culture',       lang:'ar' },
  { id:'ar_jumhuriya',   url:'https://aljumhuriya.net/ar/feed',                            label:'الجمهورية',             domain:'aljumhuriya.net',         topic:'arts-culture',       lang:'ar' },
  { id:'ar_jadaliyya',   url:'https://www.jadaliyya.com/api/RSS',                          label:'جدلية',                 domain:'jadaliyya.com',           topic:'history',            lang:'ar' },
  { id:'ar_7iber',       url:'https://www.7iber.com/feed/',                                label:'حبر',                   domain:'7iber.com',               topic:'society-economics',  lang:'ar' },
];

async function fetchRSSByTopic(topic, maxSources = 4, lang = 'all') {
  let sources = RSS_CONFIRMED.filter(s => s.topic === topic);
  if (lang !== 'all') sources = sources.filter(s => (s.lang || 'en') === lang);
  sources = shuffle(sources).slice(0, maxSources);
  const results = await Promise.allSettled(sources.map(s => fetchRSS(s.id, s.url, s.label, s.domain, s.topic, s.lang || 'en')));
  return results.filter(r => r.status === 'fulfilled').flatMap(r => r.value);
}

// ─────────────────────────────────────────────────────────────────────────────
//  85% RECENT (APIs + RSS, last 12 months) / 15% TIMELESS (evergreen RSS)
//  Applied uniformly to ALL categories
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORY_FETCHERS = {

    'life-sciences-pharma': async () => {
    const items = await Promise.all([
        fetchPubMed('biology genetics evolution ecology cell molecular microbiology drug discovery pharmaceutical clinical trial', 'life-sciences-pharma', 14),
        fetchRSSByTopic('life-sciences-pharma', 5),
    ]).then(r => r.flat());
    return items;
  },

  'medicine': async () => {
    const items = await Promise.all([
        fetchPubMed('clinical medicine treatment patient outcomes health', 'medicine', 10),
        fetchRSSByTopic('medicine', 4),
      ]).then(r => r.flat());
    return items;
  },

  'ai-tech': async () => {
    const items = await Promise.all([

        fetchRSSByTopic('ai-tech', 5),
      ]).then(r => r.flat());
    return items;
  },

  'physical-sciences': async () => {
    const items = await Promise.all([

        fetchPubMed('chemistry physics materials science nanomaterials', 'physical-sciences', 6),
        fetchRSSByTopic('physical-sciences', 4),
      ]).then(r => r.flat());
    return items;
  },

  'space': async () => {
    const items = await Promise.all([
        fetchNASA(12),
        fetchRSSByTopic('space', 4),
      ]).then(r => r.flat());
    return items;
  },

  'earth': async () => {
    const items = await Promise.all([
        fetchPubMed('climate change environment ecology biodiversity conservation', 'earth', 8),
        fetchRSSByTopic('earth', 5),
      ]).then(r => r.flat());
    return items;
  },

  'society-economics': async () => {
    const items = await Promise.all([
        fetchPubMed('psychology cognitive neuroscience social behaviour economics', 'society-economics', 8),
        fetchRSSByTopic('society-economics', 6),
      ]).then(r => r.flat());
    return items;
  },

  'history': async () => {
    const items = await Promise.all([
      fetchPubMed('archaeology history ancient civilization historical', 'history', 6),
      fetchRSSByTopic('history', 5),
    ]).then(r => r.flat());
    return items;
  },

  'arts-culture': async () => {
    const items = await Promise.all([
        fetchPubMed('art literature culture humanities philosophy aesthetics', 'arts-culture', 6),
        fetchRSSByTopic('arts-culture', 6),
      ]).then(r => r.flat());
    return items;
  },
};

// ─── /api/feed ──────────────────────────────────────────────────────────────────
app.get('/api/feed', async (req, res) => {
  try {
    const category = req.query.category || 'all';
    const lang     = req.query.lang     || 'all';
    const limit    = Math.min(parseInt(req.query.limit) || 30, 60);

    // Non-English: only pull matching language RSS sources
    if (lang !== 'all' && lang !== 'en') {
      const sources = RSS_CONFIRMED.filter(s =>
        (s.lang || 'en') === lang &&
        (category === 'all' || s.topic === category)
      );
      const results = await Promise.allSettled(
        shuffle(sources).slice(0, 20).map(s => fetchRSS(s.id, s.url, s.label, s.domain, s.topic, s.lang || 'en'))
      );
      const all   = results.filter(r => r.status === 'fulfilled').flatMap(r => r.value);
      const items = shuffle(capBySource(dedup(all), 1)).slice(0, limit);
      return res.json({ items, count: items.length, category, lang });
    }

    // English or all: full category fetchers
    if (category === 'all') {
      const entries = Object.entries(CATEGORY_FETCHERS);
      const results = await Promise.allSettled(entries.map(([, fn]) => fn().catch(() => [])));
      const pools   = results.map((r, i) => ({
        cat:   entries[i][0],
        items: shuffle(r.status === 'fulfilled' ? r.value : []).slice(0, 5),
      }));
      const interleaved = [];
      for (let round = 0; round < 6 && interleaved.length < limit * 2; round++) {
        for (const pool of shuffle(pools)) {
          if (pool.items[round]) interleaved.push(pool.items[round]);
        }
      }
      const items = shuffle(capBySource(dedup(shuffle(interleaved)), 1)).slice(0, limit);
      res.json({ items, count: items.length, category, lang });
    } else {
      const fn = CATEGORY_FETCHERS[category];
      if (!fn) return res.status(400).json({ error: 'Unknown: ' + category });
      const raw   = await fn().catch(() => []);
      const items = distributeBySource(capBySource(dedup(shuffle(raw)), 1), limit);
      res.json({ items, count: items.length, category, lang });
    }
  } catch (e) {
    console.error('[/api/feed]', e);
    res.status(500).json({ error: 'Feed error', detail: e.message });
  }
});

// ─── /health ───────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  const pools = {};
  Object.keys(PIXABAY_QUERIES).forEach(t => pools[t] = imagePool.get(t)?.length || 0);
  res.json({
    status:      'ok',
    uptime:      Math.round(process.uptime()) + 's',
    cached:      cache.size,
    rss:         RSS_CONFIRMED.length,
    categories:  Object.keys(CATEGORY_FETCHERS).length,
    pixabay:     PIXABAY_KEY ? 'set ✓' : 'NOT SET — add PIXABAY_KEY in Render env vars',
    image_pools: pools,
  });
});

// ─── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`Curio on port ${PORT} — ${RSS_CONFIRMED.length} RSS sources · ${Object.keys(CATEGORY_FETCHERS).length} categories`);
  preloadAllPools();
});
