const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://unypasitbzulafehbqtj.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'YOUR_SUPABASE_KEY';
const VKT_API = process.env.VKT_API || 'https://vkt-volume-api.vercel.app';

const SCRAPE_DELAY_MS = parseInt(process.env.SCRAPE_DELAY_MS || '5000', 10);
const SECTION_DELAY_MS = parseInt(process.env.SECTION_DELAY_MS || '2500', 10);
const RECENT_HOURS = parseInt(process.env.RECENT_HOURS || '20', 10);
const EVENT_LIMIT = parseInt(process.env.EVENT_LIMIT || '200', 10);

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function normalizeDateString(value) {
  if (!value) return null;

  const s = String(value).trim();

  const isoMatch = s.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoMatch) return isoMatch[1];

  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  return null;
}

function summarizePrices(prices) {
  const valid = (prices || [])
    .map(safeNum)
    .filter(v => v > 0 && v < 25000)
    .sort((a, b) => a - b);

  if (!valid.length) {
    return { floor: null, avg: null, ceiling: null };
  }

  return {
    floor: valid[0],
    avg: Math.round(valid.reduce((a, b) => a + b, 0) / valid.length),
    ceiling: valid[valid.length - 1]
  };
}

async function getEvents() {
  const { data, error } = await supabase
    .from('events')
    .select('id, name, date, venue, platform')
    .not('id', 'like', 'tm_%')
    .order('date', { ascending: true })
    .limit(EVENT_LIMIT);

  if (error) {
    console.error('❌ Failed to fetch events:', error.message);
    return [];
  }

  return data || [];
}

async function scrapedRecently(eventId, hours = RECENT_HOURS) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('volume_snapshots')
    .select('id')
    .eq('event_id', eventId)
    .is('section', null)
    .gte('scraped_at', since)
    .limit(1);

  if (error) {
    console.error(`❌ Failed recent-check for ${eventId}:`, error.message);
    return false;
  }

  return !!(data && data.length > 0);
}

async function postSnapshot(payload) {
  try {
    const response = await fetch(`${VKT_API}/api/snapshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const text = await response.text();

    if (!response.ok) {
      console.error('❌ Snapshot failed:', {
        status: response.status,
        statusText: response.statusText,
        body: text,
        payload
      });
      return false;
    }

    return true;
  } catch (error) {
    console.error('❌ Snapshot request crashed:', error.message, payload);
    return false;
  }
}

async function dismissModals(page) {
  const selectors = [
    'button:has-text("Continue")',
    'button:has-text("Close")',
    'button[aria-label="Close"]',
    '[data-testid="close-button"]'
  ];

  for (const selector of selectors) {
    try {
      const el = page.locator(selector).first();
      if (await el.isVisible({ timeout: 800 })) {
        await el.click({ timeout: 1000 });
        await page.waitForTimeout(500);
      }
    } catch (_) {}
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

            return {
              name: item.name || null,
              date: item.startDate || null,
              venue: venue || null
            };
          }
        } catch (_) {}
      }

      return null;
    });
  } catch (_) {
    return null;
  }
}

async function extractNextDataEvent(page) {
  try {
    return await page.evaluate(() => {
      const el = document.querySelector('#__NEXT_DATA__');
      if (!el?.textContent) return null;

      let parsed;
      try {
        parsed = JSON.parse(el.textContent);
      } catch (_) {
        return null;
      }

      let best = {
        name: null,
        date: null,
        venue: null
      };

      function walk(obj) {
        if (!obj || typeof obj !== 'object') return;

        if (!best.name && typeof obj.name === 'string' && !obj.name.toLowerCase().includes('tickets') && obj.name.length < 200) {
          best.name = obj.name.trim();
        }

        if (!best.date && typeof obj.startDate === 'string') {
          best.date = obj.startDate;
        }

        if (!best.date && typeof obj.date === 'string') {
          best.date = obj.date;
        }

        if (!best.venue) {
          if (typeof obj.venueName === 'string') {
            best.venue = obj.venueName.trim();
          } else if (obj.venue && typeof obj.venue.name === 'string') {
            const city = obj.venue.city?.name || obj.venue.city || '';
            const state = obj.venue.state?.stateCode || obj.venue.state || '';
            best.venue = [obj.venue.name, city, state].filter(Boolean).join(', ');
          } else if (typeof obj.locationName === 'string') {
            best.venue = obj.locationName.trim();
          }
        }

        for (const key of Object.keys(obj)) {
          const val = obj[key];
          if (val && typeof val === 'object') {
            walk(val);
          }
        }
      }

      walk(parsed);
      return best;
    });
  } catch (_) {
    return null;
  }
}

async function extractVisibleEventData(page) {
  try {
    return await page.evaluate(() => {
      const bodyText = document.body?.innerText || '';

      let name = null;
      let venue = null;
      let date = null;

      const h1 = document.querySelector('h1');
      if (h1?.textContent?.trim()) {
        const txt = h1.textContent.trim();
        if (!txt.toLowerCase().includes('tickets')) {
          name = txt;
        }
      }

      const timeEl = document.querySelector('time');
      if (timeEl?.getAttribute('datetime')) {
        date = timeEl.getAttribute('datetime');
      } else if (timeEl?.textContent?.trim()) {
        date = timeEl.textContent.trim();
      }

      const venueCandidates = [
        document.querySelector('[data-testid="event-venue"]'),
        document.querySelector('[data-testid="venue-name"]'),
        document.querySelector('[class*="venue"]')
      ].filter(Boolean);

      for (const el of venueCandidates) {
        const txt = el.textContent?.trim();
        if (txt && txt.length < 200) {
          venue = txt;
          break;
        }
      }

      if (!date) {
        const match =
          bodyText.match(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},\s+\d{4}\b/i) ||
          bodyText.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},\s+\d{4}\b/i);

        if (match) date = match[0];
      }

      return { name, venue, date };
    });
  } catch (_) {
    return { name: null, venue: null, date: null };
  }
}

async function extractEventPageDetails(page) {
  const jsonLd = await extractJsonLdEvent(page);
  const nextData = await extractNextDataEvent(page);
  const visible = await extractVisibleEventData(page);

  let name =
    jsonLd?.name ||
    nextData?.name ||
    visible?.name ||
    null;

  let venue =
    jsonLd?.venue ||
    nextData?.venue ||
    visible?.venue ||
    null;

  let date =
    normalizeDateString(jsonLd?.date) ||
    normalizeDateString(nextData?.date) ||
    normalizeDateString(visible?.date) ||
    null;

  if (name && name.toLowerCase().includes('tickets')) {
    name = visible?.name || null;
  }

  return {
    name: name || null,
    venue: venue || null,
    date: date || null
  };
}

async function extractListingsAndPrices(page) {
  return await page.evaluate(() => {
    const bodyText = document.body?.innerText || '';

    const listingMatches = [...bodyText.matchAll(/(\d[\d,]*)\s+listings?/gi)]
      .map(m => parseInt(m[1].replace(/,/g, ''), 10))
      .filter(v => Number.isFinite(v) && v >= 0);

    const totalListings = listingMatches.length ? Math.max(...listingMatches) : 0;

    const prices = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;

    while ((node = walker.nextNode())) {
      if (!node.parentElement) continue;
      if (node.parentElement.closest('script,style,noscript,svg')) continue;

      const style = window.getComputedStyle(node.parentElement);
      if (style.display === 'none' || style.visibility === 'hidden') continue;

      for (const match of node.textContent.matchAll(/\$\s*([\d,]+(?:\.\d{2})?)/g)) {
        const value = parseFloat(match[1].replace(/,/g, ''));
        if (Number.isFinite(value) && value >= 1 && value <= 25000) {
          prices.push(value);
        }
      }
    }

    prices.sort((a, b) => a - b);

    return { totalListings, prices };
  });
}

async function getSectionIds(page) {
  try {
    return await page.evaluate(() => {
      const ids = [];
      const seen = new Set();

      document.querySelectorAll('[sprite-identifier]').forEach(el => {
        const value = el.getAttribute('sprite-identifier');
        if (value && /^s\d+$/i.test(value) && !seen.has(value)) {
          seen.add(value);
          ids.push(value.replace(/^s/i, ''));
        }
      });

      return ids;
    });
  } catch (_) {
    return [];
  }
}

async function getSectionName(page, sectionId) {
  try {
    const sectionName = await page.evaluate((sid) => {
      const el = document.querySelector(`[sprite-identifier="s${sid}"]`);
      if (!el) return null;

      const direct =
        el.getAttribute('aria-label') ||
        el.getAttribute('data-section-name') ||
        el.getAttribute('title');

      if (direct && direct.trim()) return direct.trim();

      const parent = el.closest('g');
      if (parent) {
        const textNode = parent.querySelector('text');
        if (textNode?.textContent?.trim()) return textNode.textContent.trim();
      }

      return null;
    }, sectionId);

    return sectionName || `Section ${sectionId}`;
  } catch (_) {
    return `Section ${sectionId}`;
  }
}

async function gotoEventPage(page, eventId, sectionId = null) {
  const url = sectionId
    ? `https://www.stubhub.com/event/${eventId}/?sections=${sectionId}&quantity=0`
    : `https://www.stubhub.com/event/${eventId}/?quantity=0`;

  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  });

  await page.waitForTimeout(sectionId ? SECTION_DELAY_MS : 3500);
  await dismissModals(page);

  return url;
}

async function scrapeSection(page, eventId, sectionId, fallbackName) {
  try {
    const url = await gotoEventPage(page, eventId, sectionId);
    console.log(`   → Section ${sectionId}: ${url}`);

    const { totalListings, prices } = await extractListingsAndPrices(page);
    const summary = summarizePrices(prices);

    if (!summary.floor || !summary.avg || !summary.ceiling) {
      console.log(`   ⚠ Section ${sectionId}: no usable price data`);
      return null;
    }

    const derivedListings = prices.length || 0;
    const finalSectionListings =
      totalListings && totalListings > 0 && totalListings !== 1
        ? totalListings
        : derivedListings;

    return {
      section: fallbackName || `Section ${sectionId}`,
      sectionListings: finalSectionListings,
      sectionFloor: summary.floor,
      sectionAvg: summary.avg,
      sectionCeiling: summary.ceiling
    };
  } catch (error) {
    console.log(`   ⚠ Section ${sectionId} failed: ${error.message}`);
    return null;
  }
}

async function scrapeEvent(page, event) {
  const eventId = event.id;
  const originalName = event.name || `Event ${eventId}`;

  try {
    const baseUrl = await gotoEventPage(page, eventId);
    console.log(`  Opened ${baseUrl}`);

    const pageDetails = await extractEventPageDetails(page);

    let name = pageDetails.name || originalName;
    if (name && name.toLowerCase().includes('tickets')) {
      name = originalName;
    }

    const stubhubVenue = pageDetails.venue || event.venue || null;
    const stubhubDate = pageDetails.date || event.date || null;

    const { totalListings, prices } = await extractListingsAndPrices(page);
    const eventSummary = summarizePrices(prices);

    if (!eventSummary.floor || !eventSummary.avg || !eventSummary.ceiling) {
      console.log(`  ⚠ ${name}: no event-level pricing found`);
      return null;
    }

    console.log(
      `  ✓ ${name}: listings=${totalListings}, floor=$${eventSummary.floor}, atp=$${eventSummary.avg}`
    );
    console.log(`  ✓ Venue: ${stubhubVenue || 'N/A'} | Date: ${stubhubDate || 'N/A'}`);

    const eventPosted = await postSnapshot({
      eventId,
      eventName: name,
      eventDate: stubhubDate,
      venue: stubhubVenue,
      platform: 'StubHub',
      totalListings,
      section: null,
      sectionListings: 0,
      eventFloor: eventSummary.floor,
      eventAvg: eventSummary.avg,
      eventCeiling: eventSummary.ceiling,
      source: 'playwright-url'
    });

    if (!eventPosted) {
      console.log(`  ⚠ Event-level snapshot failed for ${eventId}`);
    }

    const updates = {};
    if (name && name !== originalName) updates.name = name;
    if (stubhubVenue && stubhubVenue !== event.venue) updates.venue = stubhubVenue;
    if (stubhubDate && stubhubDate !== event.date) updates.date = stubhubDate;

    if (Object.keys(updates).length) {
      const { error: updateError } = await supabase
        .from('events')
        .update(updates)
        .eq('id', eventId);

      if (updateError) {
        console.log(`  ⚠ Failed updating events table for ${eventId}: ${updateError.message}`);
      }
    }

    const sectionIds = await getSectionIds(page);
    console.log(`  Found ${sectionIds.length} section ids`);

    let postedSections = 0;

    for (const sectionId of sectionIds) {
      const sectionName = await getSectionName(page, sectionId);
      const sectionData = await scrapeSection(page, eventId, sectionId, sectionName);

      if (!sectionData) continue;

      const ok = await postSnapshot({
        eventId,
        eventName: name,
        eventDate: stubhubDate,
        venue: stubhubVenue,
        platform: 'StubHub',
        totalListings,
        section: sectionData.section,
        sectionListings: sectionData.sectionListings,
        sectionFloor: sectionData.sectionFloor,
        sectionAvg: sectionData.sectionAvg,
        sectionCeiling: sectionData.sectionCeiling,
        eventFloor: eventSummary.floor,
        eventAvg: eventSummary.avg,
        eventCeiling: eventSummary.ceiling,
        source: 'playwright-url'
      });

      if (ok) postedSections += 1;

      await sleep(700);
    }

    console.log(`  ✓ Posted ${postedSections}/${sectionIds.length} section rows`);

    return {
      ok: true,
      eventId,
      name,
      venue: stubhubVenue,
      date: stubhubDate,
      totalListings,
      sectionIds: sectionIds.length,
      postedSections
    };
  } catch (error) {
    console.error(`  ✗ Failed event ${eventId}: ${error.message}`);
    return null;
  }
}

async function main() {
  console.log('🎟 Starting VKT StubHub scraper...');

  const manualEventId = process.argv[2];
  let events = [];

  if (manualEventId) {
    events = [{
      id: manualEventId,
      name: 'Manual Run',
      date: null,
      venue: null,
      platform: 'StubHub'
    }];
    console.log(`Manual mode: event ${manualEventId}`);
  } else {
    events = await getEvents();
    console.log(`Fetched ${events.length} events`);
  }

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--window-size=1280,900'
    ]
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    window.chrome = { runtime: {} };
  });

  let scraped = 0;
  let skipped = 0;
  let failed = 0;

  for (const event of events) {
    if (!manualEventId) {
      const recent = await scrapedRecently(event.id);
      if (recent) {
        console.log(`⏭ Skipping ${event.name} (${event.id}) - scraped recently`);
        skipped += 1;
        continue;
      }
    }

    console.log(`\n🔍 Scraping ${event.name} (${event.id})`);
    const result = await scrapeEvent(page, event);

    if (result) scraped += 1;
    else failed += 1;

    await sleep(SCRAPE_DELAY_MS);
  }

  await browser.close();

  console.log('\n✅ Finished');
  console.log(`Scraped: ${scraped}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Failed: ${failed}`);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
