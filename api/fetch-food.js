// api/fetch-food.js
// Vercel serverless function — GET /api/fetch-food?region=denver|norway
//
// Different shape than breweries/bars: food covers all meal types and price
// points, so instead of one broad query, this runs THREE separate Google
// Places searches (breakfast, lunch, dinner), each capped to its top-rated
// results, and tags every result with which meal type it came from.
//
// Keyword scoring reuses the breweries/bars pattern, but with a LOOSER
// fallback threshold: only 5 words exist here (gem, authentic, local,
// quiet, quaint) vs breweries/bars' 7, and requiring "5 of 5" would mean
// literally every term has to appear — far stricter than the ~5-of-7 ratio
// those categories use. Per direction: 2 of 5 for the below-4.6 fallback.
//
// Reuses the same GOOGLE_PLACES_API_KEY already set up — no new setup.

const KEYWORDS = ['gem', 'authentic', 'local', 'quiet', 'quaint'];
const MIN_RATING_NO_KEYWORDS_NEEDED = 4.6;
const MIN_KEYWORD_MATCHES_IF_BELOW_RATING = 2;
const RESULTS_PER_MEAL = 5; // top of the "2-5 each" range requested

const MEAL_QUERIES = {
  breakfast: 'best breakfast restaurant',
  lunch: 'best lunch restaurant',
  dinner: 'best dinner restaurant'
};

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

async function searchMeal(bbox, mealType) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_PLACES_API_KEY environment variable is not set in Vercel project settings');
  }

  const body = {
    textQuery: MEAL_QUERIES[mealType],
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
    throw new Error(`Google Places returned ${resp.status} for ${mealType}: ${errText.slice(0, 300)}`);
  }
  const data = await resp.json();
  return data.places || [];
}

function cleanPlace(p, mealType) {
  const { count, matched } = countKeywordMatches(p.reviews);
  return {
    name: p.displayName ? p.displayName.text : 'Unknown',
    mealType,
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

function qualifiesForDisplay(f) {
  if (f.rating !== null && f.rating >= MIN_RATING_NO_KEYWORDS_NEEDED) return true;
  return f.keywordMatchCount >= MIN_KEYWORD_MATCHES_IF_BELOW_RATING;
}

module.exports = async (req, res) => {
  const regionKey = (req.query && req.query.region) || 'denver';
  const bbox = REGIONS[regionKey] || REGIONS.denver;
  try {
    const mealTypes = Object.keys(MEAL_QUERIES);
    const results = await Promise.all(mealTypes.map(async mealType => {
      const raw = await searchMeal(bbox, mealType);
      const cleaned = raw
        .map(p => cleanPlace(p, mealType))
        .filter(f => f.lat !== null && f.lng !== null)
        .filter(f => f.businessStatus === 'OPERATIONAL')
        .filter(qualifiesForDisplay)
        .sort((a, b) => (b.rating || 0) - (a.rating || 0))
        .slice(0, RESULTS_PER_MEAL);
      return { mealType, totalPulled: raw.length, spots: cleaned };
    }));

    const allSpots = results.flatMap(r => r.spots);
    const byMeal = {};
    results.forEach(r => { byMeal[r.mealType] = r.totalPulled; });

    res.status(200).json({
      generatedAt: new Date().toISOString(),
      region: regionKey,
      bbox,
      totalPulledByMeal: byMeal,
      food: allSpots
    });
  } catch (e) {
    res.status(502).json({ error: 'Google Places request failed', detail: e.message });
  }
};
