const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://unypasitbzulafehbqtj.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVueXBhc2l0Ynp1bGFmZWhicXRqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUwMTE2MjAsImV4cCI6MjA5MDU4NzYyMH0.ywGB7ZccbVxcgZDXMOQB9Ui8R-SF4xF0SKkWavDbRGI';
const VKT_API = process.env.VKT_API || 'https://vkt-volume-api.vercel.app';
const DECODO_TOKEN = process.env.DECODO_TOKEN || 'VTAwMDAzODg2OTg6UFdfMWQxMWYxY2ZlNTZhNWY2MzQ1YWVkMjUzZGUzNjI4MjA3';

const SCRAPE_DELAY_MS = parseInt(process.env.SCRAPE_DELAY_MS || '5000', 10);
const RECENT_HOURS = parseInt(process.env.RECENT_HOURS || '20', 10);
const EVENT_LIMIT = parseInt(process.env.EVENT_LIMIT || '200', 10);

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function safeNum(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

function normalizeDateString(value) {
  if (!value) return null;
  const s = String(value).trim();
  const isoMatch = s.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoMatch) return isoMatch[1];
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  }
  return null;
}

function summarizePrices(prices) {
  const valid = (prices||[]).map(safeNum).filter(v => v>0 && v<25000).sort((a,b)=>a-b);
  if (!valid.length) return { floor:null, avg:null, ceiling:null };
  return {
    floor: Math.round(valid[0]),
    avg: Math.round(valid.reduce((a,b)=>a+b,0)/valid.length),
    ceiling: Math.round(valid[valid.length-1])
  };
}

async function getEvents() {
  const { data, error } = await supabase.from('events').select('id,name,date,venue,platform').not('id','like','tm_%').order('date',{ascending:true}).limit(EVENT_LIMIT);
  if (error) { console.error('Failed to fetch events:', error.message); return []; }
  return data || [];
}

async function scrapedRecently(eventId, hours=RECENT_HOURS) {
  const since = new Date(Date.now() - hours*3600000).toISOString();
  const { data } = await supabase.from('volume_snapshots').select('id').eq('event_id',eventId).is('section',null).gte('scraped_at',since).limit(1);
  return !!(data && data.length > 0);
}

async function postSnapshot(payload) {
  try {
    const r = await fetch(VKT_API+'/api/snapshot', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
    if (!r.ok) { console.error('Snapshot failed:', r.status, await r.text()); return false; }
    return true;
  } catch(e) { console.error('Snapshot error:', e.message); return false; }
}

async function fetchWithDecodo(url) {
  try {
    const response = await fetch('https://scraper-api.decodo.com/v2/scrape', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Authorization': 'Basic ' + DECODO_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        url: url,
        proxy_pool: 'premium',
        headless: 'html',
        wait_for_selector: 'body'
      })
    });
    if (!response.ok) {
      console.error('  Decodo error:', response.status, await response.text());
      return null;
    }
    const data = await response.json();
    return data?.results?.[0]?.content || data?.content || data?.html || null;
  } catch(e) {
    console.error('  Decodo fetch error:', e.message);
    return null;
  }
}

function extractFromHtml(html) {
  let name = null, date = null, venue = null;
  let totalListings = 0;
  const prices = [];

  // --- Event metadata from JSON-LD ---
  const jsonLdMatches = [...html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const match of jsonLdMatches) {
    try {
      const parsed = JSON.parse(match[1]);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        if (item['@type'] !== 'Event' && item['@type'] !== 'SportsEvent') continue;
        if (!name && item.name && !item.name.toLowerCase().includes('tickets')) name = item.name;
        if (!date && item.startDate) date = normalizeDateString(item.startDate);
        if (!venue && item.location?.name) {
          const city = item.location.address?.addressLocality || '';
          const state = item.location.address?.addressRegion || '';
          venue = [item.location.name, city, state].filter(Boolean).join(', ');
        }
        if (name && date && venue) break;
      }
    } catch(_) {}
    if (name && date && venue) break;
  }

  // --- Walk all embedded JSON blobs for listing count + prices ---
  const scriptMatches = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const match of scriptMatches) {
    const content = match[1].trim();
    if (!content.startsWith('{') && !content.startsWith('[')) continue;
    try {
      const parsed = JSON.parse(content);
      function walk(obj) {
        if (!obj || typeof obj !== 'object') return;
        // Listing count candidates
        if (!totalListings) {
          const candidates = ['totalListings', 'listingCount', 'numListings', 'totalTickets', 'numFound', 'ticketCount'];
          for (const key of candidates) {
            if (typeof obj[key] === 'number' && obj[key] > 0) {
              totalListings = obj[key];
              console.log('  Found listing count via key "'+key+'": '+totalListings);
              break;
            }
          }
        }
        // Price candidates
        const priceKeys = ['currentPrice', 'listingPrice', 'pricePerTicket', 'minPrice', 'maxPrice', 'price', 'amount'];
        for (const key of priceKeys) {
          if (typeof obj[key] === 'number' && obj[key] > 0 && obj[key] < 25000) prices.push(obj[key]);
          if (obj[key] && typeof obj[key] === 'object' && typeof obj[key].amount === 'number') prices.push(obj[key].amount);
        }
        for (const k of Object.keys(obj)) {
          if (obj[k] && typeof obj[k] === 'object') walk(obj[k]);
        }
      }
      walk(parsed);
    } catch(_) {}
  }

  // --- Fallback: listing count from page text ---
  if (!totalListings) {
    const listingMatches = [...html.matchAll(/(\d[\d,]*)\s+listings?/gi)]
      .map(m => parseInt(m[1].replace(/,/g,''), 10))
      .filter(v => Number.isFinite(v) && v > 0);
    if (listingMatches.length) totalListings = Math.max(...listingMatches);
  }

  // --- Fallback: prices from visible $ text ---
  if (!prices.length) {
    for (const match of html.matchAll(/\$\s*([\d,]+(?:\.\d{2})?)/g)) {
      const value = parseFloat(match[1].replace(/,/g,''));
      if (Number.isFinite(value) && value >= 1 && value <= 25000) prices.push(value);
    }
  }

  // --- Fallback: name from title tag ---
  if (!name) {
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    if (titleMatch) {
      let t = titleMatch[1].replace(/\s*tickets\s*[-–|].*$/i, '').replace(/\s*[-–|].*$/i, '').trim();
      if (t && !t.toLowerCase().includes('tickets')) name = t;
    }
  }

  prices.sort((a,b)=>a-b);
  console.log('  Parsed: listings='+totalListings+', prices='+prices.length+(prices.length ? ', floor=$'+Math.round(prices[0]) : ''));
  return { name, date, venue, totalListings, prices };
}

async function scrapeEvent(event) {
  const eventId = event.id;
  const originalName = event.name || 'Event '+eventId;

  try {
    const url = 'https://www.stubhub.com/event/'+eventId+'/?quantity=0';
    console.log('  Fetching:', url);
    const html = await fetchWithDecodo(url);
    if (!html) { console.error('  No HTML for', eventId); return null; }

    const { name: parsedName, date: parsedDate, venue: parsedVenue, totalListings, prices } = extractFromHtml(html);

    let name = parsedName || originalName;
    if (name && name.toLowerCase().includes('tickets')) name = originalName;
    const venue = parsedVenue || event.venue || null;
    const date = parsedDate || event.date || null;

    const summary = summarizePrices(prices);
    if (!summary.floor) { console.log('  No pricing for '+name); return null; }

    console.log('  '+name+': '+totalListings+' listings, floor $'+summary.floor+', atp $'+summary.avg);

    await postSnapshot({
      eventId, eventName:name, eventDate:date, venue, platform:'StubHub',
      totalListings, section:null, sectionListings:0,
      eventFloor:summary.floor, eventAvg:summary.avg, eventCeiling:summary.ceiling,
      source:'decodo'
    });

    const updates = {};
    if (name !== originalName) updates.name = name;
    if (venue && venue !== event.venue) updates.venue = venue;
    if (date && date !== event.date) updates.date = date;
    if (Object.keys(updates).length) await supabase.from('events').update(updates).eq('id',eventId);

    return { ok:true };

  } catch(e) { console.error('  Failed '+eventId+':', e.message); return null; }
}

async function main() {
  console.log('VKT Playwright scraper starting...');

  const manualId = process.argv[2];
  let events = manualId ? [{ id:manualId, name:'Manual', date:null, venue:null, platform:'StubHub' }] : await getEvents();
  console.log('Events to process: '+events.length);

  let scraped=0, skipped=0, failed=0;

  for (const event of events) {
    if (!manualId) {
      const recent = await scrapedRecently(event.id);
      if (recent) { console.log('Skipping '+event.name+' (recent)'); skipped++; continue; }
    }
    console.log('\nScraping: '+event.name+' ('+event.id+')');
    const result = await scrapeEvent(event);
    if (result) scraped++; else failed++;
    await sleep(SCRAPE_DELAY_MS);
  }

  console.log('\nDone — scraped:'+scraped+' skipped:'+skipped+' failed:'+failed);
}

main().catch(e => { console.error(e); process.exit(1); });
