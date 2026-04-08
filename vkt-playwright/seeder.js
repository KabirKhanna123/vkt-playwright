const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://unypasitbzulafehbqtj.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVueXBhc2l0Ynp1bGFmZWhicXRqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUwMTE2MjAsImV4cCI6MjA5MDU4NzYyMH0.ywGB7ZccbVxcgZDXMOQB9Ui8R-SF4xF0SKkWavDbRGI';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const KEYWORDS = [
  'yankees','dodgers','red-sox','cubs','giants','astros','braves','phillies',
  'mets','white-sox','lakers','warriors','celtics','knicks','heat','bulls',
  'nets','76ers','mavericks','bucks','rangers','maple-leafs','bruins',
  'blackhawks','golden-knights','cowboys','patriots','packers','chiefs',
  'niners','49ers','taylor-swift','beyonce','morgan-wallen','bad-bunny',
  'drake','kendrick','travis-scott','post-malone','billie-eilish'
];

function extractEventId(url) {
  const m = url.match(/\/event\/(\d{5,})/);
  return m ? m[1] : null;
}

function isRelevant(url) {
  const lower = url.toLowerCase();
  if (!lower.includes('stubhub.com')) return false;
  return KEYWORDS.some(function(k) { return lower.includes(k); });
}

async function fetchXML(url) {
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
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
  console.log('Sitemap seeder starting...');

  const sitemaps = [
    'https://www.stubhub.com/new-sitemap/us/US-en-grouping-0.xml',
    'https://www.stubhub.com/new-sitemap/us/US-en-grouping-1.xml',
    'https://www.stubhub.com/new-sitemap/us/US-en-grouping-2.xml',
    'https://www.stubhub.com/new-sitemap/us/US-en-grouping-3.xml',
    'https://www.stubhub.com/new-sitemap/us/US-en-grouping-4.xml',
  ];

  let allUrls = [];
  for (const s of sitemaps) {
    try {
      console.log('Fetching: ' + s);
      const xml = await fetchXML(s);
      const urls = extractUrls(xml);
      console.log('  ' + urls.length + ' URLs found');
      allUrls = allUrls.concat(urls);
    } catch(e) {
      console.log('  Failed: ' + e.message);
    }
  }

  const relevant = allUrls.filter(isRelevant);
  console.log('Relevant URLs: ' + relevant.length);

  let seeded = 0, skipped = 0;

  for (const url of relevant) {
    const eventId = extractEventId(url);
    if (!eventId) continue;

    const { data } = await supabase.from('events').select('id').eq('id', eventId).limit(1);
    if (data && data.length > 0) { skipped++; continue; }

    const slug = url.split('/').filter(Boolean).find(function(p) { return p.includes('-tickets'); }) || '';
    const name = slug.replace(/-tickets.*$/, '').replace(/-/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); });

    const { error } = await supabase.from('events').upsert({
      id: eventId,
      name: name || 'StubHub Event',
      date: null,
      venue: null,
      platform: 'StubHub',
      updated_at: new Date().toISOString()
    }, { onConflict: 'id' });

    if (!error) {
      console.log('Seeded: ' + name + ' (' + eventId + ')');
      seeded++;
    }
  }

  console.log('Done: ' + seeded + ' seeded, ' + skipped + ' skipped');
  process.exit(0);
}

main().catch(function(e) { console.error(e); process.exit(1); });
