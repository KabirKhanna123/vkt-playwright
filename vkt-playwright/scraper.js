const { createClient } = require('@supabase/supabase-js');

console.log('🚀 SCRAPER FILE LOADED');

// ===== ENV =====
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const VKT_API = process.env.VKT_API;

const PROXY_HOST = process.env.PROXY_HOST;
const PROXY_PORT = process.env.PROXY_PORT;
const PROXY_USER = process.env.PROXY_USER;
const PROXY_PASS = process.env.PROXY_PASS;

const MODE = process.env.MODE || 'production';
const SCRAPE_DELAY_MS = parseInt(process.env.SCRAPE_DELAY || '5000', 10);

if (!SUPABASE_URL || !SUPABASE_KEY || !VKT_API) {
  throw new Error('Missing required env vars: SUPABASE_URL, SUPABASE_KEY, or VKT_API');
}

if (!PROXY_HOST || !PROXY_PORT || !PROXY_USER || !PROXY_PASS) {
  throw new Error('Missing required proxy env vars: PROXY_HOST, PROXY_PORT, PROXY_USER, PROXY_PASS');
}

const RECENT_HOURS = 20;
const EVENT_LIMIT = 200;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ===== HELPERS =====
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  if (!Number.isNaN(d.getTime())) {
    return [
      d.getFullYear(),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0'),
    ].join('-');
  }

  return null;
}

function summarizePrices(prices) {
  const valid = (prices || [])
    .map(safeNum)
    .filter((v) => v > 0 && v < 25000)
    .sort((a, b) => a - b);

  if (!valid.length) {
    return { floor: null, avg: null, ceiling: null };
  }

  return {
    floor: Math.round(valid[0]),
    avg: Math.round(valid.reduce((a, b) => a + b, 0) / valid.length),
    ceiling: Math.round(valid[valid.length - 1]),
  };
}

function dedupeNumbers(values) {
  return [...new Set(values.filter((v) => Number.isFinite(v) && v > 0))];
}

// ===== DB =====
async function getEvents() {
  const { data, error } = await supabase
    .from('events')
    .select('id,name,date,venue,platform')
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
  const since = new Date(Date.now() - hours * 3600000).toISOString();

  const { data, error } = await supabase
    .from('volume_snapshots')
    .select('id')
    .eq('event_id', eventId)
    .is('section', null)
    .gte('scraped_at', since)
    .limit(1);

  if (error) {
    console.error(`⚠️ scrapedRecently error for ${eventId}:`, error.message);
    return false;
  }

  return !!(data && data.length > 0);
}

async function postSnapshot(payload) {
  try {
    const response = await fetch(`${VKT_API}/api/snapshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.error('❌ Snapshot failed:', response.status, await response.text());
      return false;
    }

    return true;
  } catch (e) {
    console.error('❌ Snapshot error:', e.message);
    return false;
  }
}

// ===== DECODO =====
function getProxyAuthHeader() {
  const token = Buffer.from(`${PROXY_USER}:${PROXY_PASS}`).toString('base64');
  return `Basic ${token}`;
}

async function fetchWithDecodo(url) {
  try {
    console.log('🌐 Fetching:', url);

    const response = await fetch('https://scraper-api.decodo.com/v2/scrape', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: getProxyAuthHeader(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
        headless: 'chrome',
        render: true,
        wait: 8000,
        wait_for_selector: 'body',
        proxy_type: 'residential',
        proxy_country: 'us',
      }),
    });

    if (!response.ok) {
      console.error('❌ Decodo error:', response.status, await response.text());
      return null;
    }

    const data = await response.json();
    const html =
      data?.results?.[0]?.content ||
      data?.results?.[0]?.html ||
      data?.content ||
      data?.html ||
      null;

    console.log('📄 HTML length:', html ? html.length : 0);

    if (html && MODE !== 'production') {
      console.log('📄 HTML preview:', html.slice(0, 1000));
    }

    return html;
  } catch (e) {
    console.error('❌ Decodo fetch error:', e.message);
    return null;
  }
}

// ===== HTML EXTRACTION =====
function extractEmbeddedJsonCandidates(html) {
  const candidates = [];

  const pushCandidate = (raw) => {
    if (!raw || typeof raw !== 'string') return;
    const s = raw.trim();
    if (s) candidates.push(s);
  };

  for (const match of html.matchAll(/<script[^>]*>\s*([\[{][\s\S]*?)<\/script>/gi)) {
    pushCandidate(match[1]);
  }

  for (const match of html.matchAll(/window\.(?:__INITIAL_STATE__|__STATE__|__DATA__)\s*=\s*({[\s\S]*?});/gi)) {
    pushCandidate(match[1]);
  }

  for (const match of html.matchAll(/JSON\.parse\(\s*"((?:\\.|[^"\\])*)"\s*\)/gi)) {
    try {
      const unescaped = JSON.parse(`"${match[1]}"`);
      pushCandidate(unescaped);
    } catch (_) {}
  }

  const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (nextDataMatch) {
    pushCandidate(nextDataMatch[1]);
  }

  return candidates;
}

function extractFromHtml(html) {
  let name = null;
  let date = null;
  let venue = null;
  let totalListings = 0;
  const prices = [];
  const seenObjects = new WeakSet();

  function addPrice(v) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0 && n < 25000) {
      prices.push(n);
    }
  }

  function maybeSetMeta(obj) {
    if (!obj || typeof obj !== 'object') return;

    const eventNameKeys = ['name', 'eventName', 'title'];
    for (const key of eventNameKeys) {
      const val = obj[key];
      if (!name && typeof val === 'string' && val.trim() && !/tickets/i.test(val)) {
        name = val.trim();
      }
    }

    const dateKeys = ['startDate', 'eventDate', 'localDate', 'date'];
    for (const key of dateKeys) {
      const val = obj[key];
      if (!date && typeof val === 'string') {
        const normalized = normalizeDateString(val);
        if (normalized) date = normalized;
      }
    }

    if (!venue) {
      const venueCandidates = [obj.venue, obj.location, obj.eventVenue, obj.venueName];
      for (const v of venueCandidates) {
        if (typeof v === 'string' && v.trim()) {
          venue = v.trim();
          break;
        }
        if (v && typeof v === 'object') {
          const vn = v.name || v.venueName;
          const city = v.address?.addressLocality || v.city || '';
          const state = v.address?.addressRegion || v.state || '';
          const built = [vn, city, state].filter(Boolean).join(', ');
          if (built) {
            venue = built;
            break;
          }
        }
      }
    }
  }

  function walk(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (seenObjects.has(obj)) return;
    seenObjects.add(obj);

    maybeSetMeta(obj);

    const listingCountKeys = [
      'totalListings',
      'listingCount',
      'numListings',
      'totalTickets',
      'numFound',
      'ticketCount',
      'availableListings',
      'listingTotal',
    ];

    for (const key of listingCountKeys) {
      if (typeof obj[key] === 'number' && obj[key] > totalListings) {
        totalListings = obj[key];
      }
    }

    const priceKeys = [
      'currentPrice',
      'listingPrice',
      'pricePerTicket',
      'minPrice',
      'maxPrice',
      'price',
      'amount',
      'displayPrice',
      'faceValue',
      'allInPrice',
      'buyerPrice',
      'sellPrice',
      'lowestPrice',
    ];

    for (const key of priceKeys) {
      const val = obj[key];
      if (typeof val === 'number') addPrice(val);
      else if (val && typeof val === 'object') {
        if (typeof val.amount === 'number') addPrice(val.amount);
        if (typeof val.value === 'number') addPrice(val.value);
      }
    }

    if (Array.isArray(obj)) {
      for (const item of obj) walk(item);
      return;
    }

    for (const k of Object.keys(obj)) {
      walk(obj[k]);
    }
  }

  const jsonLdMatches = [...html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const match of jsonLdMatches) {
    try {
      const parsed = JSON.parse(match[1]);
      walk(parsed);
    } catch (_) {}
  }

  const candidates = extractEmbeddedJsonCandidates(html);
  for (const raw of candidates) {
    try {
      const parsed = JSON.parse(raw);
      walk(parsed);
      continue;
    } catch (_) {}

    for (const inner of raw.matchAll(/({[\s\S]*})/g)) {
      try {
        const parsed = JSON.parse(inner[1]);
        walk(parsed);
      } catch (_) {}
    }
  }

  if (!totalListings) {
    const listingMatches = [
      ...html.matchAll(/(\d[\d,]*)\s+listings?/gi),
      ...html.matchAll(/(\d[\d,]*)\s+tickets?\s+from/gi),
    ]
      .map((m) => parseInt(m[1].replace(/,/g, ''), 10))
      .filter((v) => Number.isFinite(v) && v > 0);

    if (listingMatches.length) totalListings = Math.max(...listingMatches);
  }

  if (!prices.length) {
    for (const match of html.matchAll(/[$£€]\s*([\d,]+(?:\.\d{2})?)/g)) {
      const value = parseFloat(match[1].replace(/,/g, ''));
      addPrice(value);
    }
  }

  if (!name) {
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    if (titleMatch) {
      const cleaned = titleMatch[1]
        .replace(/\s*tickets\s*[-–|].*$/i, '')
        .replace(/\s*[-–|].*$/i, '')
        .trim();

      if (cleaned && !/tickets/i.test(cleaned)) {
        name = cleaned;
      }
    }
  }

  const cleanedPrices = dedupeNumbers(prices).sort((a, b) => a - b);

  console.log(
    `📊 Parsed: listings=${totalListings}, prices=${cleanedPrices.length}` +
      (cleanedPrices.length ? `, floor=$${Math.round(cleanedPrices[0])}` : '')
  );

  return { name, date, venue, totalListings, prices: cleanedPrices };
}

// ===== SCRAPE =====
async function scrapeEvent(event) {
  const eventId = event.id;
  const originalName = event.name || `Event ${eventId}`;

  try {
    const url = `https://www.stubhub.com/event/${eventId}/?quantity=0`;
    const html = await fetchWithDecodo(url);

    if (!html) {
      console.error('❌ No HTML for', eventId);
      return null;
    }

    const {
      name: parsedName,
      date: parsedDate,
      venue: parsedVenue,
      totalListings,
      prices,
    } = extractFromHtml(html);

    let name = parsedName || originalName;
    if (name && /tickets/i.test(name)) name = originalName;

    const venue = parsedVenue || event.venue || null;
    const date = parsedDate || event.date || null;

    const summary = summarizePrices(prices);

    if (!summary.floor) {
      console.log(`⚠️ No pricing for ${name}`);
      return null;
    }

    console.log(
      `✅ ${name}: ${totalListings} listings, floor $${summary.floor}, avg $${summary.avg}, ceiling $${summary.ceiling}`
    );

    await postSnapshot({
      eventId,
      eventName: name,
      eventDate: date,
      venue,
      platform: 'StubHub',
      totalListings,
      section: null,
      sectionListings: 0,
      eventFloor: summary.floor,
      eventAvg: summary.avg,
      eventCeiling: summary.ceiling,
      source: 'decodo',
    });

    const updates = {};
    if (name !== originalName) updates.name = name;
    if (venue && venue !== event.venue) updates.venue = venue;
    if (date && date !== event.date) updates.date = date;

    if (Object.keys(updates).length) {
      const { error } = await supabase.from('events').update(updates).eq('id', eventId);
      if (error) {
        console.error(`⚠️ Failed to update event ${eventId}:`, error.message);
      }
    }

    return { ok: true };
  } catch (e) {
    console.error(`❌ Failed ${eventId}:`, e.message);
    return null;
  }
}

// ===== MAIN =====
async function main() {
  console.log('🚀 MAIN STARTED');
  console.log('🧭 MODE:', MODE);

  const manualId = process.argv[2];
  const events = manualId
    ? [{ id: manualId, name: 'Manual', date: null, venue: null, platform: 'StubHub' }]
    : await getEvents();

  console.log('🎯 Events to process:', events.length);

  let scraped = 0;
  let skipped = 0;
  let failed = 0;

  for (const event of events) {
    if (!manualId) {
      const recent = await scrapedRecently(event.id);
      if (recent) {
        console.log(`⏭️ Skipping ${event.name} (recent)`);
        skipped++;
        continue;
      }
    }

    console.log(`\n🎟️ Scraping: ${event.name} (${event.id})`);

    const result = await scrapeEvent(event);
    if (result) scraped++;
    else failed++;

    await sleep(SCRAPE_DELAY_MS);
  }

  console.log(`\n✅ Done — scraped:${scraped} skipped:${skipped} failed:${failed}`);
}

main().catch((e) => {
  console.error('❌ Fatal error:', e);
  process.exit(1);
});
