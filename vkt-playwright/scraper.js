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

async function scrollToLoadListings(page) {
  // Scroll down gradually to trigger lazy loading of listing cards
  await page.evaluate(async () => {
    await new Promise(resolve => {
      let total = 0;
      const distance = 400;
      const delay = 300;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        total += distance;
        if (total >= 5000) { clearInterval(timer); resolve(); }
      }, delay);
    });
  });
  await randomDelay(2000, 3000);
  // Scroll back to top
  await page.evaluate(() => window.scrollTo(0, 0));
  await randomDelay(500, 1000);
}

async function main() {
  console.log('VKT debug: section extraction with scroll');

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
  await randomDelay(4000, 5000);
  await dismissModals(page);

  console.log('Scrolling to load listings...');
  await scrollToLoadListings(page);

  const debug = await page.evaluate(() => {
    const bodyText = document.body?.innerText || '';
    const lines = bodyText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    const sectionLines = lines.filter(l => /section/i.test(l));
    const first30Lines = lines.slice(0, 30);

    // TreeWalker for section nodes
    const sectionNodes = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent?.trim();
      if (text && /section/i.test(text) && text.length < 60) {
        const style = window.getComputedStyle(node.parentElement);
        sectionNodes.push({
          text,
          tag: node.parentElement?.tagName,
          visible: style.display !== 'none' && style.visibility !== 'hidden'
        });
      }
    }

    return { first30Lines, sectionLines: sectionLines.slice(0, 30), sectionNodes: sectionNodes.slice(0, 30) };
  });

  console.log('\n--- First 30 lines of innerText ---');
  debug.first30Lines.forEach(l => console.log(l));

  console.log('\n--- Lines containing "section" ---');
  if (debug.sectionLines.length === 0) console.log('NONE FOUND');
  debug.sectionLines.forEach(l => console.log(l));

  console.log('\n--- TreeWalker nodes with "section" ---');
  if (debug.sectionNodes.length === 0) console.log('NONE FOUND');
  debug.sectionNodes.forEach(m => console.log(m.tag+'|visible:'+m.visible+'|'+m.text));

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
