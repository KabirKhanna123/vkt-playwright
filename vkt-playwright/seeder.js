const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://unypasitbzulafehbqtj.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVueXBhc2l0Ynp1bGFmZWhicXRqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUwMTE2MjAsImV4cCI6MjA5MDU4NzYyMH0.ywGB7ZccbVxcgZDXMOQB9Ui8R-SF4xF0SKkWavDbRGI';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Specific StubHub grouping IDs to scrape all events from
const GROUPINGS = [
  { id: '45410', name: 'FIFA World Cup 2026', is_major: true },
  { id: '101', name: 'NFL', is_major: true },
  { id: '102', name: 'NBA', is_major: true },
  { id: '103', name: 'MLB', is_major: true },
];

// High-value search queries
const SEARCHES = [
  // FIFA World Cup 2026
  { query: 'FIFA World Cup 2026', is_major: true },
  { query: 'World Cup 2026', is_major: true },

  // NFL
  { query: 'Super Bowl 2026', is_major: true },
  { query: 'NFL playoff 2026', is_major: true },
  { query: 'NFC Championship 2026', is_major: true },
  { query: 'AFC Championship 2026', is_major: true },
  { query: 'Kansas City Chiefs 2026', is_major: true },
  { query: 'Dallas Cowboys 2026', is_major: true },
  { query: 'Philadelphia Eagles 2026', is_major: true },
  { query: 'San Francisco 49ers 2026', is_major: true },
  { query: 'Buffalo Bills 2026', is_major: true },
  { query: 'Green Bay Packers 2026', is_major: true },

  // NBA
  { query: 'NBA Finals 2026', is_major: true },
  { query: 'NBA playoff 2026', is_major: true },
  { query: 'Los Angeles Lakers 2026', is_major: true },
  { query: 'Boston Celtics 2026', is_major: true },
  { query: 'Golden State Warriors 2026', is_major: true },
  { query: 'New York Knicks 2026', is_major: true },

  // MLB
  { query: 'World Series 2026', is_major: true },
  { query: 'MLB playoff 2026', is_major: true },
  { query: 'New York Yankees 2026', is_major: true },
  { query: 'Los Angeles Dodgers 2026', is_major: true },
  { query: 'Chicago Cubs 2026', is_major: true },
  { query: 'Boston Red Sox 2026', is_major: true },
  { query: 'New York Mets 2026', is_major: true },

  // UFC
  { query: 'UFC PPV 2026', is_major: true },
  { query: 'UFC championship 2026', is_major: true },
  { query: 'UFC 314', is_major: true },
  { query: 'UFC 315', is_major: true },
  { query: 'UFC 316', is_major: true },
  { query: 'UFC 317', is_major: true },

  // Boxing
  { query: 'boxing championship 2026', is_major: true },
  { query: 'Canelo 2026', is_major: true },

  // Concerts
  { query: 'Taylor Swift 2026', is_major: true },
  { query: 'Beyonce 2026', is_major: true },
  { query: 'Drake 2026', is_major: true },
  { query: 'Bad Bunny 2026', is_major: true },
  { query: 'Kendrick Lamar 2026', is_major: true },
  { query: 'Coldplay 2026', is_major: true },
  { query: 'The Weeknd 2026', is_major: true },

  // Festivals
  { query: 'Coachella 2026', is_major: true },
  { query: 'EDC Las Vegas 2026', is_major: true },
  { query: 'Ultra Music Festival 2026', is_major: true },
  { query: 'Lollapalooza 2026', is_major: true },

  // Broadway
  { query: 'Hamilton Broadway 2026', is_major: true },
  { query: 'Lion King Broadway 2026', is_major: true },
  { query: 'Wicked Broadway 2026', is_major: true },

  // F1
  { query: 'Formula 1 2026 United States Grand Prix', is_major: true },
  { query: 'Formula 1 2026 Las Vegas Grand Prix', is_major: true },
  { query: 'Formula 1 2026 Miami Grand Prix', is_major: true },
  { query: 'F1 Grand Prix 2026', is_major: true },

  // College Football
  { query: 'College Football Playoff 2026', is_major: true },
  { query: 'CFP National Championship 2026', is_major: true },
  { query: 'Rose Bowl 2026', is_major: true },
  { query: 'Sugar Bowl 2026', is_major: true },
  { query: 'Alabama football 2026', is_major: true },
  { query: 'Ohio State football 2026', is_major: true },
  { query: 'Michigan football 2026', is_major: true },
  { query: 'Georgia football 2026', is_major: true },
];

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function extractEventIds(html) {
  const ids = new Set();
  const re = /\/event\/(\d{5,})\//g;
  let m;
  while ((m = re.exec(html)) !== null) ids.add(m[1]);
  return [...ids];
}

async function fetchPage(url) {
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    });
    if (!resp.ok) return null;
    return resp.text();
  } catch(e) {
    console.log(`  Fetch failed for ${url}: ${e.message}`);
    return null;
  }
}

async function scrapeGrouping(groupingId, label) {
  console.log(`\nScraping grouping ${groupingId} (${label})...`);
  const allIds = new Set();

  // Paginate through grouping pages
  for (let page = 1; page <= 20; page++) {
    const url = `https://www.stubhub.com/grouping/${groupingId}?page=${page}&qty=1`;
    const html = await fetchPage(url);
    if (!html) break;

    const ids = extractEventIds(html);
    if (ids.length === 0) {
      console.log(`  Page ${page}: no events, stopping`);
      break;
    }

    ids.forEach(id => allIds.add(id));
    console.log(`  Page ${page}: ${ids.length} events (total: ${allIds.size})`);
    await sleep(800 + Math.random() * 400);
  }

  return [...allIds];
}

async function searchStubHub(query) {
  const encoded = encodeURIComponent(query);
  const url = `https://www.stubhub.com/search/?q=${encoded}`;
  const html = await fetchPage(url);
  if (!html) return [];
  return extractEventIds(html);
}

async function main() {
  console.log('Targeted seeder starting...');

  // Get existing IDs
  const { data: existingData } = await supabase.from('events').select('id');
  const existingIds = new Set((existingData || []).map(r => r.id));
  console.log(`Existing events in DB: ${existingIds.size}`);

  const discovered = new Map(); // id -> is_major

  // Step 1: Scrape specific grouping pages (most reliable)
  for (const grouping of GROUPINGS) {
    const ids = await scrapeGrouping(grouping.id, grouping.name);
    console.log(`  ${grouping.name}: ${ids.length} total events`);
    for (const id of ids) {
      if (!discovered.has(id)) discovered.set(id, grouping.is_major);
    }
    await sleep(1000);
  }

  // Step 2: Search queries
  console.log('\nRunning search queries...');
  for (const search of SEARCHES) {
    console.log(`Searching: "${search.query}"`);
    const ids = await searchStubHub(search.query);
    console.log(`  Found ${ids.length} event IDs`);
    for (const id of ids) {
      if (!discovered.has(id)) discovered.set(id, search.is_major);
    }
    await sleep(1000 + Math.random() * 500);
  }

  console.log(`\nTotal unique events discovered: ${discovered.size}`);

  const toSeed = [...discovered.entries()].filter(([id]) => !existingIds.has(id));
  console.log(`New events to seed: ${toSeed.length}`);

  let seeded = 0;
  const insertBatch = [];

  for (const [eventId, is_major] of toSeed) {
    insertBatch.push({
      id: eventId,
      name: `Event ${eventId}`,
      date: null,
      venue: null,
      platform: 'StubHub',
      is_major,
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

  // Backfill is_major on existing events
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
