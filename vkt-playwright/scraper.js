const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { createClient } = require('@supabase/supabase-js');

chromium.use(StealthPlugin());

const BRIGHTDATA_API_TOKEN = process.env.BRIGHTDATA_API_TOKEN || 'ac7d557e-67eb-4e04-90ef-56b1db829ab7';
const WEB_UNLOCKER_ZONE = process.env.WEB_UNLOCKER_ZONE || 'web_unlocker1';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://unypasitbzulafehbqtj.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVueXBhc2l0Ynp1bGFmZWhicXRqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUwMTE2MjAsImV4cCI6MjA5MDU4NzYyMH0.ywGB7ZccbVxcgZDXMOQB9Ui8R-SF4xF0SKkWavDbRGI';
const VKT_API = process.env.VKT_API || 'https://vkt-volume-api.vercel.app';

const SCRAPE_DELAY_MS = parseInt(process.env.SCRAPE_DELAY_MS || '5000', 10);
const SECTION_DELAY_MS = parseInt(process.env.SECTION_DELAY_MS || '3000', 10);
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

async function fetchWithWebUnlocker(targetUrl) {
  console.log('  Fetching:', targetUrl);
  const res = await fetch('https://api.brightdata.com/request', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + BRIGHTDATA_API_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      zone: WEB_UNLOCKER_ZONE,
      url: targetUrl,
      format: 'raw'
    })
  });

  const text = await res.text();
  if (!res.ok) {
    console.error('  Web Unlocker error:', res.status, text.slice(0, 200));
    return null;
  }

  try {
    const json = JSON.parse(text);
    const html = json.body || json.html || json.content || null;
    console.log('  HTML length:', html ? html.length : 0);
    return html;
  } catch(_) {
    // Response may be raw HTML directly
    console.log('  Raw HTML length:', text.length);
    return text;
  }
}

async function dismissModals(page) {
  for (const sel of ['button:has-text("Accept")','button:has-text("Continue")','button:has-text("Close")','button[aria-label="Close"]']) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({timeout:500})) { await el.click({timeout:700}); await page.waitForTimeout(300); }
    } catch(_) {}
  }
}

async function extractPageData(page) {
  return await page.evaluate(({minPrice, maxPrice}) => {
    let name = null, date = null, venue = null;

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

      // Section-specific count: "Section 120 | 3 listings"
      const secHeaderMatch = bodyText.match(/Section\s+[\w\d]+\s*\|\s*(\d[\d,]*)\s+listings?/i);
      let totalListings = secHeaderMatch ? parseInt(secHeaderMatch[1].replace(/,/g,''), 10) : 0;

      // Fallback: smallest listings number under 500
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
  const originalName = event.name || 'Event '+eventId;
  const isMajor = event.is_major === true;

  try {
    const url = 'https://www.stubhub.com/event/'+eventId+'/?quantity=0';
    const html = await fetchWithWebUnlocker(url);
    if (!html || html.length < 5000) { console.log('  No HTML for '+eventId); return null; }

    await page.setContent(html, { waitUntil:'domcontentloaded' });
    await dismissModals(page);

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
      source:'brightdata'
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
        try {
          const secUrl = `https://www.stubhub.com/event/${eventId}/?sections=${secNum}&quantity=0`;
          const secHtml = await fetchWithWebUnlocker(secUrl);
          if (!secHtml || secHtml.length < 5000) {
            console.log('    Section '+secNum+': no HTML');
            continue;
          }

          await page.setContent(secHtml, { waitUntil:'domcontentloaded' });
          await dismissModals(page);

          const secResult = await extractSectionPrices(page);
          if (secResult.error) {
            console.log('    Section '+secNum+': error — '+secResult.error);
            continue;
          }

          const { totalListings: secTotal, prices: secPrices } = secResult;
          const secSummary = summarizePrices(secPrices);

          if (!secSummary.floor) {
            console.log('    Section '+secNum+': no valid prices');
            continue;
          }

          const ok = await postSnapshot({
            eventId, eventName:name, eventDate:date, venue, platform:'StubHub',
            totalListings:0, section:'Section '+secNum, sectionListings:secTotal,
            sectionFloor:secSummary.floor, sectionAvg:secSummary.avg, sectionCeiling:secSummary.ceiling,
            eventFloor:summary.floor, eventAvg:summary.avg, eventCeiling:summary.ceiling,
            source:'brightdata'
          });

          if (ok) {
            postedSections++;
            console.log('    Section '+secNum+': '+secTotal+' listings, floor $'+secSummary.floor);
          }

          await randomDelay(SECTION_DELAY_MS, SECTION_DELAY_MS + 1500);
        } catch(e) {
          console.error('    Section '+secNum+' failed:', e.message);
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
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--no-first-run','--no-zygote','--disable-gpu']
  });

  const context = await browser.newContext({
    viewport: { width:1280, height:900 },
    locale: 'en-US',
    timezoneId: 'America/New_York'
  });

  const page = await context.newPage();

  let scraped=0, skipped=0, failed=0;

  for (const event of events) {
    if (!manualId) {
      const recent = await scrapedRecently(event.id);
      if (recent) { console.log('Skipping '+event.name+' (recent)'); skipped++; continue; }
    }
    console.log('\nScraping: '+event.name+' ('+event.id+')');
    const result = await scrapeEvent(page, event);
    if (result) scraped++; else failed++;
    await randomDelay(SCRAPE_DELAY_MS, SCRAPE_DELAY_MS + 2000);
  }

  await browser.close();
  console.log('\nDone — scraped:'+scraped+' skipped:'+skipped+' failed:'+failed);
}

main().catch(e => { console.error(e); process.exit(1); });
