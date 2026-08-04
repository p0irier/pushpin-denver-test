// api/fetch-bars.js
// Vercel serverless function — GET /api/fetch-bars?region=denver|norway
//
// Modeled directly on api/fetch-breweries.js — same Google Places Text
// Search + rating/keyword scoring pattern, just a different query and word
// list. See fetch-breweries.js for the fuller reasoning comments on the
// Google Places switch, caching restrictions, and pricing tier.
//
// REQUIRES the same GOOGLE_PLACES_API_KEY env var already set in Vercel —
// no additional key/setup needed, this reuses the existing one.

const KEYWORDS = ['cocktails', 'hidden', 'historic', 'vintage', 'authentic', 'quaint', 'speakeasy'];
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
  norway: { south: 62.30, west: 9.20, north: 63.70, east: 11.60 }
};

async function searchBars(bbox) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_PLACES_API_KEY environment variable is not set in Vercel project settings');
  }

  const body = {
    textQuery: 'bar pub',
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
    keywordsMatched: matched
  };
}

function qualifiesForDisplay(b) {
  if (b.rating !== null && b.rating >= MIN_RATING_NO_KEYWORDS_NEEDED) return true;
  return b.keywordMatchCount >= MIN_KEYWORD_MATCHES_IF_BELOW_RATING;
}

module.exports = async (req, res) => {
  const regionKey = (req.query && req.query.region) || 'denver';
  const bbox = REGIONS[regionKey] || REGIONS.denver;
  try {
    const rawPlaces = await searchBars(bbox);
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
      bars: cleaned
    });
  } catch (e) {
    res.status(502).json({ error: 'Google Places request failed', detail: e.message });
  }
};
