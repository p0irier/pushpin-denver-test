// api/fetch-mtb.js
// Vercel serverless function — GET /api/fetch-mtb?region=denver|norway
//
// Generalized to accept a region instead of a hardcoded Denver bbox, so the
// same function/logic works for a totally different country. Norway's bbox
// covers the Oppdal -> Trondheim -> Røros corridor (the actual test-case
// trip route from the travel-activity-profile).

// FIXED: was reusing the wide ski-corridor bbox (built for spread-out
// resorts), which is ~15-20x the AREA of Denver's tight metro box — that
// mismatch alone explains why Norway returned 2,200+ raw MTB segments vs
// Denver's few hundred. MTB/hiking need a dense LOCAL trail-system box, not
// a whole-trip-corridor box. Centered on Trondheim (the corridor's actual
// city, most likely to have real mapped trail infrastructure), sized
// comparably to Denver's metro box.
const REGIONS = {
  denver: { south: 39.55, west: -105.35, north: 39.85, east: -105.05 },
  norway: { south: 63.2805, west: 10.0951, north: 63.5805, east: 10.6951 },
  amsterdam: { south: 52.2176, west: 4.7541, north: 52.5176, east: 5.0541 }
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
    el => el.type === 'way' && el.geometry && el.geometry.length >= 2
  );
  if (ways.length === 0) return [];

  // v3 clustering: v2 only checked endpoint-to-endpoint proximity, which
  // misses T-junctions — a very common real case where a spur trail's end
  // meets the MIDDLE of a longer trail, not its tip. That connection was
  // never being detected, which is the likely main reason real trail
  // networks were still splitting into many small clusters.
  //
  // Fix: check each way's two endpoints against EVERY point of every other
  // way, not just other ways' endpoints. Doing this brute-force (O(n^2 *
  // points-per-way)) would be far too slow at scale (Norway alone returned
  // 2,200+ raw segments) — so points are bucketed into a spatial grid first,
  // and each endpoint only checks nearby grid cells instead of every point
  // in the dataset.
  const CONNECT_TOLERANCE_METERS = 40; // widened from 25m — real-world gaps (unmapped connectors, parking lot crossings) can exceed a tight tolerance even when it's clearly the same network
  const GRID_DEG = 0.0006; // ~50-65m cells depending on latitude, coarser than the tolerance so neighboring-cell checks reliably catch it

  function cellKey(lat, lon) {
    return `${Math.floor(lat / GRID_DEG)},${Math.floor(lon / GRID_DEG)}`;
  }

  // Bucket every point of every way into the grid, tagged with which way it belongs to.
  const grid = new Map();
  ways.forEach((w, wayIdx) => {
    w.geometry.forEach(pt => {
      const key = cellKey(pt.lat, pt.lon);
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push({ wayIdx, lat: pt.lat, lon: pt.lon });
    });
  });

  function nearbyCandidates(lat, lon) {
    const baseLat = Math.floor(lat / GRID_DEG);
    const baseLon = Math.floor(lon / GRID_DEG);
    const results = [];
    for (let dLat = -1; dLat <= 1; dLat++) {
      for (let dLon = -1; dLon <= 1; dLon++) {
        const key = `${baseLat + dLat},${baseLon + dLon}`;
        if (grid.has(key)) results.push(...grid.get(key));
      }
    }
    return results;
  }

  const uf = makeUnionFind(ways.length);
  ways.forEach((w, wayIdx) => {
    const endpoints = [w.geometry[0], w.geometry[w.geometry.length - 1]];
    endpoints.forEach(ep => {
      const candidates = nearbyCandidates(ep.lat, ep.lon);
      candidates.forEach(c => {
        if (c.wayIdx === wayIdx) return; // don't compare a way against itself
        if (haversineMeters(ep, c) <= CONNECT_TOLERANCE_METERS) {
          uf.union(wayIdx, c.wayIdx);
        }
      });
    });
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

    // Back to a single dot per cluster — per direction, drawing every
    // segment's real shape was too visually distracting. Centroid computed
    // across ALL points in the cluster (not just one way's first point) so
    // the dot lands somewhere reasonably central to the whole network.
    const allPoints = clusterWays.flatMap(w => w.geometry);
    const centroidLat = allPoints.reduce((sum, p) => sum + p.lat, 0) / allPoints.length;
    const centroidLon = allPoints.reduce((sum, p) => sum + p.lon, 0) / allPoints.length;

    trails.push({
      name: displayName + nameNote,
      lat: centroidLat,
      lon: centroidLon,
      difficultyImba: imba,
      difficultyLabel: imba !== null ? IMBA_LABELS[imba] : 'Unrated',
      distanceMiles: totalMiles,
      segmentCount: clusterWays.length,
      description: imba !== null
        ? `Singletrack network, ${IMBA_LABELS[imba]}, ${totalMiles} mi total`
        : `Singletrack network, difficulty unrated, ${totalMiles} mi total`
    });
  }

  // Smarter than a blunt "5+ miles only" cutoff, which would punish real
  // small trail networks just as hard as genuine junk. Instead: drop only
  // ISOLATED stubs — clusters made of a single segment AND short. A short
  // cluster that's made of MULTIPLE connected segments is more likely a
  // real (if small) trail network, and gets kept regardless of length.
  const ISOLATED_STUB_MAX_MILES = 0.5;
  const filtered = trails.filter(t => !(t.segmentCount === 1 && t.distanceMiles < ISOLATED_STUB_MAX_MILES));

  return filtered;
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
