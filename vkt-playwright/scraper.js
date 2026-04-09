const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL  = process.env.SUPABASE_URL  || 'https://unypasitbzulafehbqtj.supabase.co';
const SUPABASE_KEY  = process.env.SUPABASE_KEY  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVueXBhc2l0Ynp1bGFmZWhicXRqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUwMTE2MjAsImV4cCI6MjA5MDU4NzYyMH0.ywGB7ZccbVxcgZDXMOQB9Ui8R-SF4xF0SKkWavDbRGI';
const VKT_API       = process.env.VKT_API       || 'https://vkt-volume-api.vercel.app';
const SCRAPE_DELAY  = parseInt(process.env.SCRAPE_DELAY || '6000', 10);
const SECTION_DELAY = parseInt(process.env.SECTION_DELAY || '2500', 10);

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function getEvents() {
  const { data, error } = await supabase
    .from('events')
    .select('id, name, date, venue, platform')
    .not('id', 'like', 'tm_%')
    .order('date', { ascending: true })
    .limit(200);

  if (error) {
    console.error('❌ Failed to fetch events:', error.message);
    return [];
  }

  return data || [];
}

async function scrapedRecently(eventId, hours = 20) {
  const since = new Date(Date.now() - hours * 3600000).toISOString();

  const { data, error } = await supabase
    .from('volume_snapshots')
    .select('id')
    .eq('event_id', eventId)
    .is('section', null)
    .gte('scraped_at', since)
    .limit(1);

  if (error) {
    console.error(`❌ scrapedRecently failed for ${eventId}:`, error.message);
    return false;
  }

  return !!(data && data.length > 0);
}

async function postSnapshot(payload) {
  try {
    const r = await fetch(`${VKT_API}/api/snapshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const text = await r.text();

    if (!r.ok) {
      console.error('❌ Snapshot failed:', {
        status: r.status,
        statusText: r.statusText,
        body: text,
        payload
      });
      return false;
    }

    return true;
  } catch (e) {
    console.error('❌ Snapshot request crashed:', e.message, payload);
    return false;
  }
}

async function dismissModal(page) {
  try {
    const btn = page.locator('button:has-text("Continue"), button:has-text("Close"), button[aria-label="Close"]').first();
    if (await btn.isVisible({ timeout: 2000 })) {
      await btn.click();
      await page.waitForTimeout(600);
    }
  } catch (e) {}
}

async function extractJsonLdName(page) {
  try {
    return await page.evaluate(() => {
      const els = document.querySelectorAll('script[type="application/ld+json"]');
      for (const el of els) {
        try {
          const d = JSON.parse(el.textContent);
          if (Array.isArray(d)) {
            for (const item of d) {
              if (item?.name && (item['@type'] === 'Event' || item['@type'] === 'SportsEvent')) {
                return item.name;
              }
            }
          } else if (d?.name && (d['@type'] === 'Event' || d['@type'] === 'SportsEvent')) {
            return d.name;
          }
        } catch (e) {}
      }
      return null;
    });
  } catch (e) {
    return null;
  }
}

async function extractEventDate(page) {
  try {
    return await page.evaluate(() => {
      const el = document.querySelector('time') || document.querySelector('[data-testid="event-date"]');
      return el ? el.textContent.trim() : null;
    });
  } catch (e) {
    return null;
  }
}

async function extractPageListingsAndPrices(page) {
  return await page.evaluate(() => {
    const text = document.body.innerText || '';

    const listingMatches = [...text.matchAll(/(\d[\d,]*)\s+listings?/gi)]
      .map(m => parseInt(m[1].replace(/,/g, ''), 10))
      .filter(v => Number.isFinite(v) && v >= 0);

    const totalListings = listingMatches.length ? Math.max(...listingMatches) : 0;

    const prices = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;

    while ((node = walker.nextNode())) {
      if (!node.parentElement) continue;
      if (node.parentElement.closest('svg,script,style,noscript')) continue;

      const style = window.getComputedStyle(node.parentElement);
      if (style.display === 'none' || style.visibility === 'hidden') continue;

      for (const m of node.textContent.matchAll(/\$\s*([\d,]+(?:\.\d{2})?)/g)) {
        const v = parseFloat(m[1].replace(/,/g, ''));
        if (v >= 1 && v <= 25000) prices.push(v);
      }
    }

    prices.sort((a, b) => a - b);

    return { totalListings, prices };
  });
}

function summarizePrices(prices) {
  if (!prices || !prices.length) {
    return { floor: null, avg: null, ceiling: null };
  }

  const floor = prices[0];
  const ceiling = prices[prices.length - 1];
  const avg = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);

  return { floor, avg, ceiling };
}

async function getSectionIds(page) {
  try {
    return await page.evaluate(() => {
      const ids = [];
      const seen = new Set();

      document.querySelectorAll('[sprite-identifier]').forEach(el => {
        const val = el.getAttribute('sprite-identifier');
        if (val && /^s\d+$/i.test(val) && !seen.has(val)) {
          seen.add(val);
          ids.push(val.replace(/^s/i, ''));
        }
      });

      return ids;
    });
  } catch (e) {
    return [];
  }
}

async function getSectionNameFromMap(page, sectionId) {
  try {
    const fromMap = await page.evaluate((sid) => {
      const el = document.querySelector(`[sprite-identifier="s${sid}"]`);
      if (!el) return null;

      const directLabel =
        el.getAttribute('aria-label') ||
        el.getAttribute('data-section-name') ||
        el.getAttribute('title');

      if (directLabel && directLabel.trim()) return directLabel.trim();

      const parent = el.closest('g');
      if (parent) {
        const text = parent.querySelector('text');
        if (text?.textContent?.trim()) return text.textContent.trim();
      }

      return null;
    }, sectionId);

    return fromMap || `Section ${sectionId}`;
  } catch (e) {
    return `Section ${sectionId}`;
  }
}

async function scrapeSection(page, eventId, sectionId, fallbackName, eventTotal) {
  const sectionUrl = `https://www.stubhub.com/event/${eventId}/?sections=${sectionId}&quantity=0`;

  try {
    console.log(`   → Loading section ${sectionId}`);

    await page.goto(sectionUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(SECTION_DELAY);
    await dismissModal(page);

    const { totalListings, prices } = await extractPageListingsAndPrices(page);

    if (!prices.length) {
      console.log(`   ⚠ Section ${sectionId}: no prices found`);
      return null;
    }

    const summary = summarizePrices(prices);

    // Keep obvious bad loads out, but do NOT drop just because listings === event total.
    // Your current code drops those rows, which is why sections stay blank. :contentReference[oaicite:2]{index=2}
    if (!summary.floor || !summary.avg || !summary.ceiling) {
      return null;
    }

    const sectionName = fallbackName || `Section ${sectionId}`;

    return {
      section: sectionName,
      sectionListings: totalListings || 0,
      sectionFloor: summary.floor,
      sectionAvg: summary.avg,
      sectionCeiling: summary.ceiling
    };
  } catch (e) {
    console.log(`   ⚠ Section ${sectionId} failed: ${e.message}`);
    return null;
  }
}

async function scrapeEvent(page, eventId, eventName) {
  const baseUrl = `https://www.stubhub.com/event/${eventId}/?quantity=0`;
  console.log(`  Navigating to ${baseUrl}`);

  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);
    await dismissModal(page);

    const jsonLdName = await extractJsonLdName(page);
    const name = jsonLdName || eventName;
    const eventDate = await extractEventDate(page);

    const { totalListings, prices } = await extractPageListingsAndPrices(page);

    if (!prices.length) {
      console.log(`  ⚠ No prices found for ${name}`);
      return null;
    }

    const eventSummary = summarizePrices(prices);

    console.log(
      `  ✓ ${name}: ${totalListings} listings, floor $${eventSummary.floor}, ATP $${eventSummary.avg}`
    );

    const eventPosted = await postSnapshot({
      eventId,
      eventName: name,
      eventDate,
      platform: 'StubHub',
      totalListings,
      section: null,
      sectionListings: 0,
      eventFloor: eventSummary.floor,
      eventAvg: eventSummary.avg,
      eventCeiling: eventSummary.ceiling,
      source: 'playwright'
    });

    if (!eventPosted) {
      console.log(`  ⚠ Event-level snapshot failed for ${eventId}`);
    }

    if (jsonLdName && jsonLdName !== eventName) {
      await supabase.from('events').update({ name: jsonLdName }).eq('id', eventId);
    }

    const sectionIds = await getSectionIds(page);
    console.log(`  Found ${sectionIds.length} sections on map`);

    let sectionsCompleted = 0;

    for (const sectionId of sectionIds) {
      const sectionName = await getSectionNameFromMap(page, sectionId);
      const sectionData = await scrapeSection(page, eventId, sectionId, sectionName, totalListings);

      if (!sectionData) continue;

      const posted = await postSnapshot({
        eventId,
        eventName: name,
        eventDate,
        platform: 'StubHub',
        totalListings,
        section: sectionData.section,
        sectionListings: sectionData.sectionListings,
        sectionFloor: sectionData.sectionFloor,
        sectionAvg: sectionData.sectionAvg,
        sectionCeiling: sectionData.sectionCeiling,
        eventFloor: eventSummary.floor,
        source: 'playwright'
      });

      if (posted) {
        sectionsCompleted++;
      }

      await sleep(800);
    }

    console.log(`  ✓ Scraped ${sectionsCompleted}/${sectionIds.length} sections`);

    return {
      ok: true,
      listings: totalListings,
      sections: sectionIds.length,
      completed: sectionsCompleted
    };
  } catch (e) {
    console.error(`  ✗ Error scraping ${eventId}:`, e.message);
    return null;
  }
}

async function main() {
  console.log('🎟 VKT Playwright Scraper starting...');

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--window-size=1280,800'
    ]
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    timezoneId: 'America/New_York'
  });

  const page = await context.newPage();

  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    window.chrome = { runtime: {} };
  });

  const events = await getEvents();
  console.log(`Found ${events.length} StubHub events to check`);

  let scraped = 0;
  let skipped = 0;
  let failed = 0;

  for (const event of events) {
    const recent = await scrapedRecently(event.id);

    if (recent) {
      console.log(`⏭ Skipping ${event.name} (scraped recently)`);
      skipped++;
      continue;
    }

    console.log(`\n🔍 Scraping: ${event.name} (${event.date || 'no date'})`);
    const result = await scrapeEvent(page, event.id, event.name);

    if (result) {
      scraped++;
    } else {
      failed++;
    }

    await page.waitForTimeout(SCRAPE_DELAY);
  }

  await browser.close();

  console.log(`\n✅ Done — ${scraped} scraped, ${skipped} skipped, ${failed} failed`);
  process.exit(0);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
