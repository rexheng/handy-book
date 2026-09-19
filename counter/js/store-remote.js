/**
 * Remote Query layer adapter — same function names as query.js, backed by /api/*.
 * All lookups are async (fetch). Do not import this from query.js (owned elsewhere).
 *
 * Later integration switch (counter/js/app.js, not this task):
 *   import { isRemoteAvailable } from "./store-remote.js";
 *   const query = (await isRemoteAvailable()) ? await import("./store-remote.js") : await import("./query.js");
 */

const API = "/api";

async function api(path) {
  const res = await fetch(path, { headers: { Accept: "application/json" } });
  if (res.status === 503) {
    try {
      await res.json();
    } catch {
      /* ignore */
    }
    const err = new Error("remote unavailable");
    err.remote = false;
    throw err;
  }
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`store-remote: ${res.status} ${path}`);
  return res.json();
}

export async function isRemoteAvailable() {
  try {
    const res = await fetch(`${API}/bikes?q=`, { headers: { Accept: "application/json" } });
    if (!res.ok) return false;
    const body = await res.json();
    return Array.isArray(body);
  } catch {
    return false;
  }
}

export async function findBikes(text) {
  const q = encodeURIComponent(text ?? "");
  const rows = await api(`${API}/bikes?q=${q}`);
  return Array.isArray(rows) ? rows : [];
}

export async function bike(id) {
  if (id == null || id === "") return undefined;
  return api(`${API}/bikes/${encodeURIComponent(id)}`);
}

export async function manual(id) {
  if (id == null || id === "") return undefined;
  const bikes = await findBikes("");
  const row = bikes.find((b) => b?.manualId === id || b?.manual?.id === id);
  return row?.manual;
}

export async function systems(bikeId) {
  if (bikeId == null || bikeId === "") return [];
  const rows = await api(`${API}/bikes/${encodeURIComponent(bikeId)}/systems`);
  return Array.isArray(rows) ? rows : [];
}

export async function partsFor(bikeId, systemId) {
  if (bikeId == null || bikeId === "") return [];
  const q = systemId ? `?system=${encodeURIComponent(systemId)}` : "";
  const rows = await api(`${API}/bikes/${encodeURIComponent(bikeId)}/parts${q}`);
  return Array.isArray(rows) ? rows : [];
}

export async function part(id) {
  if (id == null || id === "") return undefined;
  return api(`${API}/parts/${encodeURIComponent(id)}`);
}

export async function job(bikeId, partId) {
  if (bikeId == null || partId == null || bikeId === "" || partId === "") return undefined;
  return api(`${API}/jobs/${encodeURIComponent(bikeId)}/${encodeURIComponent(partId)}`);
}

export async function jobById(id) {
  if (id == null || id === "") return undefined;
  const slash = String(id).indexOf("/");
  if (slash < 1) return undefined;
  return job(id.slice(0, slash), id.slice(slash + 1));
}
