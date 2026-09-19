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

function fieldsOf(bike) {
  const aliases = Array.isArray(bike.aliases) ? bike.aliases : [];
  return [bike.make, bike.model, bike.year, ...aliases];
}

function rankBike(bike, qFold, qTokens) {
  const aliases = Array.isArray(bike.aliases) ? bike.aliases : [];
  for (const alias of aliases) {
    if (fold(alias) === qFold) return RANK_EXACT_ALIAS;
  }

  let best = Infinity;
  for (const field of fieldsOf(bike)) {
    const folded = fold(field);
    if (!folded) continue;
    if (folded.startsWith(qFold)) best = Math.min(best, RANK_PREFIX);
    else if (folded.includes(qFold)) best = Math.min(best, RANK_SUBSTRING);
  }
  if (best !== Infinity) return best;

  const hay = [];
  for (const field of fieldsOf(bike)) hay.push(...tokens(field));
  const hit = qTokens.some((qt) => hay.some((ht) => ht === qt || ht.includes(qt)));
  return hit ? RANK_TOKEN : Infinity;
}

function indexCatalog(catalog) {
  bikeIndex = new Map(catalog.bikes.map((row) => [row.id, row]));
  manualIndex = new Map(catalog.manuals.map((row) => [row.id, row]));
  partIndex = new Map(catalog.parts.map((row) => [row.id, row]));
  jobIndex = new Map(catalog.jobs.map((row) => [row.id, row]));
}

function validateCatalog(catalog) {
  if (!catalog || typeof catalog !== "object") {
    throw new Error("loadCatalog: catalog is not an object");
  }
  for (const key of TOP_KEYS) {
    if (!(key in catalog)) throw new Error(`loadCatalog: missing ${key}`);
  }
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
        data = catalog;
        indexCatalog(catalog);
        return catalog;
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
    .map((bike, order) => ({ bike, order, rank: rankBike(bike, qFold, qTokens) }))
    .filter((row) => row.rank !== Infinity)
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
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
  return asset(`store/manuals/${manualId}/pages/p-${String(n).padStart(4, "0")}.webp`);
}

export function thumbUrl(manualId, n) {
  return asset(`store/manuals/${manualId}/pages/t-${String(n).padStart(4, "0")}.webp`);
}
