async function fetchWithDecodo(url) {
  try {
    const response = await fetch('https://scraper-api.decodo.com/v2/scrape', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Authorization': 'Basic ' + DECODO_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        url,
        proxy_pool: 'premium',
        headless: 'html',
        render: true,
        wait: 8000,
        wait_for_selector: 'script, body'
      })
    });

    if (!response.ok) {
      console.error('  Decodo error:', response.status, await response.text());
      return null;
    }

    const data = await response.json();
    const html =
      data?.results?.[0]?.content ||
      data?.results?.[0]?.html ||
      data?.content ||
      data?.html ||
      null;

    return html;
  } catch (e) {
    console.error('  Decodo fetch error:', e.message);
    return null;
  }
}

function extractEmbeddedJsonCandidates(html) {
  const candidates = [];

  const pushCandidate = (raw) => {
    if (!raw || typeof raw !== 'string') return;
    const s = raw.trim();
    if (!s) return;
    candidates.push(s);
  };

  // Plain JSON scripts
  for (const match of html.matchAll(/<script[^>]*>\s*([\[{][\s\S]*?)<\/script>/gi)) {
    pushCandidate(match[1]);
  }

  // window.__INITIAL_STATE__ = {...}
  for (const match of html.matchAll(/window\.(?:__INITIAL_STATE__|__STATE__|__DATA__)\s*=\s*({[\s\S]*?});/gi)) {
    pushCandidate(match[1]);
  }

  // JSON.parse("...")
  for (const match of html.matchAll(/JSON\.parse\(\s*"((?:\\.|[^"\\])*)"\s*\)/gi)) {
    try {
      const unescaped = JSON.parse(`"${match[1]}"`);
      pushCandidate(unescaped);
    } catch (_) {}
  }

  // Next.js / hydration blobs that contain quoted JSON fragments
  for (const match of html.matchAll(/self\.__next_f\.push\(\[.*?("(?:\\.|[^"\\])*").*?\]\)/gi)) {
    try {
      const unescaped = JSON.parse(match[1]);
      pushCandidate(unescaped);
    } catch (_) {}
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
    if (Number.isFinite(n) && n > 0 && n < 25000) prices.push(n);
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

    const dateKeys = ['startDate', 'eventDate', 'localDate'];
    for (const key of dateKeys) {
      const val = obj[key];
      if (!date && typeof val === 'string') {
        const normalized = normalizeDateString(val);
        if (normalized) date = normalized;
      }
    }

    if (!venue) {
      const venueCandidates = [
        obj.venue,
        obj.location,
        obj.eventVenue,
        obj.venueName
      ];

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
      'listingTotal'
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
      'lowestPrice'
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

  // 1) JSON-LD first
  const jsonLdMatches = [...html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const match of jsonLdMatches) {
    try {
      const parsed = JSON.parse(match[1]);
      walk(parsed);
    } catch (_) {}
  }

  // 2) Embedded/hydrated app state
  const candidates = extractEmbeddedJsonCandidates(html);
  for (const raw of candidates) {
    try {
      const parsed = JSON.parse(raw);
      walk(parsed);
      continue;
    } catch (_) {}

    // Sometimes candidate is a larger JS string that contains JSON fragments
    for (const inner of raw.matchAll(/({[\s\S]*})/g)) {
      try {
        const parsed = JSON.parse(inner[1]);
        walk(parsed);
      } catch (_) {}
    }
  }

  // 3) Regex fallback for listing count
  if (!totalListings) {
    const listingMatches = [...html.matchAll(/(\d[\d,]*)\s+listings?/gi)]
      .map(m => parseInt(m[1].replace(/,/g, ''), 10))
      .filter(v => Number.isFinite(v) && v > 0);

    if (listingMatches.length) totalListings = Math.max(...listingMatches);
  }

  // 4) Regex fallback for prices
  if (!prices.length) {
    for (const match of html.matchAll(/[$£€]\s*([\d,]+(?:\.\d{2})?)/g)) {
      const value = parseFloat(match[1].replace(/,/g, ''));
      addPrice(value);
    }
  }

  // 5) Title fallback
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

  prices.sort((a, b) => a - b);

  console.log(
    '  Parsed: listings=' + totalListings +
    ', prices=' + prices.length +
    (prices.length ? ', floor=$' + Math.round(prices[0]) : '')
  );

  return { name, date, venue, totalListings, prices };
}
