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
  console.log('VKT debug: intercept API responses');

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

  const interestingResponses = [];

  // Intercept all responses and capture JSON ones that look relevant
  context.on('response', async response => {
    const url = response.url();
    const status = response.status();
    if (status !== 200) return;

    // Focus on StubHub/viagogo API calls
    if (!url.includes('stubhub') && !url.includes('viagogo') && !url.includes('103930817')) return;
    if (url.includes('.js') || url.includes('.css') || url.includes('.png') || url.includes('.pbf')) return;

    try {
      const text = await response.text();
      if (text.length < 50 || text.length > 500000) return;
      if (!text.startsWith('{') && !text.startsWith('[')) return;

      // Check if it contains section-related data
      if (text.includes('section') || text.includes('Section') || text.includes('listing')) {
        interestingResponses.push({
          url: url.slice(0, 150),
          size: text.length,
          sample: text.slice(0, 300)
        });
      }
    } catch(_) {}
  });

  const page = await context.newPage();

  try { await page.goto('https://www.google.com', { waitUntil:'domcontentloaded', timeout:10000 }); await randomDelay(1500,2500); } catch(_) {}

  const url = 'https://www.stubhub.com/event/'+eventId+'/?quantity=0';
  console.log('Loading:', url);
  await page.goto(url, { waitUntil:'networkidle', timeout:45000 });
  await randomDelay(3000, 5000);
  await dismissModals(page);

  console.log('\n--- Intercepted JSON API responses ---');
  if (interestingResponses.length === 0) {
    console.log('NONE FOUND');
  } else {
    interestingResponses.forEach((r, i) => {
      console.log('\n['+i+'] '+r.url);
      console.log('Size: '+r.size);
      console.log('Sample: '+r.sample);
    });
  }

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
