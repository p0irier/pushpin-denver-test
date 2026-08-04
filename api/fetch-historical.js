// api/fetch-historical.js
// Vercel serverless function — GET /api/fetch-historical?region=denver|norway
//
// Different query shape than breweries/bars/food: instead of one text
// search, this runs FOUR parallel searches, one per Google Places TYPE
// (historical_landmark, cultural_landmark, monument, tourist_attraction),
// using the `includedType` filter so results are structurally tagged as
// that type, not just text-matched. Merged, deduped by name, then ranked
// and HARD-CAPPED AT 5 — per direction, this cap is the "junk filter":
// rather than showing everything found, only the most notable candidates
// survive.
//
// Ranking signal: rating + review count, with a boost for having a
// Google-written editorialSummary present (a real signal something is
// genuinely notable/documented, not just a random historical plaque with no
// real profile). editorialSummary also doubles as an actual description —
// same Enterprise+Atmosphere tier already used by breweries/bars/food, no
// new API key needed.

const RESULT_CAP = 5;
const TYPES_TO_SEARCH = ['historical_landmark', 'cultural_landmark', 'monument', 'tourist_attraction'];

const REGIONS = {
  denver: { south: 39.30, west: -106.40, north: 39.95, east: -105.00 },
  norway: { south: 62.30, west: 9.20, north: 63.70, east: 11.60 },
  amsterdam: { south: 52.0426, west: 4.2041, north: 52.6926, east: 5.6041 }
};

async function searchByType(bbox, includedType) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_PLACES_API_KEY environment variable is not set in Vercel project settings');
  }

  const body = {
    textQuery: includedType.replace(/_/g, ' '),
    includedType,
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
        'places.businessStatus',
        'places.editorialSummary'
      ].join(',')
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Google Places returned ${resp.status} for ${includedType}: ${errText.slice(0, 300)}`);
  }
  const data = await resp.json();
  return data.places || [];
}

function cleanPlace(p, matchedType) {
  return {
    name: p.displayName ? p.displayName.text : 'Unknown',
    matchedType,
    address: p.formattedAddress || null,
    lat: p.location ? p.location.latitude : null,
    lng: p.location ? p.location.longitude : null,
    rating: typeof p.rating === 'number' ? p.rating : null,
    ratingCount: typeof p.userRatingCount === 'number' ? p.userRatingCount : 0,
    website: p.websiteUri || null,
    businessStatus: p.businessStatus || 'OPERATIONAL',
    description: p.editorialSummary && p.editorialSummary.text ? p.editorialSummary.text : null
  };
}

function score(p) {
  const summaryBoost = p.description ? 1000 : 0; // having a real description outweighs raw rating differences
  const ratingScore = (p.rating || 0) * 10;
  const countScore = Math.min(p.ratingCount || 0, 500) / 50; // diminishing returns past 500 reviews
  return summaryBoost + ratingScore + countScore;
}

module.exports = async (req, res) => {
  const regionKey = (req.query && req.query.region) || 'denver';
  const bbox = REGIONS[regionKey] || REGIONS.denver;
  try {
    const resultsByType = await Promise.all(
      TYPES_TO_SEARCH.map(async type => {
        const raw = await searchByType(bbox, type);
        return raw.map(p => cleanPlace(p, type));
      })
    );

    const merged = resultsByType.flat();

    // Dedup by name — the same place can legitimately match multiple types
    // (a historic building that's also a tourist attraction), and would
    // otherwise appear twice.
    const byName = new Map();
    merged.forEach(p => {
      if (!p.lat || !p.lng || p.businessStatus !== 'OPERATIONAL') return;
      if (!byName.has(p.name)) byName.set(p.name, p);
    });

    const ranked = Array.from(byName.values())
      .sort((a, b) => score(b) - score(a))
      .slice(0, RESULT_CAP);

    res.status(200).json({
      generatedAt: new Date().toISOString(),
      region: regionKey,
      bbox,
      totalCandidatesFound: merged.length,
      totalUniqueCandidates: byName.size,
      resultCap: RESULT_CAP,
      historical: ranked
    });
  } catch (e) {
    res.status(502).json({ error: 'Google Places request failed', detail: e.message });
  }
};
