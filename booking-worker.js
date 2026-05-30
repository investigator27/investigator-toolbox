/**
 * Investigator Toolbox — Booking.com lookup (Cloudflare Worker)
 * ------------------------------------------------------------
 * Replaces the local PowerShell scraper so the Hotel Finder works from a
 * static GitHub Pages site (no investigator PC required).
 *
 * The browser page calls:
 *   https://<your-worker>.workers.dev/?destination=...&lat=...&lng=...&chkin=...&chkout=...&adults=2&amenities=FREE_PARKING&amenities=...
 *
 * It returns JSON:
 *   { ok: boolean, hotels: [ { name, url, lat, lng, distanceText, distanceKm,
 *                              price, priceValue, taxesText, taxesValue,
 *                              taxesIncluded, reviewScore, reviewWord, reviewCount } ],
 *     error: string, source: 'booking.com' }
 *
 * Deploy: see cloudflare/README.md in this repo.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const reqUrl = new URL(request.url);
    const p = reqUrl.searchParams;
    const destination = p.get('destination') || '';
    const lat = p.get('lat') || '';
    const lng = p.get('lng') || '';
    const chkin = p.get('chkin') || '';
    const chkout = p.get('chkout') || '';
    const adults = p.get('adults') || '2';
    const amenities = p.getAll('amenities');

    try {
      const bookingUrl = buildBookingUrl({ destination, lat, lng, chkin, chkout, adults, amenities });
      const html = await fetchBookingHtml(bookingUrl, env);
      if (!html) {
        return jsonResponse({ ok: false, hotels: [], error: 'Booking.com returned no content.', source: 'booking.com' });
      }

      // Diagnostics: add &debug=1 to the URL to inspect what Booking/ScraperAPI returned.
      if (p.get('debug')) {
        const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        const lower = html.toLowerCase();
        return jsonResponse({
          debug: true,
          bookingUrl,
          htmlLength: html.length,
          title: titleMatch ? titleMatch[1].trim().slice(0, 200) : '',
          markers: {
            propertyCard: html.includes('data-testid="property-card"'),
            hasNextData: html.includes('__NEXT_DATA__'),
            displayNameCount: (html.match(/"displayName"/g) || []).length,
            hotelLinkCount: (normalizeHtmlForParse(html).match(/\/hotel\/ca\/[a-z0-9\-]+\.[a-z\-]*html/gi) || []).length,
            parsedCount: parseBookingHotels(html).length,
            consent: lower.includes('before you continue'),
            captcha: lower.includes('captcha'),
            searchresults: lower.includes('searchresults'),
          },
          snippet: html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 800),
        });
      }
      const hotels = parseBookingHotels(html);

      if (!hotels.length) {
        const diag = analyzeBookingHtml(html);
        return jsonResponse({
          ok: false,
          hotels: [],
          error: describeBookingFailure(diag),
          source: 'booking.com',
          diag,
        });
      }
      return jsonResponse({ ok: true, hotels, error: '', source: 'booking.com' });
    } catch (err) {
      return jsonResponse({ ok: false, hotels: [], error: String((err && err.message) || err), source: 'booking.com' });
    }
  },
};

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS_HEADERS },
  });
}

function buildBookingUrl({ destination, lat, lng, chkin, chkout, adults, amenities }) {
  const params = new URLSearchParams();
  if (destination) params.set('ss', destination);
  if (lat && lng) {
    params.set('latitude', lat);
    params.set('longitude', lng);
    params.set('order', 'distance_from_search');
  }
  if (chkin) params.set('checkin', chkin);
  if (chkout) params.set('checkout', chkout);
  params.set('group_adults', String(adults || '2'));
  params.set('no_rooms', '1');
  params.set('selected_currency', 'CAD');

  const nflt = [];
  for (const a of amenities) {
    switch (a) {
      case 'FREE_BREAKFAST': nflt.push('mealplan=1'); break;
      case 'FREE_PARKING': nflt.push('hotelfacility=2'); break;
      case 'FREE_CANCELLATION': nflt.push('fc=2'); break;
      case 'HOTELS_MOTELS_ONLY':
        nflt.push('ht_id=204', 'ht_id=205', 'ht_id=206', 'ht_id=218', 'ht_id=221');
        break;
      default: break;
    }
  }
  if (nflt.length) params.set('nflt', nflt.join(';'));

  return 'https://www.booking.com/searchresults.html?' + params.toString();
}

/** Cloudflare Workers must finish the whole request in ~30s — keep ScraperAPI time budget tight. */
const WORKER_FETCH_BUDGET_MS = 28000;

async function fetchBookingHtml(url, env) {
  const scraperKey = env && env.SCRAPER_API_KEY;
  if (!scraperKey) {
    throw new Error(
      'SCRAPER_API_KEY is not set on this Worker. Cloudflare → booking-lookup → Settings → Variables → add SCRAPER_API_KEY → Encrypt → Save and deploy.'
    );
  }
  return await Promise.race([
    fetchViaScraperApi(url, scraperKey),
    new Promise((_, reject) => {
      setTimeout(
        () =>
          reject(
            new Error(
              'Booking lookup timed out on the server (28s). Try again, or turn off amenity filters to speed up the search.'
            )
          ),
        WORKER_FETCH_BUDGET_MS
      );
    }),
  ]);
}

async function fetchViaScraperApi(targetUrl, apiKey) {
  // Booking.com is ScraperAPI "Protected" — requires premium (~10 credits/search).
  // One primary fetch; optional short render retry only when the page looks like search results but unparsed.
  const log = [];
  const primary = { label: 'premium+ca', render: false, premium: true, countryCode: 'ca', maxTimeout: 20000 };
  const first = await scraperApiFetch(targetUrl, apiKey, primary);
  log.push(`${primary.label}: HTTP ${first.status}, ${first.html.length} bytes${first.detail ? ` (${first.detail})` : ''}`);

  if (parseBookingHotels(first.html).length > 0) return first.html;
  if (first.html.length > 80000) return first.html;

  if (shouldRetryWithRender(first.html)) {
    const retry = { label: 'premium+render+ca', render: true, premium: true, countryCode: 'ca', maxTimeout: 10000 };
    const second = await scraperApiFetch(targetUrl, apiKey, retry);
    log.push(`${retry.label}: HTTP ${second.status}, ${second.html.length} bytes${second.detail ? ` (${second.detail})` : ''}`);
    if (parseBookingHotels(second.html).length > 0) return second.html;
    if (second.html.length > first.html.length) return second.html;
  }

  if (first.html.length > 100000) return first.html;

  throw new Error(
    log.join(' | ') +
      ' — Check scraperapi.com/dashboard for credits. After changing Variables, click Save and deploy.'
  );
}

async function scraperApiFetch(targetUrl, apiKey, { render, premium, countryCode, maxTimeout }) {
  const params = new URLSearchParams({ api_key: apiKey, url: targetUrl });
  if (countryCode) params.set('country_code', countryCode);
  params.set('device_type', 'desktop');
  params.set('max_timeout', String(maxTimeout || 20000));
  if (render) params.set('render', 'true');
  if (premium) params.set('premium', 'true');
  const proxied = 'https://api.scraperapi.com/?' + params.toString();
  try {
    const resp = await fetch(proxied, { redirect: 'follow' });
    const text = await resp.text();
    let detail = '';
    if (!resp.ok && text.length < 500) {
      detail = text.replace(/\s+/g, ' ').trim().slice(0, 120);
    }
    if (resp.status === 401 || resp.status === 403) {
      return { html: '', status: resp.status, detail: detail || 'invalid API key or no credits' };
    }
    // Some error statuses still return a usable HTML body.
    const html = text.length > 10000 ? text : resp.ok ? text : '';
    return { html, status: resp.status, detail };
  } catch (err) {
    return { html: '', status: 0, detail: String(err.message || err) };
  }
}

function shouldRetryWithRender(html) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1] : '';
  return html.length > 200000 && /search results/i.test(title);
}

function normalizeHtmlForParse(html) {
  return String(html || '')
    .replace(/\\u002F/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/\\u0026/gi, '&');
}

function analyzeBookingHtml(html) {
  const norm = normalizeHtmlForParse(html);
  const lower = norm.toLowerCase();
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim().slice(0, 200) : '';
  const isSearchPage = /search results/i.test(title);
  return {
    htmlLength: html.length,
    title,
    propertyCard: html.includes('data-testid="property-card"'),
    hotelLinks: (norm.match(/\/hotel\/ca\/[a-z0-9\-]+\.[a-z\-]*html/gi) || []).length,
    hasNextData: norm.includes('__NEXT_DATA__') || norm.includes('searchQueries'),
    jsonHotelNames: (norm.match(/"displayName"/gi) || []).length,
    consent: !isSearchPage && (lower.includes('before you continue') || lower.includes('gdpr consent')),
    captcha: !isSearchPage && (lower.includes('captcha') || lower.includes('recaptcha')),
    botChallenge:
      !isSearchPage &&
      (lower.includes('are you human') ||
        lower.includes('pardon our interruption') ||
        lower.includes('access denied')),
  };
}

function describeBookingFailure(diag) {
  if (diag.captcha || diag.botChallenge) {
    return 'Booking.com served a bot/captcha page to the proxy. Try again in a minute.';
  }
  if (/search results/i.test(diag.title) && diag.hasNextData) {
    return 'Booking.com returned a search page but listings could not be parsed. Redeploy the latest Worker and try again.';
  }
  if (diag.consent) {
    return 'Booking.com showed a consent page instead of listings. Try again.';
  }
  return `Booking.com returned no listings (${diag.htmlLength} bytes, title: "${diag.title || 'unknown'}").`;
}

function decodeEntities(value) {
  if (!value) return '';
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseBookingHotels(html) {
  const fromCards = parseFromPropertyCards(html);
  if (fromCards.length) return fromCards;
  const fromJson = parseFromEmbeddedJson(html);
  if (fromJson.length) return fromJson;
  return parseBookingHotelsFromLinks(html);
}

function parseFromPropertyCards(html) {
  const results = [];
  const seen = new Set();
  const marker = 'data-testid="property-card"';

  // Split the page into per-card blocks.
  const indices = [];
  let idx = html.indexOf(marker);
  while (idx !== -1) {
    indices.push(idx);
    idx = html.indexOf(marker, idx + marker.length);
  }
  const blocks = [];
  if (indices.length) {
    for (let i = 0; i < indices.length; i++) {
      const start = indices[i];
      const end = i + 1 < indices.length ? indices[i + 1] : html.length;
      blocks.push(html.slice(start, end));
    }
  } else {
    blocks.push(html);
  }

  for (const block of blocks) {
    let m;

    m = block.match(/data-testid="title"[^>]*>\s*([^<]+?)\s*</);
    const name = m ? decodeEntities(m[1]) : '';
    if (!name || name.length < 3) continue;

    m = block.match(/(\/hotel\/ca\/[a-z0-9\-]+\.[a-z\-]*html)/i);
    const path = m ? m[1] : '';

    let lat = null, lng = null;
    m = block.match(/data-atlas-latlng="([-0-9.]+),([-0-9.]+)"/);
    if (m) { lat = parseFloat(m[1]); lng = parseFloat(m[2]); }

    m = block.match(/data-testid="distance"[^>]*>\s*([^<]+?)\s*</);
    const distanceText = m ? decodeEntities(m[1]) : '';
    let distanceKm = null;
    let dm = distanceText.match(/([\d]+(?:\.[\d]+)?)\s*km/);
    if (dm) distanceKm = parseFloat(dm[1]);
    else {
      dm = distanceText.match(/([\d]+(?:\.[\d]+)?)\s*m\b/);
      if (dm) distanceKm = Math.round((parseFloat(dm[1]) / 1000) * 100) / 100;
    }

    m = block.match(/data-testid="price-and-discounted-price"[^>]*>\s*([^<]+?)\s*</);
    const price = m ? decodeEntities(m[1]) : '';
    let priceValue = null;
    let pm = price.match(/([\d][\d,]*)/);
    if (pm) priceValue = parseInt(pm[1].replace(/,/g, ''), 10);

    m = block.match(/data-testid="taxes-and-charges"[^>]*>\s*([^<]+?)\s*</);
    const taxesText = m ? decodeEntities(m[1]) : '';
    let taxesValue = null;
    let taxesIncluded = false;
    if (taxesText) {
      if (/includ/i.test(taxesText)) { taxesIncluded = true; taxesValue = 0; }
      else {
        const tm = taxesText.match(/([\d][\d,]*)/);
        if (tm) taxesValue = parseInt(tm[1].replace(/,/g, ''), 10);
      }
    }

    let reviewScore = '', reviewWord = '', reviewCount = null;
    const rsIdx = block.indexOf('data-testid="review-score"');
    if (rsIdx !== -1) {
      const rsChunk = block.slice(rsIdx, rsIdx + 700).replace(/<[^>]+>/g, ' ');
      const rsText = decodeEntities(rsChunk);
      let sm = rsText.match(/Scored\s+([\d](?:[.,]\d+)?)/);
      if (sm) reviewScore = sm[1].replace(',', '.');
      else { sm = rsText.match(/\b([\d](?:[.,]\d+)?)\b/); if (sm) reviewScore = sm[1].replace(',', '.'); }
      const wm = rsText.match(/\b(Wonderful|Superb|Fabulous|Excellent|Very good|Good|Pleasant|Okay|Review score)\b/i);
      if (wm) reviewWord = wm[1];
      const cm = rsText.match(/([\d,]+)\s+reviews?/);
      if (cm) reviewCount = parseInt(cm[1].replace(/,/g, ''), 10);
    }

    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    results.push({
      name,
      url: path ? 'https://www.booking.com' + path : '',
      lat,
      lng,
      distanceText,
      distanceKm,
      price,
      priceValue,
      taxesText,
      taxesValue,
      taxesIncluded,
      reviewScore,
      reviewWord,
      reviewCount,
    });
  }

  return results;
}

/** Extract hotels from __NEXT_DATA__ or GraphQL JSON blobs embedded in the page. */
function parseFromEmbeddedJson(html) {
  const norm = normalizeHtmlForParse(html);
  const results = [];
  const seen = new Set();

  const add = (rawName, rawPath, extra = {}) => {
    const name = decodeEntities(String(rawName || '').trim());
    const path = String(rawPath || '').trim();
    if (!name || name.length < 3 || !path.includes('/hotel/')) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const url = path.startsWith('http') ? path : 'https://www.booking.com' + (path.startsWith('/') ? path : '/' + path);
    results.push({
      name,
      url,
      lat: extra.lat ?? null,
      lng: extra.lng ?? null,
      distanceText: extra.distanceText || '',
      distanceKm: extra.distanceKm ?? null,
      price: extra.price || '',
      priceValue: extra.priceValue ?? null,
      taxesText: extra.taxesText || '',
      taxesValue: extra.taxesValue ?? null,
      taxesIncluded: false,
      reviewScore: extra.reviewScore || '',
      reviewWord: extra.reviewWord || '',
      reviewCount: extra.reviewCount ?? null,
    });
  };

  // __NEXT_DATA__ script (common on Booking search pages).
  const ndMatch = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (ndMatch) {
    try {
      walkJsonForHotels(JSON.parse(ndMatch[1]), add);
    } catch { /* ignore */ }
  }

  // GraphQL / capla JSON in page (displayName + pageName pairs).
  const reA =
    /"displayName"\s*:\s*\{\s*"__typename"\s*:\s*"[^"]*"\s*,\s*"text"\s*:\s*"((?:\\.|[^"\\])*)"\s*\}[\s\S]{0,3000}?"pageName"\s*:\s*"(\/hotel\/[^"]+)"/g;
  const reB = /"displayName"\s*:\s*"((?:\\.|[^"\\])*)"[\s\S]{0,2000}?"pageName"\s*:\s*"(\/hotel\/[^"]+)"/g;
  for (const re of [reA, reB]) {
    let m;
    while ((m = re.exec(norm)) !== null) {
      add(unescapeJsonFragment(m[1]), m[2]);
    }
  }

  // pageName with nearby basic name in same object chunk.
  const reC = /"pageName"\s*:\s*"(\/hotel\/ca\/[^"]+)"[\s\S]{0,1200}?"name"\s*:\s*"((?:\\.|[^"\\])*)"/g;
  let m;
  while ((m = reC.exec(norm)) !== null) {
    add(unescapeJsonFragment(m[2]), m[1]);
  }

  return results;
}

function unescapeJsonFragment(s) {
  try {
    return JSON.parse('"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"');
  } catch {
    return String(s).replace(/\\"/g, '"');
  }
}

function walkJsonForHotels(node, add, depth = 0) {
  if (!node || depth > 30) return;
  if (Array.isArray(node)) {
    node.forEach((item) => walkJsonForHotels(item, add, depth + 1));
    return;
  }
  if (typeof node !== 'object') return;

  const dn = node.displayName;
  const name =
    typeof dn === 'string' ? dn : dn && typeof dn.text === 'string' ? dn.text : node.name || node.hotelName;
  let pageName = node.pageName;
  if (node.basicPropertyData && node.basicPropertyData.pageName) {
    pageName = node.basicPropertyData.pageName;
    if (!name && node.basicPropertyData.name) {
      /* name field on basicPropertyData is often an id */
    }
  }
  if (name && pageName && String(pageName).includes('/hotel/')) {
    add(name, pageName);
  }

  for (const key of Object.keys(node)) {
    walkJsonForHotels(node[key], add, depth + 1);
  }
}

/** Fallback when property-card blocks are missing but hotel links exist in HTML. */
function parseBookingHotelsFromLinks(html) {
  const norm = normalizeHtmlForParse(html);
  const results = [];
  const seen = new Set();
  const re = /href="(\/hotel\/ca\/[a-z0-9\-]+\.[a-z\-]*html)"[^>]*aria-label="([^"]+)"/gi;
  let m;
  while ((m = re.exec(norm)) !== null) {
    const path = m[1];
    const name = decodeEntities(m[2]);
    if (!name || name.length < 3) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      name,
      url: 'https://www.booking.com' + path,
      lat: null,
      lng: null,
      distanceText: '',
      distanceKm: null,
      price: '',
      priceValue: null,
      taxesText: '',
      taxesValue: null,
      taxesIncluded: false,
      reviewScore: '',
      reviewWord: '',
      reviewCount: null,
    });
  }
  return results;
}
