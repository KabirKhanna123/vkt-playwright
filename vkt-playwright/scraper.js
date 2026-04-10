const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_KEY');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(value) {
  if (!value) return null;
  const v = String(value).replace(/\s+/g, ' ').trim();
  return v || null;
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

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function buildVenueId(venueName) {
  const normalized = normalizeText(venueName);
  if (!normalized) return null;
  return `stubhub_${slugify(normalized)}`;
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
      if (await el.isVisible({ timeout: 700 })) {
        await el.click({ timeout: 1000 });
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

    return {
      h1: pickText(['h1']),
      ogTitle: pickAttr('meta[property="og:title"]', 'content'),
      title: document.title?.trim() || null,
      canonical: pickAttr('link[rel="canonical"]', 'href'),
      jsonLdName,
      jsonLdVenue,
      jsonLdDate,
      url: location.href,
    };
  });

  const candidates = [meta.h1, meta.ogTitle, meta.jsonLdName, meta.title]
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
    eventName: normalizeText(eventName),
    eventDate: meta.jsonLdDate || null,
    venue: normalizeText(meta.jsonLdVenue),
    canonical: meta.canonical || null,
    url: meta.url || null,
  };
}

async function getVenueMeta(page) {
  const venueMeta = await page.evaluate(() => {
    const text = document.body?.innerText || '';

    const getMeta = (selector, attr) => {
      const el = document.querySelector(selector);
      return el?.getAttribute?.(attr)?.trim() || null;
    };

    return {
      canonical: getMeta('link[rel="canonical"]', 'href'),
      bodyText: text,
    };
  });

  let venueName = null;

  if (venueMeta.bodyText) {
    const venuePatterns = [
      /\b([A-Z][A-Za-z0-9&'().\- ]{2,80})\n(?:[A-Z][a-z]+,\s+[A-Z]{2}|[A-Z][a-z]+,\s+[A-Za-z ]+)/,
      /\bVenue\s*\n?([A-Z][A-Za-z0-9&'().\- ]{2,80})/i,
    ];

    for (const pattern of venuePatterns) {
      const match = venueMeta.bodyText.match(pattern);
      if (match?.[1]) {
        venueName = match[1].trim();
        break;
      }
    }
  }

  return {
    venueName: normalizeText(venueName),
    canonical: venueMeta.canonical || null,
  };
}

async function saveEventMapping({
  stubhubEventId,
  eventName,
  eventDate,
  venueName,
  venueId,
}) {
  if (!stubhubEventId || !eventName) return;

  const payload = {
    id: String(stubhubEventId),
    name: eventName,
    date: eventDate || null,
    venue: venueName || null,
    platform: 'stubhub',
    venue_id: venueId || null,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from('events')
    .upsert(payload, { onConflict: 'id' });

  if (error) {
    console.error('Supabase event upsert error:', error.message);
  } else {
    console.log('Saved event:', payload);
  }
}

async function saveVenueSections(rows, venueId, venueName) {
  if (!Array.isArray(rows) || rows.length === 0) return;
  if (!venueId) return;

  const seen = new Set();

  const cleaned = rows
    .map((r) => {
      const zoneId = r.sectionsParam ? String(r.sectionsParam) : null;
      const sectionName = normalizeText(r.visibleSection);
      if (!zoneId) return null;

      const key = `${venueId}__${zoneId}`;
      if (seen.has(key)) return null;
      seen.add(key);

      return {
        venue_id: String(venueId),
        venue_name: venueName || null,
        zone_id: zoneId,
        section_name: sectionName,
      };
    })
    .filter(Boolean);

  if (cleaned.length === 0) return;

  const { error } = await supabase
    .from('venue_sections')
    .upsert(cleaned, { onConflict: 'venue_id,zone_id' });

  if (error) {
    console.error('Venue sections upsert error:', error.message);
  } else {
    console.log(`Saved ${cleaned.length} venue sections`);
  }
}

async function waitForSeatMap(page) {
  const selectors = [
    '[sprite-identifier]',
    'svg [sprite-identifier]',
    'svg',
  ];

  for (const sel of selectors) {
    try {
      await page.locator(sel).first().waitFor({ timeout: 5000 });
      return true;
    } catch (_) {}
  }

  return false;
}

async function scrollSeatMap(page) {
  for (let i = 0; i < 3; i++) {
    try {
      await page.mouse.wheel(0, 400);
      await page.waitForTimeout(400);
    } catch (_) {}
  }
}

async function extractSpriteInfo(page) {
  return await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('[sprite-identifier]'));

    return els
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);

        return {
          id: el.getAttribute('sprite-identifier'),
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2,
          width: rect.width,
          height: rect.height,
          visible:
            rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== 'hidden' &&
            style.display !== 'none',
        };
      })
      .filter((x) => x.id);
  });
}

async function extractSelectedSectionDetails(page) {
  return await page.evaluate(() => {
    const text = document.body?.innerText || '';

    const clean = (value) => {
      if (!value) return null;
      return value.replace(/\s+/g, ' ').trim();
    };

    const sectionMatch =
      text.match(/(?:^|\n)\s*Section\s+([A-Z0-9\-& ]{1,60})(?:\n|$)/im) ||
      text.match(/(?:^|\n)\s*Sec(?:tion)?\.?\s*([A-Z0-9\-& ]{1,60})(?:\n|$)/im);

    const rowMatch = text.match(
      /(?:^|\n)\s*Row\s+([A-Z0-9\-& ]{1,30})(?:\n|$)/im
    );

    const zoneMatch = text.match(
      /(?:^|\n)\s*Zone\s+([A-Z0-9\-& ]{1,60})(?:\n|$)/im
    );

    return {
      visibleSection: clean(sectionMatch?.[1] || null),
      visibleRow: clean(rowMatch?.[1] || null),
      visibleZone: clean(zoneMatch?.[1] || null),
    };
  });
}

async function safeClick(page, x, y) {
  try {
    await page.mouse.click(x, y, { delay: 50 });
    return true;
  } catch {
    return false;
  }
}

async function clickSpriteAndRead(page, sprite) {
  try {
    const clicked = await safeClick(page, sprite.x, sprite.y);
    if (!clicked) {
      return { spriteId: sprite.id, error: 'Mouse click failed' };
    }

    await page.waitForTimeout(1400);

    if (page.isClosed()) {
      return { spriteId: sprite.id, error: 'Page closed after click' };
    }

    const currentUrl = page.url();
    const parsed = new URL(currentUrl);
    const sectionsParam = parsed.searchParams.get('sections');
    const details = await extractSelectedSectionDetails(page);

    return {
      spriteId: sprite.id,
      sectionsParam: sectionsParam || null,
      visibleSection: details.visibleSection,
      visibleRow: details.visibleRow,
      visibleZone: details.visibleZone,
      clickedUrl: currentUrl,
    };
  } catch (error) {
    return {
      spriteId: sprite.id,
      error: error.message,
    };
  }
}

async function main() {
  console.log('Starting StubHub scraper');

  const eventId = process.argv[2];
  if (!eventId) {
    throw new Error('Usage: node scraper.js <stubhub_event_id>');
  }

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
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

  const page = await context.newPage();

  page.on('crash', () => {
    console.error('Playwright page crashed');
  });

  page.on('pageerror', (err) => {
    console.error('Page error:', err.message);
  });

  browser.on('disconnected', () => {
    console.error('Browser disconnected');
  });

  try {
    const url = `https://www.stubhub.com/event/${eventId}/?quantity=0`;
    console.log('Loading:', url);

    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });

    await page.waitForTimeout(5000);
    await dismissModals(page);

    const eventMeta = await extractEventMeta(page);
    const venueMeta = await getVenueMeta(page);

    const venueName = normalizeText(eventMeta.venue || venueMeta.venueName);
    const venueId = buildVenueId(venueName);

    console.log(
      JSON.stringify(
        {
          eventMeta,
          venueName,
          venueId,
        },
        null,
        2
      )
    );

    await saveEventMapping({
      stubhubEventId: eventId,
      eventName: eventMeta.eventName,
      eventDate: eventMeta.eventDate,
      venueName,
      venueId,
    });

    const seatMapReady = await waitForSeatMap(page);
    if (!seatMapReady) {
      console.log('Seat map not found; event was still saved');
      return;
    }

    await scrollSeatMap(page);

    const spriteInfo = await extractSpriteInfo(page);
    console.log(`Visible sprites found: ${spriteInfo.length}`);

    const sectionMap = [];

    for (const sprite of spriteInfo
      .filter((s) => s.visible && s.x > 0 && s.y > 0)
      .slice(0, 10)) {
      if (page.isClosed()) {
        console.log('Page closed, stopping section scraping');
        break;
      }

      console.log(`Clicking sprite ${sprite.id} at ${sprite.x}, ${sprite.y}`);
      const result = await clickSpriteAndRead(page, sprite);
      sectionMap.push(result);

      if (result.error) {
        console.log('Click failed:', result.error);
      } else {
        console.log('sections param:', result.sectionsParam);
        console.log('visible section:', result.visibleSection);
      }

      await page.waitForTimeout(800);
    }

    console.log(JSON.stringify(sectionMap, null, 2));
    await saveVenueSections(sectionMap, venueId, venueName);
  } finally {
    if (!page.isClosed()) {
      await page.close().catch(() => {});
    }
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
