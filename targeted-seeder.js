const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://unypasitbzulafehbqtj.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVueXBhc2l0Ynp1bGFmZWhicXRqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUwMTE2MjAsImV4cCI6MjA5MDU4NzYyMH0.ywGB7ZccbVxcgZDXMOQB9Ui8R-SF4xF0SKkWavDbRGI';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// High-value search queries — each will be searched on StubHub
const SEARCHES = [
  // FIFA World Cup 2026
  { query: 'FIFA World Cup 2026', is_major: true, category: 'fifa' },
  { query: 'World Cup 2026 match', is_major: true, category: 'fifa' },

  // NFL
  { query: 'Super Bowl 2026', is_major: true, category: 'nfl' },
  { query: 'NFL playoff 2026', is_major: true, category: 'nfl' },
  { query: 'NFC Championship 2026', is_major: true, category: 'nfl' },
  { query: 'AFC Championship 2026', is_major: true, category: 'nfl' },
  { query: 'Kansas City Chiefs 2026', is_major: true, category: 'nfl' },
  { query: 'Dallas Cowboys 2026', is_major: true, category: 'nfl' },
  { query: 'Philadelphia Eagles 2026', is_major: true, category: 'nfl' },
  { query: 'San Francisco 49ers 2026', is_major: true, category: 'nfl' },
  { query: 'Buffalo Bills 2026', is_major: true, category: 'nfl' },
  { query: 'Green Bay Packers 2026', is_major: true, category: 'nfl' },

  // NBA
  { query: 'NBA Finals 2026', is_major: true, category: 'nba' },
  { query: 'NBA playoff 2026', is_major: true, category: 'nba' },
  { query: 'Los Angeles Lakers 2026', is_major: true, category: 'nba' },
  { query: 'Boston Celtics 2026', is_major: true, category: 'nba' },
  { query: 'Golden State Warriors 2026', is_major: true, category: 'nba' },
  { query: 'New York Knicks 2026', is_major: true, category: 'nba' },

  // MLB
  { query: 'World Series 2026', is_major: true, category: 'mlb' },
  { query: 'MLB playoff 2026', is_major: true, category: 'mlb' },
  { query: 'New York Yankees 2026', is_major: true, category: 'mlb' },
  { query: 'Los Angeles Dodgers 2026', is_major: true, category: 'mlb' },
  { query: 'Chicago Cubs 2026', is_major: true, category: 'mlb' },
  { query: 'Boston Red Sox 2026', is_major: true, category: 'mlb' },
  { query: 'New York Mets 2026', is_major: true, category: 'mlb' },

  // UFC
  { query: 'UFC 300', is_major: true, category: 'ufc' },
  { query: 'UFC 301', is_major: true, category: 'ufc' },
  { query: 'UFC 302', is_major: true, category: 'ufc' },
  { query: 'UFC 303', is_major: true, category: 'ufc' },
  { query: 'UFC PPV 2026', is_major: true, category: 'ufc' },
  { query: 'UFC championship 2026', is_major: true, category: 'ufc' },

  // Boxing
  { query: 'boxing championship 2026', is_major: true, category: 'boxing' },
  { query: 'heavyweight championship 2026', is_major: true, category: 'boxing' },
  { query: 'Canelo 2026', is_major: true, category: 'boxing' },

  // Concerts
  { query: 'Taylor Swift 2026', is_major: true, category: 'concert' },
  { query: 'Beyonce 2026', is_major: true, category: 'concert' },
  { query: 'Drake 2026', is_major: true, category: 'concert' },
  { query: 'Bad Bunny 2026', is_major: true, category: 'concert' },
  { query: 'Kendrick Lamar 2026', is_major: true, category: 'concert' },
  { query: 'Coldplay 2026', is_major: true, category: 'concert' },
  { query: 'The Weeknd 2026', is_major: true, category: 'concert' },

  // Festivals
  { query: 'Coachella 2026', is_major: true, category: 'festival' },
  { query: 'EDC Las Vegas 2026', is_major: true, category: 'festival' },
  { query: 'Ultra Music Festival 2026', is_major: true, category: 'festival' },
  { query: 'Lollapalooza 2026', is_major: true, category: 'festival' },

  // Broadway
  { query: 'Hamilton Broadway 2026', is_major: true, category: 'broadway' },
  { query: 'Lion King Broadway 2026', is_major: true, category: 'broadway' },
  { query: 'Wicked Broadway 2026', is_major: true, category: 'broadway' },

  // F1
  { query: 'Formula 1 2026 United States Grand Prix', is_major: true, category: 'f1' },
  { query: 'Formula 1 2026 Las Vegas Grand Prix', is_major: true, category: 'f1' },
  { query: 'Formula 1 2026 Miami Grand Prix', is_major: true, category: 'f1' },
  { query: 'F1 Grand Prix 2026', is_major: true, category: 'f1' },

  // College Football
  { query: 'College Football Playoff 2026', is_major: true, category: 'cfb' },
  { query: 'CFP National Championship 2026', is_major: true, category: 'cfb' },
  { query: 'Rose Bowl 2026', is_major: true, category: 'cfb' },
  { query: 'Sugar Bowl 2026', is_major: true, category: 'cfb' },
  { query: 'Alabama football 2026', is_major: true, category: 'cfb' },
  { query: 'Ohio State football 2026', is_major: true, category: 'cfb' },
  { query: 'Michigan football 2026', is_major: true, category: 'cfb' },
  { query: 'Georgia football 2026', is_major: true, category: 'cfb' },
];

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function extractEventIds(html) {
  const ids = new Set();
  // Match /event/XXXXXXX/ patterns
  const re = /\/event\/(\d{5,})\//g;
  let m;
  while ((m = re.exec(html)) !== null) ids.add(m[1]);
  return [...ids];
}

function extractEventData(html, eventId) {
  // Try to get name from og:title or title tag
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  const title = titleMatch ? titleMatch[1].replace(/ [\|\-] StubHub.*$/i, '').replace(/ Tickets.*$/i, '').trim() : null;

  // Try to get date from URL or JSON-LD
  const dateMatch = html.match(/"startDate"\s*:\s*"([^"]+)"/);
  const date = dateMatch ? dateMatch[1].split('T')[0] : null;

  // Try to get venue
  const venueMatch = html.match(/"name"\s*:\s*"([^"]+)"[^}]*"@type"\s*:\s*"Place"/) ||
                     html.match(/"@type"\s*:\s*"Place"[^}]*"name"\s*:\s*"([^"]+)"/);
  const venue = venueMatch ? venueMatch[1] : null;

  return { name: title, date, venue };
}

async function searchStubHub(query) {
  const encoded = encodeURIComponent(query);
  const url = `https://www.stubhub.com/search/?q=${encoded}`;

  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    });
    if (!resp.ok) return [];
    const html = await resp.text();
    return extractEventIds(html);
  } catch(e) {
    console.log(`  Search failed for "${query}": ${e.message}`);
    return [];
  }
}

async function fetchEventPage(eventId) {
  const url = `https://www.stubhub.com/event/${eventId}/`;
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
      }
    });
    if (!resp.ok) return null;
    return resp.text();
  } catch(_) { return null; }
}

async function main() {
  console.log('Targeted seeder starting...');

  // Get existing IDs
  const { data: existingData } = await supabase.from('events').select('id');
  const existingIds = new Set((existingData || []).map(r => r.id));
  console.log(`Existing events in DB: ${existingIds.size}`);

  const discovered = new Map(); // id -> { is_major, category }

  // Search StubHub for each query
  for (const search of SEARCHES) {
    console.log(`\nSearching: "${search.query}"`);
    const ids = await searchStubHub(search.query);
    console.log(`  Found ${ids.length} event IDs`);

    for (const id of ids) {
      if (!discovered.has(id)) {
        discovered.set(id, { is_major: search.is_major, category: search.category });
      }
    }

    await sleep(1000 + Math.random() * 500);
  }

  console.log(`\nTotal unique events discovered: ${discovered.size}`);

  const toSeed = [...discovered.entries()].filter(([id]) => !existingIds.has(id));
  console.log(`New events to seed: ${toSeed.length}`);

  let seeded = 0;
  const insertBatch = [];

  for (const [eventId, meta] of toSeed) {
    insertBatch.push({
      id: eventId,
      name: `Event ${eventId}`,
      date: null,
      venue: null,
      platform: 'StubHub',
      is_major: meta.is_major,
      updated_at: new Date().toISOString()
    });

    if (insertBatch.length >= 50) {
      const { error } = await supabase.from('events').upsert(insertBatch, { onConflict: 'id' });
      if (!error) {
        seeded += insertBatch.length;
        console.log(`Seeded ${seeded} events so far...`);
      } else {
        console.log('Batch error:', error.message);
      }
      insertBatch.length = 0;
      await sleep(500);
    }
  }

  if (insertBatch.length > 0) {
    const { error } = await supabase.from('events').upsert(insertBatch, { onConflict: 'id' });
    if (!error) seeded += insertBatch.length;
  }

  console.log(`\nDone: ${seeded} new events seeded`);

  // Also backfill is_major on existing events with null
  console.log('\nBackfilling is_major on existing events...');
  const MAJOR_TERMS = [
    'world cup', 'super bowl', 'nfl playoff', 'nba final', 'nba playoff',
    'world series', 'mlb playoff', 'ufc', 'boxing championship',
    'taylor swift', 'beyonce', 'drake', 'bad bunny', 'kendrick',
    'coachella', 'edc', 'ultra', 'lollapalooza',
    'formula 1', 'grand prix', 'college football playoff', 'cfp',
    'patriots', 'cowboys', 'chiefs', 'eagles', 'bills', 'packers',
    'lakers', 'celtics', 'warriors', 'knicks',
    'yankees', 'dodgers', 'cubs', 'red sox', 'mets',
    'bruins', 'penguins', 'blackhawks', 'maple leafs'
  ];

  const { data: nullMajor } = await supabase
    .from('events')
    .select('id,name')
    .is('is_major', null)
    .limit(5000);

  if (nullMajor && nullMajor.length > 0) {
    const toUpdate = nullMajor
      .filter(e => MAJOR_TERMS.some(t => (e.name || '').toLowerCase().includes(t)))
      .map(e => e.id);

    console.log(`Marking ${toUpdate.length} existing events as major`);
    for (let i = 0; i < toUpdate.length; i += 100) {
      await supabase.from('events').update({ is_major: true }).in('id', toUpdate.slice(i, i + 100));
    }
  }

  console.log('Done.');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
