const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { createClient } = require('@supabase/supabase-js');

chromium.use(StealthPlugin());

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://unypasitbzulafehbqtj.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVueXBhc2l0Ynp1bGFmZWhicXRqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUwMTE2MjAsImV4cCI6MjA5MDU4NzYyMH0.ywGB7ZccbVxcgZDXMOQB9Ui8R-SF4xF0SKkWavDbRGI';
const VKT_API = process.env.VKT_API || 'https://vkt-volume-api.vercel.app';

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
  console.log('VKT debug: section extraction');

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

  const page = await context.newPage();

  try { await page.goto('https://www.google.com', { waitUntil:'domcontentloaded', timeout:10000 }); await randomDelay(1500,2500); } catch(_) {}

  const url = 'https://www.stubhub.com/event/'+eventId+'/?quantity=0';
  console.log('Loading:', url);
  await page.goto(url, { waitUntil:'domcontentloaded', timeout:30000 });
  await randomDelay(5000, 7000);
  await dismissModals(page);

  // Wait for listings to appear
  try { await page.waitForSelector('text=/Section \\d+/i', { timeout:8000 }); } catch(_) { console.log('Selector wait timed out'); }

  const debug = await page.evaluate(() => {
    const results = {
      innerTextSample: [],
      sectionMatches: [],
      allTextWithSection: []
    };

    // 1. Scan innerText for "Section"
    const bodyText = document.body?.innerText || '';
    const lines = bodyText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    for (const line of lines) {
      if (/section/i.test(line)) {
        results.allTextWithSection.push(line.slice(0, 100));
      }
    }

    // 2. TreeWalker scan
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent?.trim();
      if (text && /section/i.test(text)) {
        results.sectionMatches.push({
          text: text.slice(0, 80),
          tag: node.parentElement?.tagName,
          visible: window.getComputedStyle(node.parentElement).display !== 'none'
        });
      }
    }

    // 3. Sample first 20 lines of innerText
    results.innerTextSample = lines.slice(0, 20);

    return results;
  });

  console.log('\n--- innerText first 20 lines ---');
  debug.innerTextSample.forEach(l => console.log(l));

  console.log('\n--- All text containing "section" ---');
  debug.allTextWithSection.slice(0, 30).forEach(l => console.log(l));

  console.log('\n--- TreeWalker nodes containing "section" ---');
  debug.sectionMatches.slice(0, 20).forEach(m => console.log(m.tag, '|', m.visible, '|', m.text));

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
