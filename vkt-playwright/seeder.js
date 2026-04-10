const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://unypasitbzulafehbqtj.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVueXBhc2l0Ynp1bGFmZWhicXRqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUwMTE2MjAsImV4cCI6MjA5MDU4NzYyMH0.ywGB7ZccbVxcgZDXMOQB9Ui8R-SF4xF0SKkWavDbRGI';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Junk to skip
const SKIP = [
  'hotel', 'parking', 'vip-package', 'meet-greet', 'merchandise',
  'gift-card', 'voucher', 'package-deal'
];

// Major league team keywords — events matching these get is_major = true
const MAJOR_KEYWORDS = [
  // NFL
  'patriots', 'cowboys', 'chiefs', 'packers', '49ers', 'eagles', 'giants',
  'ravens', 'steelers', 'broncos', 'bears', 'lions', 'falcons', 'saints',
  'buccaneers', 'panthers', 'cardinals', 'seahawks', 'rams', 'chargers',
  'raiders', 'dolphins', 'bills', 'jets', 'browns', 'bengals', 'colts',
  'titans', 'jaguars', 'texans', 'vikings', 'commanders', 'redskins',
  // MLB
  'yankees', 'dodgers', 'red-sox', 'cubs', 'mets', 'astros', 'braves',
  'phillies', 'giants', 'cardinals', 'brewers', 'padres', 'athletics',
  'rangers', 'mariners', 'angels', 'tigers', 'twins', 'white-sox',
  'guardians', 'royals', 'pirates', 'reds', 'rockies', 'diamondbacks',
  'orioles', 'blue-jays', 'rays', 'nationals', 'marlins',
  // NBA
  'lakers', 'celtics', 'warriors', 'knicks', 'bulls', 'heat', 'nets',
  '76ers', 'bucks', 'nuggets', 'suns', 'mavericks', 'clippers', 'raptors',
  'spurs', 'thunder', 'jazz', 'blazers', 'rockets', 'pelicans', 'grizzlies',
  'hawks', 'hornets', 'pacers', 'pistons', 'wizards', 'magic', 'cavaliers',
  'timberwolves', 'kings',
  // NHL
  'bruins', 'rangers', 'maple-leafs', 'blackhawks', 'penguins', 'capitals',
  'lightning', 'avalanche', 'golden-knights', 'oilers', 'flames', 'canucks',
  'canadiens', 'senators', 'sabres', 'red-wings', 'blues', 'predators',
  'coyotes', 'sharks', 'ducks', 'kings', 'stars', 'wild', 'jets',
  'hurricanes', 'panthers', 'blue-jackets', 'devils', 'islanders',
  // High-demand concerts / events
  'taylor-swift', 'beyonce', 'drake', 'bad-bunny', 'kendrick-lamar',
  'superbowl', 'super-bowl', 'world-series', 'nba-finals', 'stanley-cup',
  'coachella', 'lollapalooza'
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
  return !SKIP.some(function(s) { return lower.includes(s); });
}

function nameFromUrl(url) {
  const parts = url.split('/').filter(Boolean);
  const slug = parts.find(function(p) {
    return p.includes('-tickets') || (p.length > 10 && p.includes('-'));
  }) || '';
  return slug
    .replace(/-\d{1,2}-\d{4}.*$/, '')
    .replace(/-tickets.*$/, '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, function(c) { return c.toUpperCase(); })
    .trim() || 'StubHub Event';
}

function dateFromUrl(url) {
  const m = url.match(/-(\d{1,2})-(\d{1,2})-(\d{4})/);
  if (m) {
    const month = m[1].padStart(2, '0');
    const day = m[2].padStart(2, '0');
    const year = m[3];
    if (parseInt(year) >= 2025) return year + '-' + month + '-' + day;
  }
  return null;
}

async function fetchXML(url) {
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
  let m;
  const re = /<loc>(.*?)<\/loc>/g;
  while ((m = re.exec(xml)) !== null) {
    urls.push(m[1].trim());
  }
  return urls;
}

async function main() {
  console.log('Sitemap seeder starting — pulling ALL major events...');

  const sitemaps = [];
  for (let i = 0; i <= 19; i++) {
    sitemaps.push('https://www.stubhub.com/new-sitemap/us/US-en-grouping-' + i + '.xml');
  }

  let allUrls = [];
  for (const s of sitemaps) {
    try {
      console.log('Fetching: ' + s);
      const xml = await fetchXML(s);
      const urls = extractUrls(xml);
      console.log('  ' + urls.length + ' URLs');
      if (urls.length === 0) {
        console.log('  No more sitemaps, stopping.');
        break;
      }
      allUrls = allUrls.concat(urls);
    } catch(e) {
      console.log('  Failed: ' + e.message);
      break;
    }
  }

  console.log('Total URLs found: ' + allUrls.length);

  const eventUrls = allUrls.filter(isEventUrl);
  console.log('Event URLs after filter: ' + eventUrls.length);

  const seen = {};
  const unique = [];
  for (const url of eventUrls) {
    const id = extractEventId(url);
    if (id && !seen[id]) {
      seen[id] = true;
      unique.push({ id, url });
    }
  }
  console.log('Unique events: ' + unique.length);

  // Batch check which IDs already exist
  const existingIds = new Set();
  const batchSize = 100;
  for (let i = 0; i < unique.length; i += batchSize) {
    const batch = unique.slice(i, i + batchSize).map(function(e) { return e.id; });
    const { data } = await supabase.from('events').select('id').in('id', batch);
    if (data) data.forEach(function(r) { existingIds.add(r.id); });
  }
  console.log('Already in DB: ' + existingIds.size);

  const toSeed = unique.filter(function(e) { return !existingIds.has(e.id); });
  console.log('To seed: ' + toSeed.length);

  let seeded = 0;
  let majorCount = 0;
  const insertBatch = [];

  for (const ev of toSeed) {
    const name = nameFromUrl(ev.url);
    const is_major = isMajorEvent(ev.url, name);
    if (is_major) majorCount++;

    insertBatch.push({
      id: ev.id,
      name: name,
      date: dateFromUrl(ev.url),
      venue: null,
      platform: 'StubHub',
      is_major: is_major,
      updated_at: new Date().toISOString()
    });

    if (insertBatch.length >= 100) {
      const { error } = await supabase.from('events').upsert(insertBatch, { onConflict: 'id' });
      if (!error) {
        seeded += insertBatch.length;
        console.log('Seeded batch of ' + insertBatch.length + ' (total: ' + seeded + ', major so far: ' + majorCount + ')');
      } else {
        console.log('Batch error: ' + error.message);
      }
      insertBatch.length = 0;
    }
  }

  if (insertBatch.length > 0) {
    const { error } = await supabase.from('events').upsert(insertBatch, { onConflict: 'id' });
    if (!error) {
      seeded += insertBatch.length;
      console.log('Seeded final batch of ' + insertBatch.length);
    }
  }

  console.log('Done: ' + seeded + ' new events seeded, ' + majorCount + ' marked as major');

  // Also backfill is_major on existing events that match keywords
  console.log('Backfilling is_major on existing events...');
  const { data: existing } = await supabase
    .from('events')
    .select('id,name')
    .is('is_major', null)
    .limit(5000);

  if (existing && existing.length > 0) {
    const toUpdate = existing.filter(e => isMajorEvent('', e.name)).map(e => e.id);
    console.log('Existing events to mark as major: ' + toUpdate.length);
    for (let i = 0; i < toUpdate.length; i += 100) {
      const batch = toUpdate.slice(i, i + 100);
      await supabase.from('events').update({ is_major: true }).in('id', batch);
    }
    console.log('Backfill done');
  }

  process.exit(0);
}

main().catch(function(e) { console.error(e); process.exit(1); });
