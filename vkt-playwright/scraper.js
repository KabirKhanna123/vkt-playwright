const { createClient } = require('@supabase/supabase-js');

console.log('🚀 SCRAPER FILE LOADED');

// ===== ENV =====
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const VKT_API = process.env.VKT_API;
const DECODO_TOKEN = process.env.DECODO_TOKEN;

if (!SUPABASE_URL || !SUPABASE_KEY || !VKT_API || !DECODO_TOKEN) {
  throw new Error('❌ Missing required environment variables');
}

const SCRAPE_DELAY_MS = 4000;
const RECENT_HOURS = 20;
const EVENT_LIMIT = 200;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ===== HELPERS =====
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function summarizePrices(prices) {
  const valid = prices.filter(p => p > 0 && p < 25000).sort((a,b)=>a-b);
  if (!valid.length) return { floor:null, avg:null, ceiling:null };

  return {
    floor: Math.round(valid[0]),
    avg: Math.round(valid.reduce((a,b)=>a+b,0)/valid.length),
    ceiling: Math.round(valid[valid.length-1])
  };
}

// ===== FETCH EVENTS =====
async function getEvents() {
  const { data, error } = await supabase
    .from('events')
    .select('id,name,date,venue')
    .limit(EVENT_LIMIT);

  if (error) {
    console.error('❌ Failed to fetch events:', error.message);
    return [];
  }
  return data || [];
}

// ===== SCRAPED RECENTLY =====
async function scrapedRecently(eventId) {
  const since = new Date(Date.now() - RECENT_HOURS * 3600000).toISOString();

  const { data } = await supabase
    .from('volume_snapshots')
    .select('id')
    .eq('event_id', eventId)
    .gte('scraped_at', since)
    .limit(1);

  return !!(data && data.length);
}

// ===== POST SNAPSHOT =====
async function postSnapshot(payload) {
  try {
    const r = await fetch(`${VKT_API}/api/snapshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!r.ok) {
      console.error('❌ Snapshot failed:', await r.text());
      return false;
    }

    return true;
  } catch (e) {
    console.error('❌ Snapshot error:', e.message);
    return false;
  }
}

// ===== DECODO FETCH =====
async function fetchHTML(url) {
  try {
    console.log('🌐 Fetching:', url);

    const res = await fetch('https://scraper-api.decodo.com/v2/scrape', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + DECODO_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        url,
        proxy_pool: 'premium',
        headless: 'chrome',
        render: true,
        wait: 8000
      })
    });

    if (!res.ok) {
      console.error('❌ Decodo error:', res.status);
      return null;
    }

    const data = await res.json();
    const html = data?.results?.[0]?.content;

    console.log('📄 HTML length:', html?.length || 0);

    return html;
  } catch (e) {
    console.error('❌ Fetch error:', e.message);
    return null;
  }
}

// ===== EXTRACT DATA =====
function extractData(html) {
  let totalListings = 0;
  const prices = [];

  // --- listing count ---
  const listingMatch = html.match(/(\d[\d,]+)\s+(tickets|listings)/i);
  if (listingMatch) {
    totalListings = parseInt(listingMatch[1].replace(/,/g,''), 10);
  }

  // --- prices ---
  for (const m of html.matchAll(/\$\s*([\d,]+(?:\.\d{2})?)/g)) {
    const val = parseFloat(m[1].replace(/,/g,''));
    if (val > 1 && val < 25000) prices.push(val);
  }

  prices.sort((a,b)=>a-b);

  console.log(`📊 Parsed → listings=${totalListings}, prices=${prices.length}`);

  return { totalListings, prices };
}

// ===== SCRAPE EVENT =====
async function scrapeEvent(event) {
  const url = `https://www.stubhub.com/event/${event.id}/?quantity=0`;

  const html = await fetchHTML(url);
  if (!html) return null;

  const { totalListings, prices } = extractData(html);

  const summary = summarizePrices(prices);

  if (!summary.floor) {
    console.log('⚠️ No pricing found');
    return null;
  }

  console.log(`💰 Floor: $${summary.floor} | Avg: $${summary.avg}`);

  await postSnapshot({
    eventId: event.id,
    eventName: event.name,
    eventDate: event.date,
    venue: event.venue,
    platform: 'StubHub',
    totalListings,
    eventFloor: summary.floor,
    eventAvg: summary.avg,
    eventCeiling: summary.ceiling
  });

  return true;
}

// ===== MAIN =====
async function main() {
  console.log('🚀 MAIN STARTED');

  const events = await getEvents();
  console.log('🎯 Events:', events.length);

  let scraped = 0;

  for (const event of events) {
    const recent = await scrapedRecently(event.id);
    if (recent) {
      console.log('⏭️ Skipping recent:', event.name);
      continue;
    }

    console.log('\n🎟️ Scraping:', event.name);

    const ok = await scrapeEvent(event);
    if (ok) scraped++;

    await sleep(SCRAPE_DELAY_MS);
  }

  console.log(`\n✅ DONE → scraped: ${scraped}`);
}

main().catch(e => {
  console.error('❌ Fatal:', e);
  process.exit(1);
});
