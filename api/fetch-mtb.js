// api/fetch-mtb.js
// Vercel serverless function — GET /api/fetch-mtb?region=denver|norway
//
// Generalized to accept a region instead of a hardcoded Denver bbox, so the
// same function/logic works for a totally different country. Norway's bbox
// covers the Oppdal -> Trondheim -> Røros corridor (the actual test-case
// trip route from the travel-activity-profile).

const REGIONS = {
  denver: { south: 39.55, west: -105.35, north: 39.85, east: -105.05 },
  norway: { south: 62.30, west: 9.20, north: 63.70, east: 11.60 }
};

const SCALE_TO_IMBA_BUCKET = { 0: 0, 1: 1, 2: 2, 3: 3, 4: 3, 5: 4, 6: 4 };
const IMBA_LABELS = {
  0: 'Easiest (White)', 1: 'Easy (Green)', 2: 'Intermediate (Blue)',
  3: 'Advanced (Black)', 4: 'Expert (Double Black)'
};

// REVERTED: private.coffee as primary caused all three Overpass-based
// categories to time out at exactly 60s (Vercel's cap) in testing — strong
// signal it was down/hanging at that moment, not just slower. Back to
// overpass-api.de first (proven working tonight), private.coffee demoted to
// a fallback rather than trusted as primary without real uptime monitoring.
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];

async function overpassRequest(query) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const endpoint = OVERPASS_ENDPOINTS[attempt % OVERPASS_ENDPOINTS.length];
    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
          'User-Agent': 'pushpin-denver-test/0.1 (personal trip-planner prototype)'
        },
        body: 'data=' + encodeURIComponent(query)
      });
      if (!resp.ok) throw new Error(`${resp.status} from ${endpoint}`);
      return await resp.json();
    } catch (e) {
      lastErr = e;
      await new Promise(res => setTimeout(res, 2000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
  const h = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function wayLengthMiles(geometry) {
  let meters = 0;
  for (let i = 1; i < geometry.length; i++) meters += haversineMeters(geometry[i - 1], geometry[i]);
  return meters / 1609.34;
}

function resolveImba(tags) {
  if (tags['mtb:scale:imba'] !== undefined) {
    const v = parseInt(tags['mtb:scale:imba'], 10);
    if (!isNaN(v) && v >= 0 && v <= 4) return v;
  }
  if (tags['mtb:scale'] !== undefined) {
    const raw = tags['mtb:scale'].toString().split('-')[0];
    const v = parseInt(raw, 10);
    if (!isNaN(v) && SCALE_TO_IMBA_BUCKET[v] !== undefined) return SCALE_TO_IMBA_BUCKET[v];
  }
  return null;
}

// Union-Find (disjoint set) for grouping ways into connected clusters.
function makeUnionFind(n) {
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
  function union(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }
  return { find, union };
}

async function fetchTrails(bbox) {
  const bboxStr = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  // No name requirement anymore — clustering by physical connectivity (shared
  // node IDs) instead of by name tag, so segment naming doesn't matter to how
  // trails get grouped.
  const query = `
    [out:json][timeout:50];
    (
      way["mtb:scale"](${bboxStr});
      way["mtb:scale:imba"](${bboxStr});
    );
    out geom;
  `;
  const data = await overpassRequest(query);
  const ways = (data.elements || []).filter(
    el => el.type === 'way' && el.geometry && el.geometry.length >= 2 && el.nodes && el.nodes.length >= 2
  );
  if (ways.length === 0) return [];

  // Cluster ways whose endpoints touch the same OSM node ID — a real,
  // reliable signal they're physically connected, unlike comparing lat/lon
  // floats. A way's first/last entries in `nodes` are its endpoint node IDs.
  const uf = makeUnionFind(ways.length);
  const endpointToWayIndex = {}; // nodeId -> [wayIndex, ...]
  ways.forEach((w, i) => {
    const firstNode = w.nodes[0], lastNode = w.nodes[w.nodes.length - 1];
    [firstNode, lastNode].forEach(nodeId => {
      if (!endpointToWayIndex[nodeId]) endpointToWayIndex[nodeId] = [];
      endpointToWayIndex[nodeId].push(i);
    });
  });
  Object.values(endpointToWayIndex).forEach(indices => {
    for (let i = 1; i < indices.length; i++) uf.union(indices[0], indices[i]);
  });

  // Group way indices by cluster root.
  const clusters = {};
  ways.forEach((w, i) => {
    const root = uf.find(i);
    if (!clusters[root]) clusters[root] = [];
    clusters[root].push(w);
  });

  const trails = [];
  for (const clusterWays of Object.values(clusters)) {
    const totalMiles = Math.round(
      clusterWays.reduce((sum, w) => sum + wayLengthMiles(w.geometry), 0) * 100
    ) / 100;

    // Difficulty: most common non-null imba value across the cluster's ways.
    const imbaCounts = {};
    clusterWays.forEach(w => {
      const imba = resolveImba(w.tags || {});
      if (imba !== null) imbaCounts[imba] = (imbaCounts[imba] || 0) + 1;
    });
    let imba = null, bestCount = 0;
    for (const [k, count] of Object.entries(imbaCounts)) {
      if (count > bestCount) { bestCount = count; imba = parseInt(k, 10); }
    }

    // Display name: most common name among the cluster's ways, if any exist.
    const nameCounts = {};
    clusterWays.forEach(w => { if (w.tags && w.tags.name) nameCounts[w.tags.name] = (nameCounts[w.tags.name] || 0) + 1; });
    const names = Object.entries(nameCounts).sort((a, b) => b[1] - a[1]).map(([n]) => n);
    const displayName = names.length > 0 ? names[0] : 'Unnamed trail network';
    const nameNote = names.length > 1 ? ` (+ ${names.length - 1} other name(s) in this network)` : '';

    trails.push({
      name: displayName + nameNote,
      difficultyImba: imba,
      difficultyLabel: imba !== null ? IMBA_LABELS[imba] : 'Unrated',
      distanceMiles: totalMiles,
      segmentCount: clusterWays.length,
      description: imba !== null
        ? `Singletrack network, ${IMBA_LABELS[imba]}, ${totalMiles} mi total`
        : `Singletrack network, difficulty unrated, ${totalMiles} mi total`,
      // Full geometry kept this time — the whole point is showing real shape.
      geometry: clusterWays.map(w => w.geometry.map(pt => ({ lat: pt.lat, lon: pt.lon })))
    });
  }
  return trails;
}

module.exports = async (req, res) => {
  const regionKey = (req.query && req.query.region) || 'denver';
  const bbox = REGIONS[regionKey] || REGIONS.denver;
  try {
    const trails = await fetchTrails(bbox);
    const largestCluster = trails.reduce((max, t) => Math.max(max, t.segmentCount), 0);
    res.status(200).json({
      generatedAt: new Date().toISOString(),
      region: regionKey,
      bbox,
      trailCount: trails.length,
      largestClusterSegments: largestCluster, // if this is huge relative to others, that's the over-merging risk showing up
      trails
    });
  } catch (e) {
    res.status(502).json({ error: 'Overpass request failed', detail: e.message });
  }
};
