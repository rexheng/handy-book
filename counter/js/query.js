const DEFAULT_URL = "../store/catalog.json";
const TOP_KEYS = ["bikes", "manuals", "systems", "parts", "jobs"];

const RANK_EXACT_ALIAS = 0;
const RANK_PREFIX = 1;
const RANK_SUBSTRING = 2;
const RANK_TOKEN = 3;

let loadPromise;
let data = null;
let bikeIndex = new Map();
let manualIndex = new Map();
let systemIndex = new Map();
let partIndex = new Map();
let jobIndex = new Map();

function fold(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function tokens(value) {
  return String(value ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function textFieldsOf(bike) {
  const aliases = Array.isArray(bike.aliases) ? bike.aliases : [];
  return [bike.make, bike.model, ...aliases];
}

function yearFoldOf(bike) {
  return fold(bike.year);
}

function tokenHit(hayToken, queryToken, yearFold) {
  if (yearFold && hayToken === yearFold) return hayToken === queryToken;
  if (hayToken === queryToken) return true;
  return queryToken.length >= 3 && hayToken.startsWith(queryToken);
}

function overlapCount(hay, qTokens, yearFold) {
  return qTokens.filter((qt) => hay.some((ht) => tokenHit(ht, qt, yearFold))).length;
}

function haystackOf(bike) {
  const yearFold = yearFoldOf(bike);
  const fields = textFieldsOf(bike);
  const hay = [];
  for (const field of fields) hay.push(...tokens(field));
  if (yearFold) hay.push(yearFold);

  const makeFold = fold(bike.make);
  const glued = new Set();
  const joined = fold(fields.join(""));
  if (joined) glued.add(joined);
  if (makeFold) {
    for (const ht of hay) {
      if (ht && ht !== makeFold) glued.add(makeFold + ht);
    }
  }
  for (const extra of glued) hay.push(extra);

  return { hay, yearFold };
}

function rankBike(bike, qFold, qTokens) {
  const aliases = Array.isArray(bike.aliases) ? bike.aliases : [];
  const { hay, yearFold } = haystackOf(bike);
  const overlap = overlapCount(hay, qTokens, yearFold);

  for (const alias of aliases) {
    if (fold(alias) === qFold) return { rank: RANK_EXACT_ALIAS, overlap };
  }

  let best = Infinity;
  for (const field of textFieldsOf(bike)) {
    const folded = fold(field);
    if (!folded) continue;
    if (folded.startsWith(qFold)) best = Math.min(best, RANK_PREFIX);
    else if (folded.includes(qFold)) best = Math.min(best, RANK_SUBSTRING);
  }
  if (yearFold && yearFold.startsWith(qFold) && qFold.length === yearFold.length) {
    best = Math.min(best, RANK_PREFIX);
  }
  if (best !== Infinity) return { rank: best, overlap };

  if (qTokens.length && overlap === qTokens.length) {
    return { rank: RANK_TOKEN, overlap };
  }
  return { rank: Infinity, overlap: 0 };
}

function resetIndexes() {
  bikeIndex = new Map();
  manualIndex = new Map();
  systemIndex = new Map();
  partIndex = new Map();
  jobIndex = new Map();
}

function indexRows(rows, key) {
  const next = new Map();
  for (const row of rows) {
    if (!row || typeof row !== "object" || typeof row.id !== "string") {
      throw new Error(`loadCatalog: ${key} row is missing a string id`);
    }
    next.set(row.id, row);
  }
  return next;
}

function indexCatalog(catalog) {
  const nextBikes = indexRows(catalog.bikes, "bikes");
  const nextManuals = indexRows(catalog.manuals, "manuals");
  const nextSystems = indexRows(catalog.systems, "systems");
  const nextParts = indexRows(catalog.parts, "parts");
  const nextJobs = indexRows(catalog.jobs, "jobs");
  bikeIndex = nextBikes;
  manualIndex = nextManuals;
  systemIndex = nextSystems;
  partIndex = nextParts;
  jobIndex = nextJobs;
}

function validateCatalog(catalog) {
  if (!catalog || typeof catalog !== "object") {
    throw new Error("loadCatalog: catalog is not an object");
  }
  for (const key of TOP_KEYS) {
    if (!(key in catalog)) throw new Error(`loadCatalog: missing ${key}`);
    if (!Array.isArray(catalog[key])) throw new Error(`loadCatalog: ${key} is not an array`);
  }
}

function padPage(n) {
  return String(n).padStart(4, "0");
}

function pagesDirOf(manualId) {
  const dir = manualIndex.get(manualId)?.pagesDir;
  if (dir) {
    const value = String(dir);
    return value.endsWith("/") ? value : `${value}/`;
  }
  return `store/manuals/${manualId}/pages/`;
}

export function asset(path) {
  if (path == null || path === "") return path;
  const value = String(path);
  if (/^(?:[a-z]+:)?\/\//i.test(value) || /^(?:data|blob):/i.test(value)) return value;
  if (value.startsWith("/") || value.startsWith("../")) return value;
  return `../${value.replace(/^\.\//, "")}`;
}

export function loadCatalog(url = DEFAULT_URL) {
  if (!loadPromise) {
    loadPromise = fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`loadCatalog: ${res.status} ${url}`);
        return res.json();
      })
      .then((catalog) => {
        validateCatalog(catalog);
        indexCatalog(catalog);
        data = catalog;
        return catalog;
      })
      .catch((err) => {
        data = null;
        resetIndexes();
        loadPromise = undefined;
        throw err;
      });
  }
  return loadPromise;
}

export function catalog() {
  return data;
}

export function findBikes(text) {
  const bikes = data?.bikes ?? [];
  const qFold = fold(text ?? "");
  if (!qFold) return bikes.slice();
  const qTokens = tokens(text ?? "");
  return bikes
    .map((bike, order) => {
      const scored = rankBike(bike, qFold, qTokens);
      return { bike, order, rank: scored.rank, overlap: scored.overlap };
    })
    .filter((row) => row.rank !== Infinity)
    .sort((a, b) => a.rank - b.rank || b.overlap - a.overlap || a.order - b.order)
    .map((row) => row.bike);
}

export function bike(id) {
  return bikeIndex.get(id);
}

export function manual(id) {
  return manualIndex.get(id);
}

export function part(id) {
  return partIndex.get(id);
}

export function jobById(id) {
  return jobIndex.get(id);
}

export function job(bikeId, partId) {
  return (data?.jobs ?? []).find((row) => row.bikeId === bikeId && row.partId === partId);
}

export function systems(bikeId) {
  const wanted = new Set();
  for (const row of data?.jobs ?? []) {
    if (row.bikeId !== bikeId) continue;
    const p = partIndex.get(row.partId);
    if (p?.systemId) wanted.add(p.systemId);
  }
  return (data?.systems ?? []).filter((row) => wanted.has(row.id));
}

export function partsFor(bikeId, systemId) {
  const wanted = new Set();
  for (const row of data?.jobs ?? []) {
    if (row.bikeId !== bikeId) continue;
    const p = partIndex.get(row.partId);
    if (p?.systemId === systemId) wanted.add(p.id);
  }
  return (data?.parts ?? []).filter((row) => wanted.has(row.id));
}

export function pageUrl(manualId, n) {
  return asset(`${pagesDirOf(manualId)}p-${padPage(n)}.webp`);
}

export function thumbUrl(manualId, n) {
  return asset(`${pagesDirOf(manualId)}t-${padPage(n)}.webp`);
}
