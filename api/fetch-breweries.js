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

const REGIONS = {
  denver: { south: 39.30, west: -106.40, north: 39.95, east: -105.00 },
  norway: { south: 62.30, west: 9.20, north: 63.70, east: 11.60 }
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
        'places.businessStatus'
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
  return {
    name: p.displayName ? p.displayName.text : 'Unknown',
    address: p.formattedAddress || null,
    lat: p.location ? p.location.latitude : null,
    lng: p.location ? p.location.longitude : null,
    rating: typeof p.rating === 'number' ? p.rating : null,
    ratingCount: typeof p.userRatingCount === 'number' ? p.userRatingCount : 0,
    website: p.websiteUri || null,
    phone: p.nationalPhoneNumber || null,
    businessStatus: p.businessStatus || 'OPERATIONAL'
  };
}

module.exports = async (req, res) => {
  const regionKey = (req.query && req.query.region) || 'denver';
  const bbox = REGIONS[regionKey] || REGIONS.denver;
  try {
    const rawPlaces = await searchBreweries(bbox);
    const cleaned = rawPlaces
      .map(cleanPlace)
      .filter(b => b.lat !== null && b.lng !== null)
      .filter(b => b.businessStatus === 'OPERATIONAL'); // drop closed/temporarily-closed automatically

    res.status(200).json({
      generatedAt: new Date().toISOString(),
      region: regionKey,
      bbox,
      totalPulled: rawPlaces.length,
      breweries: cleaned
    });
  } catch (e) {
    res.status(502).json({ error: 'Google Places request failed', detail: e.message });
  }
};
