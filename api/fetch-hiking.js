// api/fetch-hiking.js
// Vercel serverless function — GET /api/fetch-hiking?region=denver|norway|amsterdam
//
// v4 — SWITCHED from Overpass/OSM to Google Places, using the real
// `hiking_area` type (Table A, "Entertainment and Recreation" category).
// Modeled on fetch-pinball.js/fetch-yarn.js — no keyword scoring, no rating
// filter, just find every hiking_area-tagged place and show it.
//
// TRADEOFF, decided deliberately: this drops the trail DISTANCE stat that
// the Overpass version had (Places has no length/geometry field for a
// hiking_area — it's a point location with a rating, not a measured trail).
// In exchange: no more Overpass flakiness, no more T-junction/clustering
// mess, no more segment-duplication problems. Reliability over precision.
//
// Reuses the same GOOGLE_PLACES_API_KEY already set up — no new setup.

const REGIONS = {
  denver: { south: 39.55, west: -105.35, north: 39.85, east: -105.05 },
  norway: { south: 63.2805, west: 10.0951, north: 63.5805, east: 10.6951 },
  amsterdam: { south: 52.2176, west: 4.7541, north: 52.5176, east: 5.0541 }
};

async function searchHiking(bbox) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_PLACES_API_KEY environment variable is not set in Vercel project settings');
  }

  const body = {
    textQuery: 'hiking trail',
    includedType: 'hiking_area',
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
    businessStatus: p.businessStatus || 'OPERATIONAL',
    description: p.editorialSummary && p.editorialSummary.text ? p.editorialSummary.text : null
  };
}

module.exports = async (req, res) => {
  const regionKey = (req.query && req.query.region) || 'denver';
  const bbox = REGIONS[regionKey] || REGIONS.denver;
  try {
    const rawPlaces = await searchHiking(bbox);
    const cleaned = rawPlaces
      .map(cleanPlace)
      .filter(p => p.lat !== null && p.lng !== null)
      .filter(p => p.businessStatus === 'OPERATIONAL')
      .sort((a, b) => (b.rating || 0) - (a.rating || 0));

    res.status(200).json({
      generatedAt: new Date().toISOString(),
      region: regionKey,
      bbox,
      totalPulled: rawPlaces.length,
      trails: cleaned
    });
  } catch (e) {
    res.status(502).json({ error: 'Google Places request failed', detail: e.message });
  }
};
