const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch'); // make sure: npm install node-fetch@2

chromium.use(StealthPlugin());

const BRIGHTDATA_API_TOKEN = process.env.BRIGHTDATA_API_TOKEN || 'ac7d557e-67eb-4e04-90ef-56b1db829ab7';
const WEB_UNLOCKER_ZONE    = process.env.WEB_UNLOCKER_ZONE    || 'web_unlocker1';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://unypasitbzulafehbqtj.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVueXBhc2l0Ynp1bGFmZWhicXRqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUwMTE2MjAsImV4cCI6MjA5MDU4NzYyMH0.ywGB7ZccbVxcgZDXMOQB9Ui8R-SF4xF0SKkWavDbRGI';
const VKT_API      = process.env.VKT_API      || 'https://vkt-volume-api.vercel.app';

const SCRAPE_DELAY_MS  = parseInt(process.env.SCRAPE_DELAY_MS  || '5000', 10);
const SECTION_DELAY_MS = parseInt(process.env.SECTION_DELAY_MS || '3000', 10);
const RECENT_HOURS     = parseInt(process.env.RECENT_HOURS     || '20',   10);
const EVENT_LIMIT      = parseInt(process.env.EVENT_LIMIT      || '200',  10);
const MIN_PRICE = 10;
const MAX_PRICE = 25000;

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
    floor:   Math.round(valid[0]),
    avg:     Math.round(valid.reduce((a,b) => a+b, 0) / valid.length),
    ceiling: Math.round(valid[valid.length-1])
  };
}

async function getEvents() {
  const { data, error } = await supabase
    .from('events')
    .select('id,name,date,venue,platform,is_major')
    .not('id', 'like', 'tm_%')
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
    const r = await fetch(VKT_API + '/api/snapshot', {
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

async function fetchWithWebUnlocker(targetUrl) {
  console.log('  Fetching via Web Unlocker:', targetUrl);

  const res = await fetch('https://api.brightdata.com/request', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + BRIGHTDATA_API_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      zone:   WEB_UNLOCKER_ZONE,
      url:    targetUrl,
      format: 'raw'
    })
  });

  const text = await res.text();
  if (!res.ok) {
    console.error('  Web Unlocker error:', res.status, text.slice(0, 200));
    return null;
  }

  // Response may be JSON wrapping HTML, or raw HTML directly
  try {
    const json = JSON.parse(text);
    const html = json.body || json.html || json.content || null;
    if (html) {
      console.log('  HTML length:', html.length);
      return html;
    }
  } catch(_) {}

  console.log('  Raw HTML length:', text.length);
  return text;
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
      if (await el.isVisible({timeout:500})) {
        await el.click({timeout:700});
        await page.waitForTimeout(300);
      }
    } catch(_) {}
  }
}

async function extractPageData(page) {
  return await page.evaluate(({minPrice, maxPrice}) => {
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

    const bodyText = document.body?.innerText || '';

    // Listing count
    const listingMatches = [...bodyText.matchAll(/\b(\d[\d,]*)\s+listings?\b/gi)]
      .map(m => parseInt(m[1].replace(/,/g,''), 10))
      .filter(v => Number.isFinite(v) && v > 0);
    const totalListings = listingMatches.length ? Math.max(...listingMatches) : 0;

    // Prices from visible text
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
          const value = parseFloat(match[1].replace(/,/g,''));
          if (Number.isFinite(value) && value >= minPrice && value <= maxPrice) prices.push(value);
        }
      } catch(_) { continue; }
    }
    prices.sort((a,b) => a-b);

    // Section numbers (heuristic)
    const sectionNumbers = new Set();
    const lines = bodyText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    for (const line of lines) {
      if (/^\d{2,3}[A-Z]?$/.test(line)) {
        const n = parseInt(line, 10);
        if (n >= 100 && n <= 599) sectionNumbers.add(line.trim());
      }
    }

    return { name, date, venue, totalListings, prices, sectionNumbers: Array.from(sectionNumbers) };
  }, {minPrice: MIN_PRICE, maxPrice: MAX_PRICE});
}

async function extractSectionPrices(page) {
  return await page.evaluate(({minPrice, maxPrice}) => {
    try {
      if (!document || !document.body) return { totalListings:0, prices:[], error:'no-body' };

      const bodyText = document.body.innerText || '';

      // Section-specific count from "Section 120 | 3 listings"
      const secHeaderMatch = bodyText.match(/Section\s+[\w\d]+\s*\|\s*(\d[\d,]*)\s+listings?/i);
      let totalListings = secHeaderMatch ? parseInt(secHeaderMatch[1].replace(/,/g,''), 10) : 0;

      // Fallback: smallest listing number under 500
      if (!totalListings) {
        const matches = [...bodyText.matchAll(/\b(\d[\d,]*)\s+listings?\b/gi)]
          .map(m => parseInt(m[1].replace(/,/g,''), 10))
          .filter(v => Number.isFinite(v) && v > 0 && v < 500);
        totalListings = matches.length ? Math.min(...matches) : 0;
      }

      const prices = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        try {
          if (!node.parentElement) continue;
          if (node.parentElement.closest('script,style,noscript,svg')) continue;
          let style;
          try { style = window.getComputedStyle(node.parentElement); } catch { continue; }
          if (!style || style.display === 'none' || style.visibility === 'hidden') continue;
          const text = node.textContent || '';
          if (!text.includes('$')) continue;
          for (const match of text.matchAll(/\$\s*([\d,]+(?:\.\d{2})?)/g)) {
            const value = parseFloat(match[1].replace(/,/g,''));
            if (Number.isFinite(value) && value >= minPrice && value <= maxPrice) prices.push(value);
          }
        } catch { continue; }
      }

      prices.sort((a,b) => a-b);
      return { totalListings, prices, error:null };
    } catch(e) {
      return { totalListings:0, prices:[], error: e?.message || 'unknown' };
    }
  }, {minPrice: MIN_PRICE, maxPrice: MAX_PRICE});
}

async function scrapeEvent(page, event) {
  const eventId = event.id;
  const originalName = event.name || 'Event ' + eventId;
  const isMajor = event.is_major === true;

  try {
    const url = 'https://www.stubhub.com/event/' + eventId + '/?quantity=0';
    const html = await fetchWithWebUnlocker(url);
    if (!html || html.length < 5000) {
      console.error('  HTML too short or empty for event', eventId, 'length=', html ? html.length : 0);
      return;
    }

    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    await dismissModals(page);

    const data = await extractPageData(page);
    let name  = data.name  || originalName;
    const venue = data.venue || event.venue || null;
    const date  = normalizeDateString(data.date) || event.date || null;
    const { totalListings, prices, sectionNumbers } = data;

    if (name && name.toLowerCase().includes('tickets')) name = originalName;

    const summary = summarizePrices(prices);
    if (!summary.floor) {
      console.log('  No valid pricing found for', name);
      return;
    }

    console.log(`  ${name} | ${date} | ${venue}`);
    console.log(`  ${totalListings} listings, floor $${summary.floor}, atp $${summary.avg}${isMajor ? ' [MAJOR]' : ''}`);

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
      source: 'playwright+web_unlocker'
    });

    const updates = {};
    if (name !== originalName) updates.name = name;
    if (venue && venue !== event.venue) updates.venue = venue;
    if (date && date !== event.date) updates.date = date;
    if (Object.keys(updates).length) {
      await supabase.from('events').update(updates).eq('id', eventId);
    }

    if (isMajor && sectionNumbers.length > 0) {
      console.log(`  Scraping ${sectionNumbers.length} sections:`, sectionNumbers);

      for (const section of sectionNumbers) {
        try {
          const sectionUrl = `https://www.stubhub.com/event/${eventId}/?quantity=0&sections=${encodeURIComponent(section)}`;
          const secHtml = await fetchWithWebUnlocker(sectionUrl);
          if (!secHtml || secHtml.length < 5000) {
            console.error(`    Section ${section}: HTML too short or empty, length=`, secHtml ? secHtml.length : 0);
            continue;
          }

          await page.setContent(secHtml, { waitUntil: 'domcontentloaded' });
          await dismissModals(page);

          const secResult = await extractSectionPrices(page);
          if (secResult.error) {
            console.warn(`    Section ${section}: extractSectionPrices error:`, secResult.error);
          }

          const { totalListings: sectionListings, prices: sectionPrices } = secResult;
          const secSummary = summarizePrices(sectionPrices);
          if (!secSummary.floor) {
            console.log(`    Section ${section}: no valid prices`);
            continue;
          }

          console.log(`    Section ${section}: ${sectionListings} listings, floor $${secSummary.floor}, atp $${secSummary.avg}`);

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
            sectionFloor: secSummary.floor,
            sectionAvg: secSummary.avg,
            sectionCeiling: secSummary.ceiling,
            source: 'playwright+web_unlocker'
          });

          await randomDelay(SECTION_DELAY_MS, SECTION_DELAY_MS + 2000);
        } catch(e) {
          console.error(`    Section ${section} error:`, e.message);
        }
      }
    } else {
      console.log(`  Skipping section-level scraping (is_major=${isMajor}, sections found=${sectionNumbers.length})`);
    }
  } catch(e) {
    console.error(`  Error scraping event ${eventId}:`, e);
  }
}

async function main() {
  console.log('VKT Playwright scraper starting (with Web Unlocker)...');

  const events = await getEvents();
  console.log('Events to process:', events.length);

  if (!events.length) {
    console.log('No events found');
    return;
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  page.on('console', msg => {
    if (msg.type() === 'error') console.error('PAGE ERROR:', msg.text());
  });

  for (const event of events) {
    const eventId = event.id;
    console.log(`\n=== Scraping: ${event.name || eventId} (${eventId}) ===`);

    const recently = await scrapedRecently(eventId);
    if (recently) {
      console.log('  Skipping, scraped recently');
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
