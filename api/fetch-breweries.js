// api/fetch-breweries.js
// Vercel serverless function — GET /api/fetch-breweries.
//
// v2 — FIXED A REAL SCOPING BUG: v1 used by_city=Denver, a literal string
// match against each brewery's city field. That silently excluded any
// brewery in Golden, Frisco, Breckenridge, Idaho Springs, etc. — i.e.
// EVERYTHING near the MTB trails or ski resorts, since none of those towns
// are named "Denver." Ski/MTB/hiking all use geographic bounding boxes;
// breweries needs to match that paradigm, not a city-name string.
//
// Open Brewery DB has no native bbox parameter, so instead: pull ALL
// Colorado breweries in one call (by_state), then filter by lat/lon against
// a combined bbox covering both the metro/foothills area AND the ski resort
// spread. This is the same "geographic area of interest" concept the other
// three categories already use.

const PER_PAGE = 200;

// Each region defines which Open Brewery DB filter to use, plus the bbox to
// geo-filter against afterward. Denver stays on by_state (Colorado is small,
// fast, few pages). Norway has no state-equivalent to filter on, so it uses
// by_country instead — slower/bigger pull, but still far smaller than
// pulling worldwide.
const REGIONS = {
  denver: {
    filterParam: 'by_state',
    filterValue: 'Colorado',
    bbox: { south: 39.30, west: -106.40, north: 39.95, east: -105.00 }
  },
  norway: {
    filterParam: 'by_country',
    filterValue: 'Norway',
    bbox: { south: 62.30, west: 9.20, north: 63.70, east: 11.60 }
  }
};

async function fetchAllPages(filterParam, filterValue) {
  const results = [];
  let page = 1;
  while (true) {
    const url = `https://api.openbrewerydb.org/v1/breweries?${filterParam}=${encodeURIComponent(filterValue)}&per_page=${PER_PAGE}&page=${page}`;
    const resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!resp.ok) throw new Error(`Open Brewery DB returned ${resp.status} on page ${page}`);
    const batch = await resp.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    results.push(...batch);
    if (batch.length < PER_PAGE) break;
    page++;
  }
  return results;
}

function cleanBrewery(b) {
  return {
    id: b.id,
    name: b.name,
    breweryType: b.brewery_type || null,
    address: [b.address_1, b.city, b.state_province, b.postal_code].filter(Boolean).join(', '),
    lat: b.latitude !== null && b.latitude !== undefined ? parseFloat(b.latitude) : null,
    lng: b.longitude !== null && b.longitude !== undefined ? parseFloat(b.longitude) : null,
    phone: b.phone || null,
    website: b.website_url || null
  };
}

function withinBbox(b, bbox) {
  return b.lat >= bbox.south && b.lat <= bbox.north && b.lng >= bbox.west && b.lng <= bbox.east;
}

module.exports = async (req, res) => {
  const regionKey = (req.query && req.query.region) || 'denver';
  const region = REGIONS[regionKey] || REGIONS.denver;
  try {
    const raw = await fetchAllPages(region.filterParam, region.filterValue);
    const cleaned = raw
      .map(cleanBrewery)
      .filter(b => b.lat !== null && b.lng !== null)
      .filter(b => withinBbox(b, region.bbox));
    res.status(200).json({
      generatedAt: new Date().toISOString(),
      region: regionKey,
      bbox: region.bbox,
      totalPulled: raw.length,
      breweries: cleaned
    });
  } catch (e) {
    res.status(502).json({ error: 'Open Brewery DB request failed', detail: e.message });
  }
};
