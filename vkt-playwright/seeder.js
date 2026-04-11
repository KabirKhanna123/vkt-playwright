const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://unypasitbzulafehbqtj.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVueXBhc2l0Ynp1bGFmZWhicXRqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUwMTE2MjAsImV4cCI6MjA5MDU4NzYyMH0.ywGB7ZccbVxcgZDXMOQB9Ui8R-SF4xF0SKkWavDbRGI';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const SKIP = [
  'hotel', 'parking', 'vip-package', 'meet-greet', 'merchandise',
  'gift-card', 'voucher', 'package-deal'
];

const MAJOR_KEYWORDS = [
  // NFL
  'patriots', 'cowboys', 'chiefs', 'packers', '49ers', 'eagles', 'giants',
  'ravens', 'steelers', 'broncos', 'bears', 'lions', 'falcons', 'saints',
  'buccaneers', 'panthers', 'cardinals', 'seahawks', 'rams', 'chargers',
  'raiders', 'dolphins', 'bills', 'jets', 'browns', 'bengals', 'colts',
  'titans', 'jaguars', 'texans', 'vikings', 'commanders',
  // MLB
  'yankees', 'dodgers', 'red-sox', 'cubs', 'mets', 'astros', 'braves',
  'phillies', 'padres', 'athletics', 'rangers', 'mariners', 'angels',
  'tigers', 'twins', 'white-sox', 'guardians', 'royals', 'pirates',
  'reds', 'rockies', 'diamondbacks', 'orioles', 'blue-jays', 'rays',
  'nationals', 'marlins', 'brewers',
  // NBA
  'lakers', 'celtics', 'warriors', 'knicks', 'bulls', 'heat', 'nets',
  '76ers', 'bucks', 'nuggets', 'suns', 'mavericks', 'clippers', 'raptors',
  'spurs', 'thunder', 'jazz', 'blazers', 'rockets', 'pelicans', 'grizzlies',
  'hawks', 'hornets', 'pacers', 'pistons', 'wizards', 'magic', 'cavaliers',
  'timberwolves', 'kings',
  // NHL
  'bruins', 'maple-leafs', 'blackhawks', 'penguins', 'capitals',
  'lightning', 'avalanche', 'golden-knights', 'oilers', 'flames', 'canucks',
  'canadiens', 'senators', 'sabres', 'red-wings', 'blues', 'predators',
  'coyotes', 'sharks', 'ducks', 'stars', 'wild', 'jets',
  'hurricanes', 'blue-jackets', 'devils', 'islanders',
  // Concerts / Events
  'taylor-swift', 'beyonce', 'drake', 'bad-bunny', 'kendrick-lamar',
  'super-bowl', 'world-series', 'nba-finals', 'stanley-cup',
  'coachella', 'lollapalooza', 'wrestlemania', 'ufc'
];

function isMajorEvent(url, name) {
  const check = (url + ' ' + (name || '')).toLowerCase();
  return MAJOR_KEYWORDS.some(k => check.includes(k));
}

function extractEventId(url) {
  const m = url.match(/\/event\/(\d{5,})/);
  return m ? m[1] : null;
}

function isEventUrl(url) {
  if (!url.includes('stubhub.com')) return false;
  if (!url.includes('/event/')) return false;
  const lower = url.toLowerCase();
  return !SKIP.some(s => lower.includes(s));
}

function nameFromUrl(url) {
  const parts = url.split('/').filter(Boolean);
  const slug = parts.find(p => p.includes('-tickets-') || (p.length > 10 && p.includes('-'))) || '';
  return slug
    .replace(/-\d{1,2}-\d{4}.*$/, '')
    .replace(/-tickets.*$/, '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim() || 'StubHub Event';
}

function dateFromUrl(url) {
  const m = url.match(/-(\d{1,2})-(\d{1,2})-(\d{4})/);
  if (m) {
    const month = m[1].padStart(2, '0');
    const day   = m[2].padStart(2, '0');
    const year  = m[3];
    if (parseInt(year) >= 2025) return `${year}-${month}-${day}`;
  }
  return null;
}

async function fetchText(url) {
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/xml,application/xml,*/*'
    }
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  return resp.text();
}

function extractUrls(xml) {
  const urls = [];
  const re = /<loc>(.*?)<\/loc>/g;
  let m;
  while ((m = re.exec(xml)) !== null) urls.push(m[1].trim());
  return urls;
}

async function main() {
  console.log('Sitemap seeder starting...');

  let allEventUrls = [];

  // Try event-level sitemaps directly
  const eventSitemapBases = [
    'https://www.stubhub.com/new-sitemap/us/US-en-event-',
    'https://www.stubhub.com/sitemap/us/en/event-',
    'https://www.stubhub.com/sitemaps/us-en-event-',
  ];

  let foundEventSitemap = false;

  for (const base of eventSitemapBases) {
    console.log(`Trying sitemap base: ${base}`);
    for (let i = 0; i <= 5; i++) {
      const url = `${base}${i}.xml`;
      try {
        const xml = await fetchText(url);
        const urls = extractUrls(xml).filter(isEventUrl);
        if (urls.length > 0) {
          console.log(`  Found ${urls.length} event URLs at ${url}`);
          allEventUrls = allEventUrls.concat(urls);
          foundEventSitemap = true;
        }
      } catch(_) {}
    }
    if (foundEventSitemap) break;
  }

  // Fallback: fetch grouping pages and extract event links from them
  if (!foundEventSitemap || allEventUrls.length === 0) {
    console.log('Event sitemaps not found, fetching from grouping pages...');

    const groupingSitemaps = [];
    for (let i = 0; i <= 4; i++) {
      groupingSitemaps.push(`https://www.stubhub.com/new-sitemap/us/US-en-grouping-${i}.xml`);
    }

    const groupingUrls = [];
    for (const s of groupingSitemaps) {
      try {
        console.log(`Fetching grouping sitemap: ${s}`);
        const xml = await fetchText(s);
        const urls = extractUrls(xml);
        if (urls.length === 0) break;
        // Only keep major groupings
        const majorGroupings = urls.filter(u => isMajorEvent(u, ''));
        console.log(`  ${urls.length} groupings, ${majorGroupings.length} major`);
        groupingUrls.push(...majorGroupings);
      } catch(e) {
        console.log(`  Failed: ${e.message}`);
        break;
      }
    }

    console.log(`Fetching event pages from ${groupingUrls.length} major groupings...`);

    for (const groupUrl of groupingUrls.slice(0, 100)) {
      try {
        const html = await fetchText(groupUrl);
        // Extract event IDs from grouping page HTML
        const eventMatches = [...html.matchAll(/\/event\/(\d{5,})\//g)];
        const ids = [...new Set(eventMatches.map(m => m[1]))];
        for (const id of ids) {
          allEventUrls.push(`https://www.stubhub.com/event/${id}/`);
        }
        if (ids.length > 0) console.log(`  ${groupUrl.split('/').slice(-2)[0]}: ${ids.length} events`);
      } catch(_) {}
    }
  }

  console.log(`Total event URLs found: ${allEventUrls.length}`);

  // Dedupe by event ID
  const seen = {};
  const unique = [];
  for (const url of allEventUrls) {
    const id = extractEventId(url);
    if (id && !seen[id]) {
      seen[id] = true;
      unique.push({ id, url });
    }
  }
  console.log(`Unique events: ${unique.length}`);

  // Batch check existing
  const existingIds = new Set();
  for (let i = 0; i < unique.length; i += 100) {
    const batch = unique.slice(i, i + 100).map(e => e.id);
    const { data } = await supabase.from('events').select('id').in('id', batch);
    if (data) data.forEach(r => existingIds.add(r.id));
  }
  console.log(`Already in DB: ${existingIds.size}`);

  const toSeed = unique.filter(e => !existingIds.has(e.id));
  console.log(`To seed: ${toSeed.length}`);

  let seeded = 0;
  let majorCount = 0;
  const insertBatch = [];

  for (const ev of toSeed) {
    const name = nameFromUrl(ev.url);
    const is_major = isMajorEvent(ev.url, name);
    if (is_major) majorCount++;

    insertBatch.push({
      id: ev.id,
      name,
      date: dateFromUrl(ev.url),
      venue: null,
      platform: 'StubHub',
      is_major,
      updated_at: new Date().toISOString()
    });

    if (insertBatch.length >= 100) {
      const { error } = await supabase.from('events').upsert(insertBatch, { onConflict: 'id' });
      if (!error) {
        seeded += insertBatch.length;
        console.log(`Seeded ${seeded} (major: ${majorCount})`);
      } else {
        console.log('Batch error:', error.message);
      }
      insertBatch.length = 0;
    }
  }

  if (insertBatch.length > 0) {
    const { error } = await supabase.from('events').upsert(insertBatch, { onConflict: 'id' });
    if (!error) seeded += insertBatch.length;
  }

  console.log(`Done: ${seeded} new events seeded, ${majorCount} marked as major`);

  // Backfill is_major on existing events
  console.log('Backfilling is_major on existing events...');
  const { data: existing } = await supabase
    .from('events')
    .select('id,name')
    .is('is_major', null)
    .limit(5000);

  if (existing && existing.length > 0) {
    const toUpdate = existing.filter(e => isMajorEvent('', e.name)).map(e => e.id);
    console.log(`Existing events to mark major: ${toUpdate.length}`);
    for (let i = 0; i < toUpdate.length; i += 100) {
      await supabase.from('events').update({ is_major: true }).in('id', toUpdate.slice(i, i + 100));
    }
    console.log('Backfill done');
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
