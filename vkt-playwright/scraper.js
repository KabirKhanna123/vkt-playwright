const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { createClient } = require('@supabase/supabase-js');

chromium.use(StealthPlugin());

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://unypasitbzulafehbqtj.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVueXBhc2l0Ynp1bGFmZWhicXRqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUwMTE2MjAsImV4cCI6MjA5MDU4NzYyMH0.ywGB7ZccbVxcgZDXMOQB9Ui8R-SF4xF0SKkWavDbRGI';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function randomDelay(min, max) { return sleep(min + Math.random() * (max - min)); }

async function dismissModals(page) {
  for (const sel of ['button:has-text("Accept")','button:has-text("Continue")','button:has-text("Close")','button[aria-label="Close"]','[data-testid="close-button"]']) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({timeout:600})) { await el.click({timeout:800}); await page.waitForTimeout(400); }
    } catch(_) {}
  }
}

async function main() {
  console.log('VKT debug: find section ID mapping');

  const eventId = process.argv[2] || '160425611';

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-blink-features=AutomationControlled','--disable-dev-shm-usage','--no-first-run','--no-zygote','--disable-gpu','--window-size=1280,900']
  });

  const context = await browser.newContext({
    viewport: { width:1280, height:900 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' }
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US','en'] });
    window.chrome = { runtime: {} };
  });

  // Intercept all XHR/fetch requests to find section API calls
  const sectionRequests = [];
  context.on('request', request => {
    const url = request.url();
    if (url.includes('sections=') || url.includes('section') && url.includes(eventId)) {
      sectionRequests.push(url);
    }
  });

  const page = await context.newPage();

  try { await page.goto('https://www.google.com', { waitUntil:'domcontentloaded', timeout:10000 }); await randomDelay(1500,2500); } catch(_) {}

  const url = 'https://www.stubhub.com/event/'+eventId+'/?quantity=0';
  console.log('Loading:', url);
  await page.goto(url, { waitUntil:'domcontentloaded', timeout:30000 });
  await randomDelay(5000, 7000);
  await dismissModals(page);

  // Search all script tags for section ID mappings
  const sectionMapping = await page.evaluate(() => {
    const results = [];
    const scripts = Array.from(document.querySelectorAll('script'));
    for (const script of scripts) {
      const content = script.textContent || '';
      // Look for patterns like "sectionId":194578,"name":"129" or similar
      if (content.includes('194') && content.includes('section')) {
        // Try to find JSON with sectionId + name pairs
        const matches = [...content.matchAll(/"(?:sectionId|id)"\s*:\s*(\d{5,})[^}]*?"(?:name|sectionName|label)"\s*:\s*"([^"]+)"/g)];
        for (const m of matches) {
          results.push({ id: m[1], name: m[2], source: 'script' });
        }
        // Also try reversed
        const matches2 = [...content.matchAll(/"(?:name|sectionName|label)"\s*:\s*"([^"]+)"[^}]*?"(?:sectionId|id)"\s*:\s*(\d{5,})/g)];
        for (const m of matches2) {
          results.push({ id: m[2], name: m[1], source: 'script-rev' });
        }
      }
    }

    // Also check window.__NEXT_DATA__ or any global state
    const nextDataEl = document.querySelector('#__NEXT_DATA__');
    if (nextDataEl) {
      try {
        const parsed = JSON.parse(nextDataEl.textContent);
        const str = JSON.stringify(parsed);
        // Search for 6-digit IDs paired with section names
        const matches = [...str.matchAll(/"(?:sectionId|id)"\s*:\s*(\d{5,})[^}]{0,100}"(?:name|sectionName|label)"\s*:\s*"([^"]{1,20})"/g)];
        for (const m of matches) {
          results.push({ id: m[1], name: m[2], source: 'nextdata' });
        }
      } catch(_) {}
    }

    return results.slice(0, 50);
  });

  console.log('\n--- Section ID mappings found ---');
  if (sectionMapping.length === 0) {
    console.log('NONE FOUND in scripts');
  } else {
    sectionMapping.forEach(m => console.log(m.source+':', m.id, '->', m.name));
  }

  // Now intercept network: click a section on the map and capture the request
  console.log('\n--- Intercepted section requests ---');
  sectionRequests.forEach(r => console.log(r.slice(0, 200)));

  // Try clicking the first section on the map
  console.log('\nAttempting to click a map section...');
  try {
    // Find SVG elements with sprite-identifier
    const clicked = await page.evaluate(() => {
      const els = document.querySelectorAll('[sprite-identifier]');
      if (els.length > 0) {
        els[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return { clicked: true, id: els[0].getAttribute('sprite-identifier'), count: els.length };
      }
      return { clicked: false, count: 0 };
    });
    console.log('Click result:', JSON.stringify(clicked));
    await randomDelay(2000, 3000);
    console.log('Requests after click:', sectionRequests.slice(-5).map(r => r.slice(0, 200)).join('\n'));
  } catch(e) {
    console.log('Click failed:', e.message);
  }

  // Log current URL
  console.log('\nCurrent URL after interactions:', page.url());

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
