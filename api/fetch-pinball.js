// api/fetch-pinball.js
// Vercel serverless function — GET /api/fetch-pinball?region=denver|norway
//
// Placeholder until Pinball Map's own API access comes through (pending
// approval as of tonight). This just finds arcade/pinball-tagged venues via
// Google Places — no keyword scoring, no complex filtering, per direction:
// "if there is a tag for pinball and/or arcade, that will suffice."
//
// Reuses the same GOOGLE_PLACES_API_KEY already set up — no new setup.
// When Pinball Map access arrives, this can be swapped out or run alongside
// it (Pinball Map would have actual per-machine data Google never will).

const REGIONS = {
  denver: { south: 39.30, west: -106.40, north: 39.95, east: -105.00 },
  norway: { south: 62.30, west: 9.20, north: 63.70, east: 11.60 },
  amsterdam: { south: 52.0426, west: 4.2041, north: 52.6926, east: 5.6041 }
};

async function searchPinball(bbox) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_PLACES_API_KEY environment variable is not set in Vercel project settings');
  }

  const body = {
    textQuery: 'arcade pinball',
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
      // No reviews field needed here — no keyword scoring for this category,
      // so this stays on the cheaper Text Search Pro tier, not Enterprise+Atmosphere.
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
    const rawPlaces = await searchPinball(bbox);
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
      pinball: cleaned
    });
  } catch (e) {
    res.status(502).json({ error: 'Google Places request failed', detail: e.message });
  }
};
