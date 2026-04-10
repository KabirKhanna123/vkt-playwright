const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');

chromium.use(StealthPlugin());

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://unypasitbzulafehbqtj.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVueXBhc2l0Ynp1bGFmZWhicXRqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUwMTE2MjAsImV4cCI6MjA5MDU4NzYyMH0.ywGB7ZccbVxcgZDXMOQB9Ui8R-SF4xF0SKkWavDbRGI';
const VKT_API = process.env.VKT_API || 'https://vkt-volume-api.vercel.app';

const SCRAPE_DELAY_MS = parseInt(process.env.SCRAPE_DELAY_MS || '8000', 10);
const SECTION_DELAY_MS = parseInt(process.env.SECTION_DELAY_MS || '4000', 10);
const RECENT_HOURS = parseInt(process.env.RECENT_HOURS || '20', 10);
const EVENT_LIMIT = parseInt(process.env.EVENT_LIMIT || '200', 10);
const MIN_PRICE = 10;
const MAX_PRICE = 25000;

// IMPORTANT: adjust this to StubHub's real ticket row selector
// e.g. '[data-testid="ticket-row"]' or '.TicketRow'
const TICKET_ROW_SELECTOR = process.env.TICKET_ROW_SELECTOR || '[data-testid="ticket-row"]';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function randomDelay(min, max) { return sleep(min + Math.random() * (max - min)); }
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
  const valid = (prices||[])
    .map(safeNum)
    .filter(v => v >= MIN_PRICE && v <= MAX_PRICE)
    .sort((a,b) => a-b);
  if (!valid.length) return { floor:null, avg:null, ceiling:null };
  return {
    floor: Math.round(valid[0]),
    avg: Math.round(valid.reduce((a,b) => a+b, 0) / valid.length),
    ceiling: Math.round(valid[valid.length-1])
  };
}

async function getEvents() {
  const { data, error } = await supabase
    .from('events')
    .select('id,name,date,venue,platform,is_major')
    .not('id','like','tm_%')
    .order('date', { ascending: true })
    .limit(EVENT_LIMIT);
  if (error) {
    console.error('Failed to fetch events:', error.message);
    return [];
  }
  return data || [];
}

async function scrapedRecently(eventId, hours=RECENT_HOURS) {
  const since = new Date(Date.now() - hours*3600000).toISOString();
  const { data, error } = await supabase
    .from('volume_snapshots')
    .select('id')
    .eq('event_id',eventId)
    .is('section',null)
    .gte('scraped_at',since)
    .limit(1);
  if (error) {
    console.error('scrapedRecently error:', error.message);
    return false;
  }
  return !!(data && data.length > 0);
}

async function postSnapshot(payload) {
  try {
    const r = await fetch(VKT_API+'/api/snapshot', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(payload)
    });
    if (!r.ok) {
      console.error('  Snapshot failed:', r.status, await r.text());
      return false;
    }
    return true;
  } catch(e) {
    console.error('  Snapshot error:', e.message);
    return false;
  }
}

async function dismissModals(page) {
  for (const sel of [
    'button:has-text("Accept")',
    'button:has-text("Continue")',
    'button:has-text("Close")',
    'button[aria-label="Close"]',
    '[data-testid="close-button"]'
  ]) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({timeout:600})) {
        await el.click({timeout:800});
        await page.waitForTimeout(400);
      }
    } catch(_) {}
  }
}

async function navigateTo(page, url, waitMs=4000) {
  await page.goto(url, { waitUntil:'domcontentloaded', timeout:45000 });
  await randomDelay(waitMs, waitMs + 2000);
  await dismissModals(page);

  const title = (await page.title()) || '';
  const lower = title.toLowerCase();
  if (!title || lower.includes('just a moment') || lower.includes('access denied')) {
    console.warn('  Challenge page detected, retrying...');
    await randomDelay(5000, 8000);
    await page.reload({ waitUntil:'domcontentloaded', timeout:45000 });
    await randomDelay(waitMs, waitMs + 2000);
    await dismissModals(page);
  }
}

// EVENT-LEVEL extraction
async function extractPageData(page) {
  return await page.evaluate(({minPrice, maxPrice, ticketRowSelector}) => {
    let name = null, date = null, venue = null;

    // JSON-LD metadata
    const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
    for (const script of scripts) {
      try {
        const parsed = JSON.parse(script.textContent);
        const items = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of items) {
          if (!item || typeof item !== 'object') continue;
          if (item['@type'] !== 'Event' && item['@type'] !== 'SportsEvent') continue;
          if (!name && item.name && !item.name.toLowerCase().includes('tickets')) name = item.name;
          if (!date && item.startDate) date = item.startDate;
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

    // Count ticket rows for total listings
    let totalListings = 0;
    try {
      if (ticketRowSelector) {
        totalListings = document.querySelectorAll(ticketRowSelector).length;
      }
    } catch(_) {}

    // Prices from ticket rows only
    const prices = [];
    try {
      const rows = ticketRowSelector
        ? Array.from(document.querySelectorAll(ticketRowSelector))
        : [];
      for (const row of rows) {
        const text = row.innerText || '';
        if (!text.includes('$')) continue;
        for (const match of text.matchAll(/\$\s*([\d,]+(?:\.\d{2})?)/g)) {
          const value = parseFloat(match[1].replace(/,/g,''));
          if (Number.isFinite(value) && value >= minPrice && value <= maxPrice) {
            prices.push(value);
          }
        }
      }
    } catch(_) {}

    // Section numbers from text (heuristic)
    const bodyText = document.body?.innerText || '';
    const sectionNumbers = new Set();
    const lines = bodyText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    for (const line of lines) {
      if (/^\d{2,3}[A-Z]?$/.test(line)) {
        const n = parseInt(line, 10);
        if (n >= 100 && n <= 599) sectionNumbers.add(line.trim());
      }
    }

    return { name, date, venue, totalListings, prices, sectionNumbers: Array.from(sectionNumbers) };
  }, {minPrice: MIN_PRICE, maxPrice: MAX_PRICE, ticketRowSelector: TICKET_ROW_SELECTOR});
}

// SECTION-LEVEL extraction (URL already filtered by ?sections=XXX)
async function extractSectionPrices(page) {
  return await page.evaluate(({minPrice, maxPrice, ticketRowSelector}) => {
    try {
      if (!document || !document.body) {
        return { totalListings:0, prices:[], error:'no-body' };
      }

      const rows = ticketRowSelector
        ? Array.from(document.querySelectorAll(ticketRowSelector))
        : [];
      const totalListings = rows.length;

      const prices = [];
      for (const row of rows) {
        try {
          const text = row.innerText || '';
          if (!text.includes('$')) continue;
          for (const match of text.matchAll(/\$\s*([\d,]+(?:\.\d{2})?)/g)) {
            const value = parseFloat(match[1].replace(/,/g,''));
            if (Number.isFinite(value) && value >= minPrice && value <= maxPrice) {
              prices.push(value);
            }
          }
        } catch { continue; }
      }

      prices.sort((a,b) => a-b);
      return { totalListings, prices, error:null };
    } catch(e) {
      return { totalListings:0, prices:[], error: e?.message || 'unknown' };
    }
  }, {minPrice: MIN_PRICE, maxPrice: MAX_PRICE, ticketRowSelector: TICKET_ROW_SELECTOR});
}

async function scrapeEvent(page, event) {
  const eventId = event.id;
  const originalName = event.name || 'Event '+eventId;
  const isMajor = event.is_major === true;

  try {
    const url = `https://www.stubhub.com/event/${eventId}/?quantity=0`;
    await navigateTo(page, url, SCRAPE_DELAY_MS);

    // Best-effort wait for ticket rows
    await page.waitForSelector(TICKET_ROW_SELECTOR, { timeout:15000 }).catch(() => {});

    const data = await extractPageData(page);

    let name = data.name || originalName;
    if (name && name.toLowerCase().includes('tickets')) name = originalName;
    const venue = data.venue || event.venue || null;
    const date = normalizeDateString(data.date) || event.date || null;
    const { totalListings, prices, sectionNumbers } = data;

    const summary = summarizePrices(prices);
    if (!summary.floor) {
      console.log('  No pricing for '+name);
      return;
    }

    console.log(`  ${name} | ${date} | ${venue}`);
    console.log(`  ${totalListings} listings, floor $${summary.floor}, atp $${summary.avg}${isMajor ? ' [MAJOR]' : ''}`);

    // Event-level snapshot
    await postSnapshot({
      eventId,
      eventName: name,
      eventDate: date,
      venue,
      platform: 'StubHub',
      totalListings,
      section: null,
      sectionListings: 0,
      eventFloor: summary.floor,
      eventAvg: summary.avg,
      eventCeiling: summary.ceiling,
      source: 'playwright'
    });

    // Update events table if metadata improved
    const updates = {};
    if (name !== originalName) updates.name = name;
    if (venue && venue !== event.venue) updates.venue = venue;
    if (date && date !== event.date) updates.date = date;
    if (Object.keys(updates).length) {
      await supabase.from('events').update(updates).eq('id', eventId);
    }

    // Section scraping for major events
    if (isMajor && sectionNumbers.length > 0) {
      console.log(`  Scraping ${sectionNumbers.length} sections...`);

      for (const section of sectionNumbers) {
        try {
          const sectionUrl = `https://www.stubhub.com/event/${eventId}/?quantity=0&sections=${encodeURIComponent(section)}`;
          await navigateTo(page, sectionUrl, SECTION_DELAY_MS);

          await page.waitForSelector(TICKET_ROW_SELECTOR, { timeout:15000 }).catch(() => {});

          const sectionResult = await extractSectionPrices(page);
          if (sectionResult.error) {
            console.warn(`    Section ${section}: extractSectionPrices error: ${sectionResult.error}`);
          }

          const { totalListings: sectionListings, prices: sectionPrices } = sectionResult;
          const sectionSummary = summarizePrices(sectionPrices);

          if (!sectionSummary.floor) {
            console.log(`    Section ${section}: no valid prices`);
            continue;
          }

          console.log(`    Section ${section}: ${sectionListings} listings, floor $${sectionSummary.floor}, atp $${sectionSummary.avg}`);

          await postSnapshot({
            eventId,
            eventName: name,
            eventDate: date,
            venue,
            platform: 'StubHub',
            totalListings,
            section,
            sectionListings,
            eventFloor: summary.floor,
            eventAvg: summary.avg,
            eventCeiling: summary.ceiling,
            sectionFloor: sectionSummary.floor,
            sectionAvg: sectionSummary.avg,
            sectionCeiling: sectionSummary.ceiling,
            source: 'playwright'
          });

          await randomDelay(SECTION_DELAY_MS, SECTION_DELAY_MS + 2000);
        } catch(e) {
          console.error(`    Section ${section} error:`, e.message);
        }
      }
    }
  } catch(e) {
    console.error(`  Error scraping event ${eventId}:`, e.message);
  }
}

async function main() {
  console.log('VKT Playwright scraper starting...');

  const events = await getEvents();
  console.log('Events to process:', events.length);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  page.on('console', msg => {
    if (msg.type() === 'error') console.error('PAGE ERROR:', msg.text());
  });

  for (const event of events) {
    const eventId = event.id;
    console.log(`Scraping: ${event.name || eventId} (${eventId})`);

    const recently = await scrapedRecently(eventId);
    if (recently) {
      console.log('  Skipping (recently scraped)');
      continue;
    }

    await scrapeEvent(page, event);
    await randomDelay(SCRAPE_DELAY_MS, SCRAPE_DELAY_MS + 3000);
  }

  await browser.close();
  console.log('Done.');
}

if (require.main === module) {
  main().catch(e => {
    console.error('Fatal error:', e);
    process.exit(1);
  });
}
