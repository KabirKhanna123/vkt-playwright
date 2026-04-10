const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { createClient } = require('@supabase/supabase-js');

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
  const valid = (prices||[]).map(safeNum).filter(v => v >= MIN_PRICE && v <= MAX_PRICE).sort((a,b) => a-b);
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
    if (!r.ok) { console.error('  Snapshot failed:', r.status, await r.text()); return false; }
    return true;
  } catch(e) { console.error('  Snapshot error:', e.message); return false; }
}

async function dismissModals(page) {
  for (const sel of ['button:has-text("Accept")','button:has-text("Continue")','button:has-text("Close")','button[aria-label="Close"]','[data-testid="close-button"]']) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({timeout:600})) { await el.click({timeout:800}); await page.waitForTimeout(400); }
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

    // Prices
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

    // Section numbers from map
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

      if (!/listings?/i.test(bodyText) && !/\$\s*[\d,]+/.test(bodyText)) {
        return { totalListings:0, prices:[], error:'no-listings-text' };
      }

      const listingMatches = [...bodyText.matchAll(/\b(\d[\d,]*)\s+listings?\b/gi)]
        .map(m => parseInt(m[1].replace(/,/g,''), 10))
        .filter(v => Number.isFinite(v) && v > 0);
      const totalListings = listingMatches.length ? Math.max(...listingMatches) : 0;

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
  const originalName = event.name || 'Event '+eventId;
  const isMajor = event.is_major === true;

  try {
    const url = 'https://www.stubhub.com/event/'+eventId+'/?quantity=0';
    await navigateTo(page, url);
    const data = await extractPageData(page);

    let name = data.name || originalName;
    if (name && name.toLowerCase().includes('tickets')) name = originalName;
    const venue = data.venue || event.venue || null;
    const date = normalizeDateString(data.date) || event.date || null;
    const { totalListings, prices, sectionNumbers } = data;

    const summary = summarizePrices(prices);
    if (!summary.floor) { console.log('  No pricing for '+name); return null; }

    console.log('  '+name+' | '+date+' | '+venue);
    console.log('  '+totalListings+' listings, floor $'+summary.floor+', atp $'+summary.avg+(isMajor?' [MAJOR]':''));

    await postSnapshot({
      eventId, eventName:name, eventDate:date, venue, platform:'StubHub',
      totalListings, section:null, sectionListings:0,
      eventFloor:summary.floor, eventAvg:summary.avg, eventCeiling:summary.ceiling,
      source:'playwright'
    });

    const updates = {};
    if (name !== originalName) updates.name = name;
    if (venue && venue !== event.venue) updates.venue = venue;
    if (date && date !== event.date) updates.date = date;
    if (Object.keys(updates).length) await supabase.from('events').update(updates).eq('id', eventId);

    // Section scraping for major events
    if (isMajor && sectionNumbers.length > 0) {
      console.log('  Scraping '+sectionNumbers.length+' sections...');
      let postedSections = 0;

      for (const secNum of sectionNumbers) {
        let secPage = null;
        try {
          secPage = await page.context().newPage();

          // Forward console logs from section page
          secPage.on('console', msg => { if (msg.type() === 'error') console.log('  PAGE ERR:', msg.text()); });

          const secUrl = `https://www.stubhub.com/event/${eventId}/?sections=${secNum}&quantity=0`;
          await navigateTo(secPage, secUrl, SECTION_DELAY_MS);

          // Wait for page to settle
          await Promise.race([
            secPage.waitForFunction(() => /listings?/i.test(document.body?.innerText||''), {timeout:8000}).catch(()=>{}),
            sleep(8000)
          ]);

          const secResult = await extractSectionPrices(secPage);

          if (secResult.error) {
            console.log('    Section '+secNum+': error — '+secResult.error);
            continue;
          }

          const { totalListings: secTotal, prices: secPrices } = secResult;
          const secSummary = summarizePrices(secPrices);

          if (!secTotal && !secSummary.floor) {
            console.log('    Section '+secNum+': no data');
            continue;
          }
          if (!secSummary.floor) {
            console.log('    Section '+secNum+': '+secTotal+' listings, no valid prices');
            continue;
          }

          const ok = await postSnapshot({
            eventId, eventName:name, eventDate:date, venue, platform:'StubHub',
            totalListings:0, section:'Section '+secNum, sectionListings:secTotal,
            sectionFloor:secSummary.floor, sectionAvg:secSummary.avg, sectionCeiling:secSummary.ceiling,
            eventFloor:summary.floor, eventAvg:summary.avg, eventCeiling:summary.ceiling,
            source:'playwright'
          });

          if (ok) {
            postedSections++;
            console.log('    Section '+secNum+': '+secTotal+' listings, floor $'+secSummary.floor);
          }

          await randomDelay(SECTION_DELAY_MS, SECTION_DELAY_MS + 2000);
        } catch(e) {
          console.error('    Section '+secNum+' failed:', e.message);
        } finally {
          if (secPage) { try { await secPage.close(); } catch(_) {} }
        }
      }
      console.log('  Sections posted: '+postedSections+'/'+sectionNumbers.length);
    }

    return { ok:true };

  } catch(e) { console.error('  Failed '+eventId+':', e.message); return null; }
}

async function main() {
  console.log('VKT Playwright scraper starting...');

  const manualId = process.argv[2];
  let events = manualId
    ? [{ id:manualId, name:'Manual', date:null, venue:null, platform:'StubHub', is_major:true }]
    : await getEvents();
  console.log('Events to process: '+events.length);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-blink-features=AutomationControlled','--disable-dev-shm-usage','--disable-accelerated-2d-canvas','--no-first-run','--no-zygote','--disable-gpu','--window-size=1280,900']
  });

  const context = await browser.newContext({
    viewport: { width:1280, height:900 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
    }
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US','en'] });
    window.chrome = { runtime: {} };
  });

  const page = await context.newPage();

  try {
    await page.goto('https://www.google.com', { waitUntil:'domcontentloaded', timeout:10000 });
    await randomDelay(1500, 3000);
  } catch(_) {}

  let scraped=0, skipped=0, failed=0;

  for (const event of events) {
    if (!manualId) {
      const recent = await scrapedRecently(event.id);
      if (recent) { console.log('Skipping '+event.name+' (recent)'); skipped++; continue; }
    }
    console.log('\nScraping: '+event.name+' ('+event.id+')');
    const result = await scrapeEvent(page, event);
    if (result) scraped++; else failed++;
    await randomDelay(SCRAPE_DELAY_MS, SCRAPE_DELAY_MS + 3000);
  }

  await browser.close();
  console.log('\nDone — scraped:'+scraped+' skipped:'+skipped+' failed:'+failed);
}

main().catch(e => { console.error(e); process.exit(1); });
