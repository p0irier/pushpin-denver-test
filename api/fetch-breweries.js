// api/fetch-breweries.js
// Vercel serverless function — GET /api/fetch-breweries?region=denver|norway
//
// v3 — SWITCHED from Open Brewery DB to Google Places API (New) Text Search.
// Open Brewery DB had no rating/review data at all — a hard blocker for the
// "picks for you" scoring feature, since we'd have no quality signal to rank
// on. Google Places gives real rating + review count, which is exactly what
// scoring needs.
//
// Bonus: businessStatus (OPERATIONAL / CLOSED_TEMPORARILY / CLOSED_PERMANENTLY)
// solves the "filter out closed/planning breweries" item from the backlog
// more reliably than Open Brewery DB's community-maintained type tag did —
// this is live business status, not a possibly-stale community edit.
//
// REQUIRES an env var: GOOGLE_PLACES_API_KEY, set in Vercel project settings
// (Settings -> Environment Variables), never committed to the repo. The key
// stays entirely server-side — this function calls Google, the browser never
// sees the key.
//
// Known scope limit: single page, up to 20 results per region. Google Places
// (New) Text Search supports pagination up to 60 total (3 pages) — not
// implemented yet, worth adding if 20 proves too few for a region.

// v4 — added review-based keyword scoring, per Steve's preferred terms.
// This requires the `reviews` field, which bumps this call from Text Search
// Pro to Text Search Enterprise + Atmosphere pricing (~$32/1K -> ~$40/1K if
// the free allowance is ever exceeded). Still ONE call per refresh either
// way — reviews come bundled into the same request, not a separate call per
// brewery. Free allowance at this tier is 1,000 calls/month (down from
// Pro's 5,000), still comfortably enough for personal trip-planning use.
//
// IMPORTANT CACHING NOTE: because this now touches `reviews`, this data
// cannot be cached under Google's terms (reviews/ratings/names must be
// fetched live each time, unlike Overpass data which has no such
// restriction). If caching gets built later for the other categories,
// breweries specifically will need to stay live-fetch-only.
//
// We never display the actual review text to the user — only an internal
// match count derived from it — so Google's "must show reviewer attribution"
// requirement (author name/photo/link) shouldn't apply here; that rule is
// about displaying review content, not using it as a private ranking input.

const KEYWORDS = ['unique', 'enthusiast', 'ipa', 'hazy', 'new england', 'taproom', 'release'];
const MIN_RATING_NO_KEYWORDS_NEEDED = 4.6;
const MIN_KEYWORD_MATCHES_IF_BELOW_RATING = 5;

function countKeywordMatches(reviews) {
  if (!reviews || reviews.length === 0) return { count: 0, matched: [] };
  const combinedText = reviews
    .map(r => (r.text && r.text.text) ? r.text.text.toLowerCase() : '')
    .join(' ');
  const matched = KEYWORDS.filter(kw => combinedText.includes(kw));
  return { count: matched.length, matched };
}

const REGIONS = {
  denver: { south: 39.30, west: -106.40, north: 39.95, east: -105.00 },
  norway: { south: 62.30, west: 9.20, north: 63.70, east: 11.60 },
  amsterdam: { south: 52.2326, west: 4.6841, north: 52.5026, east: 5.1241 } // FIXED: was the wide multi-city Randstad box (Amsterdam+Utrecht+Rotterdam+The Hague combined) — diluted a real, prominent 4.8-rated bar (Cafe De Dokter, confirmed to exist in Google's data) out of the top 60 results by making it compete against every bar in 4 other major cities. Now Amsterdam-city-scale, matching the MTB/hiking pattern.
};

async function searchBreweries(bbox) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_PLACES_API_KEY environment variable is not set in Vercel project settings');
  }

  const body = {
    textQuery: 'craft brewery',
    maxResultCount: 20,
    locationRestriction: {
      rectangle: {
        low: { latitude: bbox.south, longitude: bbox.west },
        high: { latitude: bbox.north, longitude: bbox.east }
      }
    }
  };

  const resp = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': [
        'places.displayName',
        'places.formattedAddress',
        'places.location',
        'places.rating',
        'places.userRatingCount',
        'places.types',
        'places.websiteUri',
        'places.nationalPhoneNumber',
        'places.businessStatus',
        'places.reviews'
      ].join(',')
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Google Places returned ${resp.status}: ${errText.slice(0, 300)}`);
  }
  const data = await resp.json();
  return data.places || [];
}

function cleanPlace(p) {
  const { count, matched } = countKeywordMatches(p.reviews);
  return {
    name: p.displayName ? p.displayName.text : 'Unknown',
    address: p.formattedAddress || null,
    lat: p.location ? p.location.latitude : null,
    lng: p.location ? p.location.longitude : null,
    rating: typeof p.rating === 'number' ? p.rating : null,
    ratingCount: typeof p.userRatingCount === 'number' ? p.userRatingCount : 0,
    website: p.websiteUri || null,
    phone: p.nationalPhoneNumber || null,
    businessStatus: p.businessStatus || 'OPERATIONAL',
    keywordMatchCount: count,
    keywordsMatched: matched // e.g. ['ipa','hazy','taproom'] — kept for transparency, not displayed as review quotes
  };
}

// Filter: rating >= 4.6 always qualifies. Below that, needs at least 5 of
// the 7 preferred terms present in its (sampled) review text to still show.
function qualifiesForDisplay(b) {
  if (b.rating !== null && b.rating >= MIN_RATING_NO_KEYWORDS_NEEDED) return true;
  return b.keywordMatchCount >= MIN_KEYWORD_MATCHES_IF_BELOW_RATING;
}

module.exports = async (req, res) => {
  const regionKey = (req.query && req.query.region) || 'denver';
  const bbox = REGIONS[regionKey] || REGIONS.denver;
  try {
    const rawPlaces = await searchBreweries(bbox);
    const cleaned = rawPlaces
      .map(cleanPlace)
      .filter(b => b.lat !== null && b.lng !== null)
      .filter(b => b.businessStatus === 'OPERATIONAL')
      .filter(qualifiesForDisplay)
      .sort((a, b) => b.keywordMatchCount - a.keywordMatchCount || (b.rating || 0) - (a.rating || 0));

    res.status(200).json({
      generatedAt: new Date().toISOString(),
      region: regionKey,
      bbox,
      totalPulled: rawPlaces.length,
      droppedByFilter: rawPlaces.length - cleaned.length,
      breweries: cleaned
    });
  } catch (e) {
    res.status(502).json({ error: 'Google Places request failed', detail: e.message });
  }
};
