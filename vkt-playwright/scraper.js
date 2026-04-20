const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { createClient } = require('@supabase/supabase-js');

chromium.use(StealthPlugin());

const BRIGHTDATA_API_TOKEN = process.env.BRIGHTDATA_API_TOKEN || 'ac7d557e-67eb-4e04-90ef-56b1db829ab7';
const WEB_UNLOCKER_ZONE    = process.env.WEB_UNLOCKER_ZONE    || 'web_unlocker1';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://unypasitbzulafehbqtj.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVueXBhc2l0Ynp1bGFmZWhicXRqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUwMTE2MjAsImV4cCI6MjA5MDU4NzYyMH0.ywGB7ZccbVxcgZDXMOQB9Ui8R-SF4xF0SKkWavDbRGI';
const VKT_API      = process.env.VKT_API      || 'https://vkt-volume-api.vercel.app';

const SCRAPE_DELAY_MS = parseInt(process.env.SCRAPE_DELAY_MS || '1500', 10);
const RECENT_HOURS    = parseInt(process.env.RECENT_HOURS    || '20',   10);
const EVENT_LIMIT     = parseInt(process.env.EVENT_LIMIT     || '200',  10);
const CONCURRENCY     = parseInt(process.env.CONCURRENCY     || '8',    10);
const MIN_PRICE = 10;
const MAX_PRICE = 25000;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randomDelay(min, max) { return sleep(min + Math.random() * (max - min)); }
function safeNum(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

function normalizeDateString(value) {
  if (!value) return null;
  const s = String(value).trim();
  const isoMatch = s.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoMatch) return isoMatch[1];
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    return d.getFullYear() + '-' +
      String(d.getMonth()+1).padStart(2,'0') + '-' +
      String(d.getDate()).padStart(2,'0');
  }
  return null;
}

function summarizePrices(prices) {
  const valid = (prices||[]).map(safeNum)
    .filter(v => v >= MIN_PRICE && v <= MAX_PRICE)
    .sort((a,b) => a-b);
  if (!valid.length) return { floor:null, avg:null, ceiling:null };
  return {
    floor:   Math.round(valid[0]),
    avg:     Math.round(valid.reduce((a,b) => a+b, 0) / valid.length),
    ceiling: Math.round(valid[valid.length-1])
  };
}

// ── FIX 1: Extract category floors directly from main page HTML ───────────────
// StubHub embeds category floors in aria-label attributes on the main page.
// e.g. aria-label="Category 1 from $1359"
// This eliminates the need to navigate to 4 separate category URLs.
function extractCategoryFloorsFromHtml(html) {
  const categories = [];

  // Pattern: aria-label="Category 1 from $1,359" or "Category 2 $898"
  const ariaMatches = [...html.matchAll(/aria-label="[^"]*Category\s+(\d+)[^"]*?\$\s*([\d,]+)/gi)];
  for (const m of ariaMatches) {
    const catNum = parseInt(m[1], 10);
    const floor  = parseInt(m[2].replace(/,/g,''), 10);
    if (catNum >= 1 && catNum <= 10 && floor >= MIN_PRICE && floor <= MAX_PRICE) {
      if (!categories.find(c => c.category === catNum)) {
        categories.push({ category: catNum, floor });
      }
    }
  }

  // Fallback: look for JSON-LD or embedded data with category pricing
  if (!categories.length) {
    const jsonMatches = [...html.matchAll(/"ticketClass(?:Name|Id)?"\s*:\s*"?(\d+)"?[^}]*?"minPrice"\s*:\s*([\d.]+)/gi)];
    for (const m of jsonMatches) {
      const catNum = parseInt(m[1], 10);
      const floor  = Math.round(parseFloat(m[2]));
      if (catNum >= 1 && catNum <= 4 && floor >= MIN_PRICE && floor <= MAX_PRICE) {
        if (!categories.find(c => c.category === catNum)) {
          categories.push({ category: catNum, floor });
        }
      }
    }
  }

  return categories.sort((a,b) => a.category - b.category);
}

function buildStubHubUrl(event) {
  if (event.stubhub_url) {
    return event.stubhub_url.split('?')[0].replace(/\/$/, '') + '/?quantity=0';
  }
  const eventId = event.id;
  if (event.name && event.date) {
    try {
      const nameSlug = event.name
        .toLowerCase()
        .replace(/\s+at\s+/i, ' ')
        .replace(/[^a-z0-9\s]/g, '')
        .trim()
        .replace(/\s+/g, '-');

      let citySlug = '';
      if (event.venue) {
        const vp = event.venue.split(',');
        if (vp.length >= 2) {
          citySlug = vp[1].trim().toLowerCase()
            .replace(/[^a-z0-9\s]/g, '').trim().replace(/\s+/g, '-');
        }
      }

      const d = new Date(event.date + 'T12:00:00');
      const dateSlug = `${d.getMonth()+1}-${d.getDate()}-${d.getFullYear()}`;
      const slug = citySlug
        ? `${nameSlug}-${citySlug}-tickets-${dateSlug}`
        : `${nameSlug}-tickets-${dateSlug}`;

      return `https://www.stubhub.com/${slug}/event/${eventId}/?quantity=0`;
    } catch(_) {}
  }
  return `https://www.stubhub.com/event/${eventId}/?quantity=0`;
}

function extractCanonicalUrl(html, eventId) {
  const og = html.match(/<meta[^>]+property="og:url"[^>]+content="([^"]+)"/i)
           || html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:url"/i);
  if (og && og[1].includes(eventId)) return og[1].split('?')[0];
  const can = html.match(/<link[^>]+rel="canonical"[^>]+href="([^"]+)"/i)
            || html.match(/<link[^>]+href="([^"]+)"[^>]+rel="canonical"/i);
  if (can && can[1].includes(eventId)) return can[1].split('?')[0];
  return null;
}

function isCorrectEventPage(html, eventId) {
  if (!html || html.length < 5000) return false;
  if (!html.includes(eventId)) return false;
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  if (titleMatch && /Schedule|NFL \d{4}|NBA \d{4}|MLB \d{4}|NHL \d{4}/i.test(titleMatch[1])) return false;
  return true;
}

async function getEvents() {
  const { data, error } = await supabase
    .from('events')
    .select('id,name,date,venue,platform,is_major,stubhub_url')
    .not('id', 'like', 'tm_%')
    .not('name', 'ilike', '%football 2026 event%')
    .not('name', 'ilike', '%basketball 2026 event%')
    .not('name', 'ilike', '%baseball 2026 event%')
    .not('name', 'ilike', '%hockey 2026 event%')
    .not('name', 'ilike', '%soccer 2026 event%')
    .not('name', 'ilike', '% tickets')
    .not('name', 'ilike', '%2026 event')
    .order('date', { ascending: true })
    .limit(EVENT_LIMIT);
  if (error) { console.error('Failed to fetch events:', error.message); return []; }
  return data || [];
}

async function scrapedRecently(eventId, hours=RECENT_HOURS) {
  const since = new Date(Date.now() - hours*3600000).toISOString();
  const { data } = await supabase
    .from('volume_snapshots')
    .select('id')
    .eq('event_id', eventId)
    .is('section', null)
    .gte('scraped_at', since)
    .limit(1);
  return !!(data && data.length > 0);
}

async function postSnapshot(payload) {
  try {
    const r = await fetch(VKT_API+'/api/snapshot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!r.ok) { console.error('  Snapshot failed:', r.status); return false; }
    return true;
  } catch(e) { console.error('  Snapshot error:', e.message); return false; }
}

async function fetchWithWebUnlocker(targetUrl) {
  try {
    const res = await fetch('https://api.brightdata.com/request', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + BRIGHTDATA_API_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        zone: WEB_UNLOCKER_ZONE,
        url: targetUrl,
        format: 'raw',
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        }
      })
    });

    const text = await res.text();
    if (!res.ok) { console.error('  BrightData error:', res.status); return null; }

    try {
      const json = JSON.parse(text);
      return json.body || json.html || json.content || null;
    } catch(_) {}

    return text;
  } catch(e) {
    console.error('  Fetch error:', e.message);
    return null;
  }
}

async function dismissModals(page) {
  for (const sel of [
    'button:has-text("Accept")',
    'button:has-text("Continue")',
    'button:has-text("Close")',
    'button[aria-label="Close"]'
  ]) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({timeout:400})) {
        await el.click({timeout:500});
        await page.waitForTimeout(200);
      }
    } catch(_) {}
  }
}

async function extractPageData(page) {
  return await page.evaluate(({minPrice, maxPrice}) => {
    let name = null, date = null, venue = null;

    // Extract structured data
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const items = [].concat(JSON.parse(script.textContent));
        for (const item of items) {
          if (!item || (item['@type'] !== 'Event' && item['@type'] !== 'SportsEvent')) continue;
          if (!name && item.name && !item.name.toLowerCase().includes('tickets')) name = item.name;
          if (!date && item.startDate) date = item.startDate;
          if (!venue && item.location?.name) {
            const city  = item.location.address?.addressLocality || '';
            const state = item.location.address?.addressRegion || '';
            venue = [item.location.name, city, state].filter(Boolean).join(', ');
          }
          if (name && date && venue) break;
        }
      } catch(_) {}
      if (name && date && venue) break;
    }

    // Listing count
    const bodyText = document.body?.innerText || '';
    const listingMatches = [...bodyText.matchAll(/\b(\d[\d,]*)\s+listings?\b/gi)]
      .map(m => parseInt(m[1].replace(/,/g,''), 10))
      .filter(v => Number.isFinite(v) && v > 0);
    const totalListings = listingMatches.length ? Math.max(...listingMatches) : 0;

    // All prices from DOM
    const prices = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      try {
        if (!node.parentElement) continue;
        if (node.parentElement.closest('script,style,noscript,svg')) continue;
        const style = window.getComputedStyle(node.parentElement);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        for (const match of node.textContent.matchAll(/\$\s*([\d,]+(?:\.\d{2})?)/g)) {
          const v = parseFloat(match[1].replace(/,/g,''));
          if (Number.isFinite(v) && v >= minPrice && v <= maxPrice) prices.push(v);
        }
      } catch(_) {}
    }
    prices.sort((a,b) => a-b);

    return { name, date, venue, totalListings, prices };
  }, { minPrice: MIN_PRICE, maxPrice: MAX_PRICE });
}

// ── Worker: one browser page, pulls from shared queue ────────────────────────
async function worker(workerId, context, queue, results) {
  const page = await context.newPage();

  // ── FIX 2: Block images, fonts, media — major speed + cost reduction ─────
  await page.route('**/*', route => {
    const type = route.request().resourceType();
    if (['image','media','font','stylesheet'].includes(type)) {
      return route.abort();
    }
    return route.continue();
  });

  while (true) {
    const event = queue.shift();
    if (!event) break;

    const eventId    = event.id;
    const origName   = event.name || 'Event ' + eventId;

    console.log(`[W${workerId}] ${origName} (${eventId})`);

    try {
      const url  = buildStubHubUrl(event);
      let html   = await fetchWithWebUnlocker(url);

      // Fallback to short URL
      if (!isCorrectEventPage(html, eventId)) {
        const short = `https://www.stubhub.com/event/${eventId}/?quantity=0`;
        if (short !== url) html = await fetchWithWebUnlocker(short);
      }

      if (!isCorrectEventPage(html, eventId)) {
        console.log(`[W${workerId}] ✗ Wrong page for ${eventId}`);
        results.failed++;
        continue;
      }

      // ── FIX 1: Extract category floors from main page HTML ───────────────
      // No more navigating to 4 separate category URLs.
      const categoryFloors = extractCategoryFloorsFromHtml(html);
      if (categoryFloors.length) {
        console.log(`[W${workerId}]   Categories: ${categoryFloors.map(c=>`Cat${c.category}=$${c.floor}`).join(', ')}`);
      }

      const canonicalUrl = extractCanonicalUrl(html, eventId);

      // Use Playwright only for DOM parsing (no network navigation)
      // ── FIX 3: Short timeout — we already have the HTML ─────────────────
      await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await dismissModals(page);

      const data = await extractPageData(page);
      let name   = data.name || origName;
      if (name.toLowerCase().includes('tickets')) name = origName;
      const venue = data.venue || event.venue || null;
      const date  = normalizeDateString(data.date) || event.date || null;
      const { totalListings, prices } = data;

      const summary = summarizePrices(prices);
      if (!summary.floor) {
        console.log(`[W${workerId}] ✗ No pricing for ${name}`);
        results.failed++;
        continue;
      }

      console.log(`[W${workerId}] ✓ ${name} | ${totalListings} listings, floor $${summary.floor}, atp $${summary.avg}`);

      // Save event-level snapshot
      await postSnapshot({
        eventId, eventName: name, eventDate: date, venue, platform: 'StubHub',
        totalListings, section: null, sectionListings: 0,
        eventFloor: summary.floor, eventAvg: summary.avg, eventCeiling: summary.ceiling,
        source: 'brightdata'
      });

      // Save per-category snapshots from main page data (no extra fetches)
      for (const cat of categoryFloors) {
        await postSnapshot({
          eventId, eventName: name, eventDate: date, venue, platform: 'StubHub',
          totalListings: 0,
          section: `Category ${cat.category}`,
          sectionListings: 0,
          sectionFloor: cat.floor,
          sectionAvg: null,
          sectionCeiling: summary.ceiling,
          eventFloor: null,
          source: 'brightdata'
        });
      }

      // Update events table if we learned new info
      const updates = {};
      if (name !== origName) updates.name = name;
      if (venue && venue !== event.venue) updates.venue = venue;
      if (date  && date  !== event.date)  updates.date  = date;
      if (canonicalUrl && canonicalUrl !== event.stubhub_url) updates.stubhub_url = canonicalUrl;
      if (Object.keys(updates).length) {
        await supabase.from('events').update(updates).eq('id', eventId);
      }

      results.scraped++;

    } catch(e) {
      console.error(`[W${workerId}] Error on ${eventId}:`, e.message);
      results.failed++;
    }

    await randomDelay(SCRAPE_DELAY_MS, SCRAPE_DELAY_MS + 1000);
  }

  await page.close();
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`VKT scraper — concurrency: ${CONCURRENCY}`);

  const manualId = process.argv[2];
  let events = manualId
    ? [{ id: manualId, name: 'Manual', date: null, venue: null, stubhub_url: null }]
    : await getEvents();

  // ── FIX 4: Deduplicate event IDs before doing anything ───────────────────
  const seen = new Set();
  const before = events.length;
  events = events.filter(e => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });
  if (before !== events.length) {
    console.log(`Deduplicated: removed ${before - events.length} duplicate event IDs`);
  }

  // ── FIX 5: Check recent scrapes in parallel, not one at a time ───────────
  if (!manualId) {
    console.log(`Checking ${events.length} events for recent scrapes...`);
    const recentFlags = await Promise.all(events.map(e => scrapedRecently(e.id)));
    const beforeFilter = events.length;
    events = events.filter((_, i) => !recentFlags[i]);
    console.log(`Skipping ${beforeFilter - events.length} recently scraped — ${events.length} to process`);
  }

  if (!events.length) { console.log('Nothing to scrape.'); return; }

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--disable-images',         // extra savings on top of route blocking
      '--blink-settings=imagesEnabled=false'
    ]
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    // ── FIX 6: No JS execution needed — we already have rendered HTML ───────
    javaScriptEnabled: false
  });

  const queue   = [...events];
  const results = { scraped: 0, failed: 0 };

  const workerCount = Math.min(CONCURRENCY, events.length);
  console.log(`Launching ${workerCount} parallel workers for ${events.length} events...`);

  await Promise.all(
    Array.from({ length: workerCount }, (_, i) => worker(i + 1, context, queue, results))
  );

  await browser.close();
  console.log(`\nDone — scraped: ${results.scraped}, failed: ${results.failed}`);
}

main().catch(e => { console.error(e); process.exit(1); });
