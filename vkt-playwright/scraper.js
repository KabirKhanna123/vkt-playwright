const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://unypasitbzulafehbqtj.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVueXBhc2l0Ynp1bGFmZWhicXRqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUwMTE2MjAsImV4cCI6MjA5MDU4NzYyMH0.ywGB7ZccbVxcgZDXMOQB9Ui8R-SF4xF0SKkWavDbRGI';
const VKT_API = process.env.VKT_API || 'https://vkt-volume-api.vercel.app';

const SCRAPE_DELAY_MS = parseInt(process.env.SCRAPE_DELAY_MS || '5000', 10);
const SECTION_DELAY_MS = parseInt(process.env.SECTION_DELAY_MS || '2500', 10);
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
  return { floor:valid[0], avg:Math.round(valid.reduce((a,b)=>a+b,0)/valid.length), ceiling:valid[valid.length-1] };
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

async function dismissModals(page) {
  for (const sel of ['button:has-text("Continue")','button:has-text("Close")','button[aria-label="Close"]','[data-testid="close-button"]']) {
    try { const el = page.locator(sel).first(); if (await el.isVisible({timeout:800})) { await el.click({timeout:1000}); await page.waitForTimeout(500); } } catch(_) {}
  }
}

async function extractJsonLdEvent(page) {
  try {
    return await page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
      for (const script of scripts) {
        try {
          const parsed = JSON.parse(script.textContent);
          const items = Array.isArray(parsed) ? parsed : [parsed];
          for (const item of items) {
            if (!item || typeof item !== 'object') continue;
            if (item['@type'] !== 'Event' && item['@type'] !== 'SportsEvent') continue;
            let venue = null;
            const location = item.location || null;
            if (location?.name) {
              const city = location.address?.addressLocality || '';
              const state = location.address?.addressRegion || '';
              venue = [location.name, city, state].filter(Boolean).join(', ');
            }
            return { name: item.name || null, date: item.startDate || null, venue: venue || null };
          }
        } catch(_) {}
      }
      return null;
    });
  } catch(_) { return null; }
}

async function extractNextDataEvent(page) {
  try {
    return await page.evaluate(() => {
      const el = document.querySelector('#__NEXT_DATA__');
      if (!el?.textContent) return null;
      let parsed;
      try { parsed = JSON.parse(el.textContent); } catch(_) { return null; }
      let best = { name:null, date:null, venue:null };
      function walk(obj) {
        if (!obj || typeof obj !== 'object') return;
        if (!best.name && typeof obj.name === 'string' && !obj.name.toLowerCase().includes('tickets') && obj.name.length < 200) best.name = obj.name.trim();
        if (!best.date && typeof obj.startDate === 'string') best.date = obj.startDate;
        if (!best.date && typeof obj.date === 'string') best.date = obj.date;
        if (!best.venue) {
          if (typeof obj.venueName === 'string') best.venue = obj.venueName.trim();
          else if (obj.venue && typeof obj.venue.name === 'string') {
            const city = obj.venue.city?.name || obj.venue.city || '';
            const state = obj.venue.state?.stateCode || obj.venue.state || '';
            best.venue = [obj.venue.name, city, state].filter(Boolean).join(', ');
          } else if (typeof obj.locationName === 'string') best.venue = obj.locationName.trim();
        }
        for (const key of Object.keys(obj)) { const val = obj[key]; if (val && typeof val === 'object') walk(val); }
      }
      walk(parsed);
      return best;
    });
  } catch(_) { return null; }
}

async function extractEventPageDetails(page) {
  const jsonLd = await extractJsonLdEvent(page);
  const nextData = await extractNextDataEvent(page);
  let name = jsonLd?.name || nextData?.name || null;
  let venue = jsonLd?.venue || nextData?.venue || null;
  let date = normalizeDateString(jsonLd?.date) || normalizeDateString(nextData?.date) || null;
  if (name && name.toLowerCase().includes('tickets')) name = null;
  return { name: name||null, venue: venue||null, date: date||null };
}

async function extractListingsAndPrices(page) {
  return await page.evaluate(() => {
    const bodyText = document.body?.innerText || '';
    const listingMatches = [...bodyText.matchAll(/(\d[\d,]*)\s+listings?/gi)].map(m => parseInt(m[1].replace(/,/g,''),10)).filter(v => Number.isFinite(v) && v >= 0);
    const totalListings = listingMatches.length ? Math.max(...listingMatches) : 0;
    const prices = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!node.parentElement) continue;
      if (node.parentElement.closest('script,style,noscript,svg')) continue;
      const style = window.getComputedStyle(node.parentElement);
      if (style.display==='none' || style.visibility==='hidden') continue;
      for (const match of node.textContent.matchAll(/\$\s*([\d,]+(?:\.\d{2})?)/g)) {
        const value = parseFloat(match[1].replace(/,/g,''));
        if (Number.isFinite(value) && value >= 1 && value <= 25000) prices.push(value);
      }
    }
    prices.sort((a,b)=>a-b);
    return { totalListings, prices };
  });
}

async function getSectionIds(page) {
  try {
    return await page.evaluate(() => {
      const ids = [], seen = new Set();
      document.querySelectorAll('[sprite-identifier]').forEach(el => {
        const value = el.getAttribute('sprite-identifier');
        if (value && /^s\d+$/i.test(value) && !seen.has(value)) { seen.add(value); ids.push(value.replace(/^s/i,'')); }
      });
      return ids;
    });
  } catch(_) { return []; }
}

async function getSectionName(page, sectionId) {
  try {
    const name = await page.evaluate((sid) => {
      const el = document.querySelector('[sprite-identifier="s'+sid+'"]');
      if (!el) return null;
      const direct = el.getAttribute('aria-label') || el.getAttribute('data-section-name') || el.getAttribute('title');
      if (direct && direct.trim()) return direct.trim();
      const parent = el.closest('g');
      if (parent) { const t = parent.querySelector('text'); if (t?.textContent?.trim()) return t.textContent.trim(); }
      return null;
    }, sectionId);
    return name || 'Section '+sectionId;
  } catch(_) { return 'Section '+sectionId; }
}

async function scrapeEvent(page, event) {
  const eventId = event.id;
  const originalName = event.name || 'Event '+eventId;

  try {
    const url = 'https://www.stubhub.com/event/'+eventId+'/?quantity=0';
    await page.goto(url, { waitUntil:'domcontentloaded', timeout:30000 });
    await page.waitForTimeout(3500);
    await dismissModals(page);

    const details = await extractEventPageDetails(page);
    let name = details.name || originalName;
    if (name && name.toLowerCase().includes('tickets')) name = originalName;

    const venue = details.venue || event.venue || null;
    const date = details.date || event.date || null;

    const { totalListings, prices } = await extractListingsAndPrices(page);
    const summary = summarizePrices(prices);

    if (!summary.floor) { console.log('  No pricing for '+name); return null; }

    console.log('  '+name+': '+totalListings+' listings, floor $'+summary.floor+', atp $'+summary.avg);

    await postSnapshot({
      eventId, eventName:name, eventDate:date, venue, platform:'StubHub',
      totalListings, section:null, sectionListings:0,
      eventFloor:summary.floor, eventAvg:summary.avg, eventCeiling:summary.ceiling,
      source:'playwright'
    });

    // Update event record with better data
    const updates = {};
    if (name !== originalName) updates.name = name;
    if (venue && venue !== event.venue) updates.venue = venue;
    if (date && date !== event.date) updates.date = date;
    if (Object.keys(updates).length) await supabase.from('events').update(updates).eq('id',eventId);

    // Scrape sections
    const sectionIds = await getSectionIds(page);
    console.log('  '+sectionIds.length+' sections found');
    let postedSections = 0;

    for (const sectionId of sectionIds) {
      try {
        const sectionName = await getSectionName(page, sectionId);
        const secUrl = 'https://www.stubhub.com/event/'+eventId+'/?sections='+sectionId+'&quantity=0';
        await page.goto(secUrl, { waitUntil:'domcontentloaded', timeout:20000 });
        await page.waitForTimeout(SECTION_DELAY_MS);

        const { totalListings:secTotal, prices:secPrices } = await extractListingsAndPrices(page);
        if (secTotal === 0 || secTotal === totalListings) continue;

        const secSummary = summarizePrices(secPrices);
        if (!secSummary.floor) continue;

        const ok = await postSnapshot({
          eventId, eventName:name, eventDate:date, venue, platform:'StubHub',
          totalListings:0, section:sectionName, sectionListings:secTotal,
          sectionFloor:secSummary.floor, sectionAvg:secSummary.avg, sectionCeiling:secSummary.ceiling,
          eventFloor:summary.floor, eventAvg:summary.avg, eventCeiling:summary.ceiling,
          source:'playwright'
        });
        if (ok) postedSections++;
        await sleep(700);
      } catch(e) { continue; }
    }

    console.log('  Posted '+postedSections+'/'+sectionIds.length+' sections');
    return { ok:true, sections:sectionIds.length, postedSections };

  } catch(e) { console.error('  Failed '+eventId+':', e.message); return null; }
}

async function main() {
  console.log('VKT Playwright scraper starting...');

  const manualId = process.argv[2];
  let events = manualId ? [{ id:manualId, name:'Manual', date:null, venue:null, platform:'StubHub' }] : await getEvents();
  console.log('Events to process: '+events.length);

  const PROXY_HOST = process.env.PROXY_HOST || 'gate.decodo.com';
  const PROXY_PORT = process.env.PROXY_PORT || '443';
  const PROXY_USER = process.env.PROXY_USER || 'sp1byj77dj';
  const PROXY_PASS = process.env.PROXY_PASS || 'Fqp6I_qj0derv1Um6K';

  const browser = await chromium.launch({
    headless: true,
    proxy: {
      server: 'http://' + PROXY_HOST + ':' + PROXY_PORT,
      username: PROXY_USER,
      password: PROXY_PASS
    },
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-blink-features=AutomationControlled','--disable-dev-shm-usage','--window-size=1280,900']
  });

  const context = await browser.newContext({
    viewport: {width:1280,height:900},
    locale: 'en-US',
    timezoneId: 'America/New_York',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();
  await page.addInitScript(() => { Object.defineProperty(navigator,'webdriver',{get:()=>undefined}); window.chrome={runtime:{}}; });

  let scraped=0, skipped=0, failed=0;

  for (const event of events) {
    if (!manualId) {
      const recent = await scrapedRecently(event.id);
      if (recent) { console.log('Skipping '+event.name+' (recent)'); skipped++; continue; }
    }
    console.log('\nScraping: '+event.name+' ('+event.id+')');
    const result = await scrapeEvent(page, event);
    if (result) scraped++; else failed++;
    await sleep(SCRAPE_DELAY_MS);
  }

  await browser.close();
  console.log('\nDone — scraped:'+scraped+' skipped:'+skipped+' failed:'+failed);
}

main().catch(e => { console.error(e); process.exit(1); });
