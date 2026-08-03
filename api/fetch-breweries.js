// api/fetch-breweries.js
// Vercel serverless function — GET /api/fetch-breweries.
// Open Brewery DB is free/keyless with no meaningful rate limit, so this is
// the simplest of the four functions — no retry/backoff dance needed.

const CITY = 'Denver';
const PER_PAGE = 200;

async function fetchAllPagesForCity(city) {
  const results = [];
  let page = 1;
  while (true) {
    const url = `https://api.openbrewerydb.org/v1/breweries?by_city=${encodeURIComponent(city)}&per_page=${PER_PAGE}&page=${page}`;
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

module.exports = async (req, res) => {
  try {
    const raw = await fetchAllPagesForCity(CITY);
    const cleaned = raw.map(cleanBrewery).filter(b => b.lat !== null && b.lng !== null);
    res.status(200).json({ generatedAt: new Date().toISOString(), city: CITY, breweries: cleaned });
  } catch (e) {
    res.status(502).json({ error: 'Open Brewery DB request failed', detail: e.message });
  }
};
