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
  console.log('VKT debug: click map and capture navigation');

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

  // Track all navigation/request URLs
  const capturedUrls = [];
  context.on('request', req => {
    const u = req.url();
    if (u.includes(eventId) && u.includes('section')) capturedUrls.push(u);
  });

  const page = await context.newPage();

  try { await page.goto('https://www.google.com', { waitUntil:'domcontentloaded', timeout:10000 }); await randomDelay(1500,2500); } catch(_) {}

  const url = 'https://www.stubhub.com/event/'+eventId+'/?quantity=0';
  console.log('Loading:', url);
  await page.goto(url, { waitUntil:'domcontentloaded', timeout:30000 });
  await randomDelay(6000, 8000);
  await dismissModals(page);

  // Get all sprite elements with their bounding boxes
  const spriteInfo = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('[sprite-identifier]'));
    return els.slice(0, 10).map(el => {
      const rect = el.getBoundingClientRect();
      return {
        id: el.getAttribute('sprite-identifier'),
        x: rect.x + rect.width/2,
        y: rect.y + rect.height/2,
        visible: rect.width > 0 && rect.height > 0
      };
    });
  });

  console.log('Sprite elements:', JSON.stringify(spriteInfo.slice(0, 5)));

  // Click each visible sprite using mouse coordinates and capture URL changes
  const sectionMap = [];
  for (const sprite of spriteInfo.filter(s => s.visible && s.x > 0 && s.y > 0).slice(0, 5)) {
    try {
      console.log('\nClicking sprite:', sprite.id, 'at', sprite.x, sprite.y);
      await page.mouse.click(sprite.x, sprite.y);
      await sleep(2000);

      const currentUrl = page.url();
      console.log('URL after click:', currentUrl);

      // Extract sections param from URL
      const sectionsParam = new URL(currentUrl).searchParams.get('sections');
      if (sectionsParam) {
        sectionMap.push({ spriteId: sprite.id, sectionsParam });
        console.log('  sections param:', sectionsParam);
      }

      // Also check innerText for section name
      const secText = await page.evaluate(() => {
        const bodyText = document.body?.innerText || '';
        const match = bodyText.match(/Section\s+(\d+)/i);
        return match ? match[0] : null;
      });
      if (secText) console.log('  section text on page:', secText);

    } catch(e) { console.log('Click failed:', e.message); }
  }

  console.log('\n--- Section ID map ---');
  sectionMap.forEach(m => console.log(m.spriteId, '->', m.sectionsParam));

  console.log('\n--- Captured section URLs ---');
  capturedUrls.forEach(u => console.log(u.slice(0, 200)));

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
