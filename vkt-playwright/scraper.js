const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL  = process.env.SUPABASE_URL  || 'https://unypasitbzulafehbqtj.supabase.co';
const SUPABASE_KEY  = process.env.SUPABASE_KEY  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVueXBhc2l0Ynp1bGFmZWhicXRqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUwMTE2MjAsImV4cCI6MjA5MDU4NzYyMH0.ywGB7ZccbVxcgZDXMOQB9Ui8R-SF4xF0SKkWavDbRGI';
const VKT_API       = process.env.VKT_API       || 'https://vkt-volume-api.vercel.app';
const SCRAPE_DELAY  = parseInt(process.env.SCRAPE_DELAY || '6000'); // ms between events

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Fetch StubHub events to scrape ──
async function getEvents() {
  const { data } = await supabase
    .from('events')
    .select('id, name, date, venue, platform')
    .not('id', 'like', 'tm_%')
    .order('date', { ascending: true })
    .limit(200);
  return data || [];
}

// ── Check if scraped recently ──
async function scrapedRecently(eventId, hours = 20) {
  const since = new Date(Date.now() - hours * 3600000).toISOString();
  const { data } = await supabase
    .from('volume_snapshots')
    .select('id')
    .eq('event_id', eventId)
    .gte('scraped_at', since)
    .limit(1);
  return data && data.length > 0;
}

// ── Post snapshot to VKT API ──
async function postSnapshot(payload) {
  const r = await fetch(`${VKT_API}/api/snapshot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return r.ok;
}

// ── Scrape a single StubHub event page ──
async function scrapeEvent(page, eventId, eventName) {
  const url = `https://www.stubhub.com/event/${eventId}/?quantity=0`;
  console.log(`  Navigating to ${url}`);

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Wait for listings to render
    await page.waitForTimeout(4000);

    // Dismiss any modal
    try {
      const btn = page.locator('button:has-text("Continue"), button:has-text("Close")').first();
      if (await btn.isVisible({ timeout: 2000 })) await btn.click();
      await page.waitForTimeout(500);
    } catch(e) {}

    // Get event name from JSON-LD
    const jsonLdName = await page.evaluate(() => {
      const els = document.querySelectorAll('script[type="application/ld+json"]');
      for (const el of els) {
        try {
          const d = JSON.parse(el.textContent);
          if (d.name && (d['@type'] === 'Event' || d['@type'] === 'SportsEvent')) return d.name;
        } catch(e) {}
      }
      return null;
    });

    const name = jsonLdName || eventName;

    // Get event date
    const eventDate = await page.evaluate(() => {
      const el = document.querySelector('time') || document.querySelector('[data-testid="event-date"]');
      return el ? el.textContent.trim() : null;
    });

    // Get total listings
    const totalListings = await page.evaluate(() => {
      const text = document.body.innerText;
      const matches = [...text.matchAll(/(\d[\d,]*)\s+listings?/gi)].map(m => parseInt(m[1].replace(/,/g,'')));
      return matches.length ? Math.max(...matches) : 0;
    });

    // Get all visible prices
    const prices = await page.evaluate(() => {
      const prices = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (node.parentElement?.closest('svg,script,style,noscript')) continue;
        const style = window.getComputedStyle(node.parentElement);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        for (const m of node.textContent.matchAll(/\$\s*([\d,]+(?:\.\d{2})?)/g)) {
          const v = parseFloat(m[1].replace(/,/g,''));
          if (v >= 1 && v <= 25000) prices.push(v);
        }
      }
      return prices.sort((a,b) => a-b);
    });

    if (!prices.length) {
      console.log(`  ⚠ No prices found for ${name}`);
      return null;
    }

    const floor   = prices[0];
    const ceiling = prices[prices.length - 1];
    const avg     = Math.round(prices.reduce((a,b) => a+b, 0) / prices.length);

    console.log(`  ✓ ${name}: ${totalListings} listings, floor $${floor}, ATP $${avg}`);

    // Post event-level snapshot
    await postSnapshot({
      eventId,
      eventName: name,
      eventDate,
      platform: 'StubHub',
      totalListings,
      section: null,
      sectionListings: 0,
      eventFloor: floor,
      eventAvg: avg,
      eventCeiling: ceiling,
      source: 'playwright'
    });

    // Update event name in DB if we got a better one
    if (jsonLdName && jsonLdName !== eventName) {
      await supabase.from('events').update({ name: jsonLdName }).eq('id', eventId);
    }

    // Get section IDs from map
    const sectionIds = await page.evaluate(() => {
      const ids = [], seen = new Set();
      document.querySelectorAll('[sprite-identifier]').forEach(el => {
        const val = el.getAttribute('sprite-identifier');
        if (val && /^s\d+$/.test(val) && !seen.has(val)) {
          seen.add(val);
          ids.push(val.replace('s',''));
        }
      });
      return ids;
    });

    console.log(`  Found ${sectionIds.length} sections on map`);

    // Scrape each section
    let sectionsCompleted = 0;
    const eventTotal = totalListings;

    for (const sectionId of sectionIds) {
      // Update URL param for this section
      await page.evaluate((sid) => {
        const url = new URL(window.location.href);
        url.searchParams.set('sections', sid);
        url.searchParams.set('quantity', '0');
        window.history.pushState(null, '', url.toString());
        window.dispatchEvent(new PopStateEvent('popstate'));
        // Click section on map
        const el = document.querySelector(`[sprite-identifier="s${sid}"]`);
        if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }, sectionId);

      await page.waitForTimeout(3000);

      const sectionData = await page.evaluate((evTotal) => {
        const listings = (() => {
          const m = document.body.innerText.match(/(\d[\d,]*)\s+listings?/i);
          return m ? parseInt(m[1].replace(/,/g,'')) : 0;
        })();

        if (listings === 0 || listings === evTotal) return null;

        const prices = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          if (node.parentElement?.closest('svg,script,style,noscript')) continue;
          const style = window.getComputedStyle(node.parentElement);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          for (const m of node.textContent.matchAll(/\$\s*([\d,]+(?:\.\d{2})?)/g)) {
            const v = parseFloat(m[1].replace(/,/g,''));
            if (v >= 1 && v <= 25000) prices.push(v);
          }
        }

        if (!prices.length) return null;
        prices.sort((a,b) => a-b);

        // Get section name
        return {
          listings,
          floor:   prices[0],
          avg:     Math.round(prices.reduce((a,b)=>a+b,0)/prices.length),
          ceiling: prices[prices.length-1]
        };
      }, eventTotal);

      if (sectionData) {
        // Get section label
        const sectionName = await page.evaluate((sid) => {
          const el = document.querySelector(`[sprite-identifier="s${sid}"]`);
          if (!el) return sid;
          const parent = el.closest('g');
          if (parent) {
            const text = parent.querySelector('text');
            if (text?.textContent.trim()) return text.textContent.trim();
          }
          return sid;
        }, sectionId);

        await postSnapshot({
          eventId,
          eventName: name,
          platform: 'StubHub',
          totalListings: 0,
          section: sectionName,
          sectionListings: sectionData.listings,
          sectionFloor: sectionData.floor,
          sectionAvg: sectionData.avg,
          sectionCeiling: sectionData.ceiling,
          source: 'playwright'
        });
        sectionsCompleted++;
      }
    }

    console.log(`  ✓ Scraped ${sectionsCompleted}/${sectionIds.length} sections`);
    return { ok: true, listings: totalListings, sections: sectionIds.length, completed: sectionsCompleted };

  } catch(e) {
    console.error(`  ✗ Error scraping ${eventId}:`, e.message);
    return null;
  }
}

// ── Main ──
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

  // Hide automation
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
    window.chrome = { runtime: {} };
  });

  // Get events to scrape
  const events = await getEvents();
  console.log(`Found ${events.length} StubHub events to check`);

  let scraped = 0, skipped = 0, failed = 0;

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

    // Delay between events to avoid rate limiting
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
