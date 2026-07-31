// fetch-breweries.js
// Run locally: node scripts/fetch-breweries.js
// Queries the free, keyless Open Brewery DB API by city. No auth, no rate-limit
// dance needed here (unlike Overpass) — this API is meant to be hit directly.
// Writes public/data/breweries-denver.json.
//
// Docs: https://www.openbrewerydb.org/documentation
// Per their own FAQ: recommended for personal projects, no SLA — fine for this use.

const fs = require('fs');
const path = require('path');

const CITY = 'Denver';
const PER_PAGE = 200; // API max

async function fetchAllPagesForCity(city) {
  const results = [];
  let page = 1;
  while (true) {
    const url = `https://api.openbrewerydb.org/v1/breweries?by_city=${encodeURIComponent(city)}&per_page=${PER_PAGE}&page=${page}`;
    const resp = await fetch(url, {
      headers: { 'Accept': 'application/json' }
    });
    if (!resp.ok) throw new Error(`Open Brewery DB returned ${resp.status} on page ${page}`);
    const batch = await resp.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    results.push(...batch);
    if (batch.length < PER_PAGE) break; // last page
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

async function main() {
  console.log(`Fetching breweries for "${CITY}" from Open Brewery DB (no key needed)...`);
  const raw = await fetchAllPagesForCity(CITY);
  console.log(`Got ${raw.length} raw records.`);

  // Drop entries missing coordinates — can't plot them on the map.
  const cleaned = raw.map(cleanBrewery).filter(b => b.lat !== null && b.lng !== null);
  const droppedCount = raw.length - cleaned.length;
  if (droppedCount > 0) {
    console.log(`Dropped ${droppedCount} record(s) with missing coordinates.`);
  }

  const output = { generatedAt: new Date().toISOString(), city: CITY, breweries: cleaned };
  const outPath = path.join(__dirname, '..', 'public', 'data', 'breweries-denver.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Wrote ${outPath} (${cleaned.length} breweries with coordinates)`);
}

main().catch(e => { console.error(e); process.exit(1); });
