const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://unypasitbzulafehbqtj.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVueXBhc2l0Ynp1bGFmZWhicXRqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUwMTE2MjAsImV4cCI6MjA5MDU4NzYyMH0.ywGB7ZccbVxcgZDXMOQB9Ui8R-SF4xF0SKkWavDbRGI';
const VKT_API     = process.env.VKT_API || 'https://vkt-volume-api.vercel.app';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// All major performers to seed — teams + artists
const PERFORMERS = [
  // MLB
  { name: 'New York Yankees',        url: 'https://www.stubhub.com/new-york-yankees-tickets/performer/919/' },
  { name: 'Los Angeles Dodgers',     url: 'https://www.stubhub.com/los-angeles-dodgers-tickets/performer/938/' },
  { name: 'Boston Red Sox',          url: 'https://www.stubhub.com/boston-red-sox-tickets/performer/922/' },
  { name: 'Chicago Cubs',            url: 'https://www.stubhub.com/chicago-cubs-tickets/performer/928/' },
  { name: 'San Francisco Giants',    url: 'https://www.stubhub.com/san-francisco-giants-tickets/performer/940/' },
  { name: 'Houston Astros',          url: 'https://www.stubhub.com/houston-astros-tickets/performer/929/' },
  { name: 'Atlanta Braves',          url: 'https://www.stubhub.com/atlanta-braves-tickets/performer/921/' },
  { name: 'Philadelphia Phillies',   url: 'https://www.stubhub.com/philadelphia-phillies-tickets/performer/936/' },
  { name: 'New York Mets',           url: 'https://www.stubhub.com/new-york-mets-tickets/performer/934/' },
  { name: 'Chicago White Sox',       url: 'https://www.stubhub.com/chicago-white-sox-tickets/performer/927/' },
  // NBA
  { name: 'Los Angeles Lakers',      url: 'https://www.stubhub.com/los-angeles-lakers-tickets/performer/964/' },
  { name: 'Golden State Warriors',   url: 'https://www.stubhub.com/golden-state-warriors-tickets/performer/974/' },
  { name: 'Boston Celtics',          url: 'https://www.stubhub.com/boston-celtics-tickets/performer/967/' },
  { name: 'New York Knicks',         url: 'https://www.stubhub.com/new-york-knicks-tickets/performer/972/' },
  { name: 'Miami Heat',              url: 'https://www.stubhub.com/miami-heat-tickets/performer/970/' },
  { name: 'Chicago Bulls',           url: 'https://www.stubhub.com/chicago-bulls-tickets/performer/968/' },
  { name: 'Brooklyn Nets',           url: 'https://www.stubhub.com/brooklyn-nets-tickets/performer/5209/' },
  { name: 'Philadelphia 76ers',      url: 'https://www.stubhub.com/philadelphia-76ers-tickets/performer/973/' },
  { name: 'Dallas Mavericks',        url: 'https://www.stubhub.com/dallas-mavericks-tickets/performer/3633/' },
  { name: 'Milwaukee Bucks',         url: 'https://www.stubhub.com/milwaukee-bucks-tickets/performer/971/' },
  // NHL
  { name: 'New York Rangers',        url: 'https://www.stubhub.com/new-york-rangers-tickets/performer/1007/' },
  { name: 'Toronto Maple Leafs',     url: 'https://www.stubhub.com/toronto-maple-leafs-tickets/performer/1011/' },
  { name: 'Boston Bruins',           url: 'https://www.stubhub.com/boston-bruins-tickets/performer/997/' },
  { name: 'Chicago Blackhawks',      url: 'https://www.stubhub.com/chicago-blackhawks-tickets/performer/999/' },
  { name: 'Las Vegas Golden Knights', url: 'https://www.stubhub.com/vegas-golden-knights-tickets/performer/5535503/' },
  // NFL
  { name: 'Dallas Cowboys',          url: 'https://www.stubhub.com/dallas-cowboys-tickets/performer/1874/' },
  { name: 'New England Patriots',    url: 'https://www.stubhub.com/new-england-patriots-tickets/performer/1882/' },
  { name: 'Green Bay Packers',       url: 'https://www.stubhub.com/green-bay-packers-tickets/performer/1878/' },
  { name: 'Kansas City Chiefs',      url: 'https://www.stubhub.com/kansas-city-chiefs-tickets/performer/1879/' },
  { name: 'San Francisco 49ers',     url: 'https://www.stubhub.com/san-francisco-49ers-tickets/performer/1888/' },
  // Concerts
  { name: 'Taylor Swift',            url: 'https://www.stubhub.com/taylor-swift-tickets/performer/844871/' },
  { name: 'Beyonce',                 url: 'https://www.stubhub.com/beyonce-tickets/performer/32803/' },
  { name: 'Morgan Wallen',           url: 'https://www.stubhub.com/morgan-wallen-tickets/performer/5752451/' },
  { name: 'Bad Bunny',               url: 'https://www.stubhub.com/bad-bunny-tickets/performer/5507870/' },
  { name: 'Drake',                   url: 'https://www.stubhub.com/drake-tickets/performer/1278715/' },
];

// Extract event ID from StubHub URL
function extractEventId(url) {
  const m = url.match(/\/event\/(\d{5,})/);
  return m ? m[1] : null;
}

// Seed a single performer page
async function seedPerformer(page, performer) {
  console.log(`\n📋 Seeding: ${performer.name}`);
  let seeded = 0;

  try {
    await page.goto(performer.url, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(4000);

    // Dismiss any modal
    try {
      const btn = page.locator('button:has-text("Continue"), button:has-text("Close"), button:has-text("Accept")').first();
      if (await btn.isVisible({ timeout: 2000 })) await btn.click();
      await page.waitForTimeout(500);
    } catch(e) {}

    // Scroll down to trigger lazy loading
    await page.evaluate(async () => {
      for (let i = 0; i < 5; i++) {
        window.scrollBy(0, 600);
        await new Promise(r => setTimeout(r, 800));
      }
    });
    await page.waitForTimeout(2000);

    // Debug: log page title and URL to see what StubHub returned
    const pageTitle = await page.title();
    const pageUrl = await page.url();
    console.log(`  Page: ${pageTitle} | ${pageUrl}`);

    // Check for bot detection
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 300));
    console.log('  Body preview: ' + bodyText.replace(/\n/g, ' '));

    // Try to find event links - StubHub uses multiple patterns
    const eventLinks = await page.evaluate(() => {
      const links = [];
      const seen = new Set();

      // Pattern 1: direct /event/ links
      document.querySelectorAll('a[href*="/event/"]').forEach(a => {
        const m = (a.href || '').match(/\/event\/(\d{5,})/);
        if (m && !seen.has(m[1])) {
          seen.add(m[1]);
          links.push({ id: m[1], url: a.href });
        }
      });

      // Pattern 2: links with event ID in path  
      document.querySelectorAll('a[href*="stubhub.com"]').forEach(a => {
        const m = (a.href || '').match(/\/(\d{8,})\//);
        if (m && !seen.has(m[1])) {
          seen.add(m[1]);
          links.push({ id: m[1], url: a.href });
        }
      });

      // Pattern 3: check __NEXT_DATA__ for event IDs
      try {
        const nd = document.getElementById('__NEXT_DATA__');
        if (nd) {
          const data = JSON.stringify(JSON.parse(nd.textContent));
          const matches = [...data.matchAll(/"id":"(\d{6,})"/g)];
          matches.forEach(m => {
            if (!seen.has(m[1])) {
              seen.add(m[1]);
              links.push({ id: m[1], url: 'https://www.stubhub.com/event/' + m[1] });
            }
          });
        }
      } catch(e) {}

      return links.slice(0, 80);
    });

    console.log(`  Found ${eventLinks.length} events`);

    for (const ev of eventLinks) {
      // Check if already in DB
      const { data } = await supabase.from('events').select('id').eq('id', ev.id).limit(1);
      if (data && data.length > 0) {
        console.log(`  ⏭ Already have event ${ev.id}`);
        continue;
      }

      // Parse date from URL or text
      const dateMatch = ev.url.match(/(\d{4}-\d{2}-\d{2})/) ||
                        ev.text.match(/(\w{3,9})\s+(\d{1,2}),?\s+(\d{4})/);
      let date = null;
      if (dateMatch && dateMatch[0].match(/\d{4}-\d{2}-\d{2}/)) {
        date = dateMatch[0];
      }

      // Insert event into DB
      const { error } = await supabase.from('events').upsert({
        id: ev.id,
        name: performer.name + ' tickets',
        date: date,
        venue: null,
        platform: 'StubHub',
        updated_at: new Date().toISOString()
      }, { onConflict: 'id' });

      if (!error) {
        console.log(`  ✓ Seeded event ${ev.id}`);
        seeded++;
      }
    }

  } catch(e) {
    console.error(`  ✗ Error seeding ${performer.name}:`, e.message);
  }

  return seeded;
}

async function main() {
  console.log('🌱 VKT StubHub Performer Seeder starting...');

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
    window.chrome = { runtime: {} };
  });

  let totalSeeded = 0;

  for (const performer of PERFORMERS) {
    const count = await seedPerformer(page, performer);
    totalSeeded += count;
    // Delay between performers
    await page.waitForTimeout(3000);
  }

  await browser.close();
  console.log(`\n✅ Done — ${totalSeeded} new events seeded across ${PERFORMERS.length} performers`);
  process.exit(0);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
