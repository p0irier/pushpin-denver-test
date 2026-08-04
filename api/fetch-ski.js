// api/fetch-ski.js
// Vercel serverless function — GET /api/fetch-ski?region=denver|norway|amsterdam
//
// v5 — STRIPPED BACK to Google Places only, no Overpass, no additional
// filtering beyond dropping closed businesses. The v4 hybrid (Places
// discovery + targeted Overpass stats) surfaced real problems in testing:
// slow (two sequential API calls), a non-resort false positive (a ski shop)
// getting through the includedType filter, and still missing some expected
// resorts. Rather than debug all of that at once, this strips back to the
// simplest working version — same shape as fetch-pinball.js/fetch-yarn.js —
// so there's a known-good baseline to compare against.
//
// KNOWN TRADEOFF, accepted deliberately: no difficulty/lift/size-tier data
// anymore, just name + rating + location. The Overpass stats logic isn't
// deleted from project history — it's genuinely valuable and can come back
// once the discovery layer itself is solid.

const REGIONS = {
  denver: { south: 39.30, west: -106.40, north: 39.95, east: -105.00 },
  norway: { south: 62.30, west: 9.20, north: 63.70, east: 11.60 },
  amsterdam: { south: 52.0426, west: 4.2041, north: 52.6926, east: 5.6041 }
};

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
    businessStatus: p.businessStatus || 'OPERATIONAL'
  };
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
      .sort((a, b) => (b.rating || 0) - (a.rating || 0));

    res.status(200).json({
      generatedAt: new Date().toISOString(),
      region: regionKey,
      bbox,
      totalPulled: rawPlaces.length,
      resorts: cleaned
    });
  } catch (e) {
    res.status(502).json({ error: 'Google Places request failed', detail: e.message });
  }
};
