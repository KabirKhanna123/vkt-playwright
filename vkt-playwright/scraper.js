const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { createClient } = require('@supabase/supabase-js');

chromium.use(StealthPlugin());

const SUPABASE_URL =
  process.env.SUPABASE_URL || 'https://unypasitbzulafehbqtj.supabase.co';
const SUPABASE_KEY =
  process.env.SUPABASE_KEY ||
  'YOUR_SUPABASE_KEY_HERE';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(min, max) {
  return sleep(min + Math.random() * (max - min));
}

function cleanTitle(text) {
  if (!text || typeof text !== 'string') return null;

  return text
    .replace(/\s+/g, ' ')
    .replace(/\s+\|\s+StubHub.*$/i, '')
    .replace(/\s*-\s*StubHub.*$/i, '')
    .replace(/\s*Tickets\s*$/i, '')
    .trim();
}

function slugToTitle(slug) {
  if (!slug) return null;

  return slug
    .replace(/-tickets?$/i, '')
    .replace(/\/+$/, '')
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
    .trim();
}

async function dismissModals(page) {
  const selectors = [
    'button:has-text("Accept")',
    'button:has-text("Continue")',
    'button:has-text("Close")',
    'button[aria-label="Close"]',
    '[data-testid="close-button"]',
  ];

  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 600 })) {
        await el.click({ timeout: 800 });
        await page.waitForTimeout(400);
      }
    } catch (_) {}
  }
}

async function extractEventMeta(page) {
  const meta = await page.evaluate(() => {
    const pickText = (selectors) => {
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        const txt = el?.textContent?.trim();
        if (txt) return txt;
      }
      return null;
    };

    const pickAttr = (selector, attr) => {
      const el = document.querySelector(selector);
      const val = el?.getAttribute?.(attr);
      return val ? val.trim() : null;
    };

    const parseJsonLdBlocks = () => {
      const blocks = Array.from(
        document.querySelectorAll('script[type="application/ld+json"]')
      );

      const results = [];

      for (const block of blocks) {
        const raw = block.textContent?.trim();
        if (!raw) continue;

        try {
          const parsed = JSON.parse(raw);

          const items = Array.isArray(parsed) ? parsed : [parsed];
          for (const item of items) {
            if (item) results.push(item);
          }
        } catch (_) {}
      }

      return results;
    };

    const jsonLdBlocks = parseJsonLdBlocks();

    let jsonLdName = null;
    let jsonLdVenue = null;
    let jsonLdDate = null;

    for (const item of jsonLdBlocks) {
      if (!jsonLdName && item?.name) jsonLdName = item.name;
      if (!jsonLdDate && (item?.startDate || item?.eventStartDate)) {
        jsonLdDate = item.startDate || item.eventStartDate;
      }

      const venueName =
        item?.location?.name ||
        item?.location?.[0]?.name ||
        item?.offers?.itemOffered?.location?.name;

      if (!jsonLdVenue && venueName) jsonLdVenue = venueName;
    }

    const h1 = pickText(['h1']);
    const ogTitle = pickAttr('meta[property="og:title"]', 'content');
    const title = document.title?.trim() || null;
    const canonical = pickAttr('link[rel="canonical"]', 'href');

    const venue =
      pickAttr('meta[property="og:site_name"]', 'content') || jsonLdVenue;

    return {
      h1,
      ogTitle,
      title,
      canonical,
      jsonLdName,
      jsonLdVenue,
      jsonLdDate,
      venue,
      url: location.href,
    };
  });

  const candidates = [
    meta.h1,
    meta.ogTitle,
    meta.jsonLdName,
    meta.title,
  ]
    .map(cleanTitle)
    .filter(Boolean);

  let eventName = candidates[0] || null;

  if (!eventName) {
    const sourceUrl = meta.canonical || meta.url || '';
    const match = sourceUrl.match(/stubhub\.com\/([^/]+)\/event\/\d+/i);
    if (match?.[1]) {
      eventName = slugToTitle(match[1]);
    }
  }

  return {
    eventName,
    eventDate: meta.jsonLdDate || null,
    venue: meta.jsonLdVenue || meta.venue || null,
    canonical: meta.canonical || null,
    url: meta.url || null,
    raw: meta,
  };
}

async function saveEventMapping({
  stubhubEventId,
  eventName,
  eventDate,
  venue,
  sourceUrl,
}) {
  if (!stubhubEventId || !eventName) return;

  // Change table/column names to match your DB schema.
  const payload = {
    stubhub_event_id: String(stubhubEventId),
    event_name: eventName,
    event_date: eventDate,
    venue: venue,
    source_url: sourceUrl,
    last_verified_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from('stubhub_event_map')
    .upsert(payload, { onConflict: 'stubhub_event_id' });

  if (error) {
    console.error('Supabase upsert error:', error.message);
  } else {
    console.log('Saved event mapping:', payload);
  }
}

async function main() {
  console.log('VKT debug: click map and capture navigation');

  const eventId = process.argv[2] || '160425611';

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--window-size=1280,900',
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    });
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
    });
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    });
    window.chrome = { runtime: {} };
  });

  const capturedUrls = [];
  context.on('request', (req) => {
    const u = req.url();
    if (u.includes(eventId) && u.includes('section')) {
      capturedUrls.push(u);
    }
  });

  const page = await context.newPage();

  try {
    await page.goto('https://www.google.com', {
      waitUntil: 'domcontentloaded',
      timeout: 10000,
    });
    await randomDelay(1500, 2500);
  } catch (_) {}

  const url = `https://www.stubhub.com/event/${eventId}/?quantity=0`;
  console.log('Loading:', url);

  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });

  await randomDelay(6000, 8000);
  await dismissModals(page);

  // Extract the real event metadata from the rendered page.
  const eventMeta = await extractEventMeta(page);
  console.log('\n--- Event Meta ---');
  console.log(JSON.stringify(eventMeta, null, 2));

  // Save mapping if you want it in Supabase.
  await saveEventMapping({
    stubhubEventId: eventId,
    eventName: eventMeta.eventName,
    eventDate: eventMeta.eventDate,
    venue: eventMeta.venue,
    sourceUrl: eventMeta.canonical || eventMeta.url,
  });

  // Existing sprite capture logic
  const spriteInfo = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('[sprite-identifier]'));
    return els.slice(0, 10).map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        id: el.getAttribute('sprite-identifier'),
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
        visible: rect.width > 0 && rect.height > 0,
      };
    });
  });

  console.log('\nSprite elements:', JSON.stringify(spriteInfo.slice(0, 5)));

  const sectionMap = [];
  for (const sprite of spriteInfo
    .filter((s) => s.visible && s.x > 0 && s.y > 0)
    .slice(0, 5)) {
    try {
      console.log('\nClicking sprite:', sprite.id, 'at', sprite.x, sprite.y);
      await page.mouse.click(sprite.x, sprite.y);
      await sleep(2000);

      const currentUrl = page.url();
      console.log('URL after click:', currentUrl);

      const sectionsParam = new URL(currentUrl).searchParams.get('sections');
      if (sectionsParam) {
        sectionMap.push({ spriteId: sprite.id, sectionsParam });
        console.log('  sections param:', sectionsParam);
      }

      const secText = await page.evaluate(() => {
        const bodyText = document.body?.innerText || '';
        const match = bodyText.match(/Section\s+([A-Z0-9-]+)/i);
        return match ? match[0] : null;
      });

      if (secText) {
        console.log('  section text on page:', secText);
      }
    } catch (e) {
      console.log('Click failed:', e.message);
    }
  }

  console.log('\n--- Section ID map ---');
  sectionMap.forEach((m) => console.log(m.spriteId, '->', m.sectionsParam));

  console.log('\n--- Captured section URLs ---');
  capturedUrls.forEach((u) => console.log(u.slice(0, 200)));

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
