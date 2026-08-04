// api/fetch-ski.js
// Vercel serverless function — GET /api/fetch-ski?region=denver|norway|amsterdam
//
// v6 — Fast layer. Google Places only, but with real filtering this time:
// excludes by Google's own `types` classification (lodging, shops, natural
// features like peaks) AND by name keywords for junk that doesn't get a
// clearly bad type (e.g. a "Weather & Snow Report" listing). This is the
// FAST call — api/fetch-ski-supplement.js is the slower Overpass layer that
// runs after, adding real resorts this misses (confirmed miss: Loveland,
// CO — a real, well-known resort that never showed up in Places results).

const REGIONS = {
  denver: { south: 39.30, west: -106.40, north: 39.95, east: -105.00 },
  norway: { south: 62.30, west: 9.20, north: 63.70, east: 11.60 },
  amsterdam: { south: 52.0426, west: 4.2041, north: 52.6926, east: 5.6041 }
};

const EXCLUDED_TYPES = new Set([
  'lodging', 'hotel', 'motel', 'hostel', 'resort_hotel', 'extended_stay_hotel',
  'bed_and_breakfast', 'guest_house', 'inn', 'store', 'shopping_mall',
  'sporting_goods_store', 'clothing_store', 'mountain_peak', 'natural_feature'
]);
const EXCLUDED_NAME_KEYWORDS = ['weather', 'snow report', 'forecast', 'shop', 'rental', 'outfitter', 'gear'];

async function searchSkiResorts(bbox) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_PLACES_API_KEY environment variable is not set in Vercel project settings');
  }

  const body = {
    textQuery: 'ski resort',
    includedType: 'ski_resort',
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
    types: p.types || [],
    businessStatus: p.businessStatus || 'OPERATIONAL',
    source: 'places'
  };
}

function isJunk(p) {
  if (p.types.some(t => EXCLUDED_TYPES.has(t))) return true;
  const nameLower = p.name.toLowerCase();
  if (EXCLUDED_NAME_KEYWORDS.some(kw => nameLower.includes(kw))) return true;
  return false;
}

module.exports = async (req, res) => {
  const regionKey = (req.query && req.query.region) || 'denver';
  const bbox = REGIONS[regionKey] || REGIONS.denver;
  try {
    const rawPlaces = await searchSkiResorts(bbox);
    const cleaned = rawPlaces
      .map(cleanPlace)
      .filter(p => p.lat !== null && p.lng !== null)
      .filter(p => p.businessStatus === 'OPERATIONAL')
      .filter(p => !isJunk(p))
      .sort((a, b) => (b.rating || 0) - (a.rating || 0));

    res.status(200).json({
      generatedAt: new Date().toISOString(),
      region: regionKey,
      bbox,
      totalPulledBeforeFilter: rawPlaces.length,
      droppedAsJunk: rawPlaces.length - cleaned.length,
      resorts: cleaned
    });
  } catch (e) {
    res.status(502).json({ error: 'Google Places request failed', detail: e.message });
  }
};
