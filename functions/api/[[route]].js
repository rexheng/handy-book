/**
 * Cloudflare Pages Function — thin Elastic proxy for Handy Book.
 * Holds env.ELASTIC_API_KEY; never returns it. Same-origin CORS. 60s GET cache.
 *
 * GET /api/bikes?q=
 * GET /api/bikes/:id
 * GET /api/bikes/:id/systems
 * GET /api/bikes/:id/parts?system=
 * GET /api/jobs/:bikeId/:partId  (Elastic _id is bikeId__partId, never slash)
 * GET /api/pages/:manualId/:n
 * GET /api/search?q=
 * GET /api/parts/:id
 * GET /api/catalog  ({bikes, systems, parts, manuals}; no jobs)
 */

const CACHE = "public, max-age=60";

function corsHeaders(request) {
  const url = new URL(request.url);
  return {
    "Access-Control-Allow-Origin": url.origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Accept, Content-Type",
    Vary: "Origin",
  };
}

function json(request, body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": status === 200 ? CACHE : "no-store",
      ...corsHeaders(request),
      ...extra,
    },
  });
}

function unavailable(request) {
  return json(request, { remote: false }, 503);
}

function segments(params) {
  const route = params?.route;
  if (route == null || route === "") return [];
  return Array.isArray(route) ? route : [route];
}

function configured(env) {
  return Boolean(env?.ELASTIC_URL && env?.ELASTIC_API_KEY);
}

async function esFetch(env, method, path, body) {
  const url = `${String(env.ELASTIC_URL).replace(/\/$/, "")}${path}`;
  const headers = {
    Authorization: `ApiKey ${env.ELASTIC_API_KEY}`,
    Accept: "application/json",
  };
  const init = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: "invalid elasticsearch response" };
    }
  }
  return { ok: res.ok, status: res.status, data };
}

function sources(data) {
  const hits = data?.hits?.hits;
  if (!Array.isArray(hits)) return [];
  return hits.map((h) => h._source).filter(Boolean);
}

function bikesSearchBody(q) {
  if (!q) {
    return { query: { match_all: {} }, size: 50, sort: [{ seq: "asc" }] };
  }
  return {
    size: 20,
    query: {
      bool: {
        should: [
          {
            multi_match: {
              query: q,
              type: "bool_prefix",
              fields: [
                "aliases",
                "aliases._2gram",
                "aliases._3gram",
                "model",
                "make",
              ],
            },
          },
          { match: { model: { query: q, boost: 3 } } },
          { match: { make: q } },
          { term: { "id": q } },
        ],
        minimum_should_match: 1,
      },
    },
  };
}

async function getBike(env, id) {
  const { ok, status, data } = await esFetch(env, "GET", `/hb-bikes/_doc/${encodeURIComponent(id)}`);
  if (status === 404 || !ok) return null;
  return data._source || null;
}

async function getPart(env, id) {
  const { ok, status, data } = await esFetch(env, "GET", `/hb-parts/_doc/${encodeURIComponent(id)}`);
  if (status === 404 || !ok) return null;
  return data._source || null;
}

async function termsGet(env, index, field, ids, sortSeq = true) {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return [];
  const body = {
    size: Math.max(uniq.length, 16),
    query: { terms: { [field]: uniq } },
  };
  if (sortSeq) body.sort = [{ seq: "asc" }];
  const { ok, data } = await esFetch(env, "POST", `/${index}/_search`, body);
  if (!ok) return null;
  return sources(data);
}

async function handleGet(context) {
  const { request, env, params } = context;
  if (!configured(env)) return unavailable(request);

  const parts = segments(params).map((s) => decodeURIComponent(s));
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();

  try {
    if (parts[0] === "bikes" && parts.length === 1) {
      const { ok, status, data } = await esFetch(env, "POST", "/hb-bikes/_search", bikesSearchBody(q));
      if (!ok) return json(request, { remote: true, error: "search failed" }, status || 502);
      return json(request, sources(data));
    }

    if (parts[0] === "bikes" && parts.length === 2) {
      const bike = await getBike(env, parts[1]);
      if (!bike) return json(request, { error: "not found" }, 404);
      return json(request, bike);
    }

    if (parts[0] === "bikes" && parts.length === 3 && parts[2] === "systems") {
      const { ok, data } = await esFetch(env, "POST", "/hb-jobs/_search", {
        size: 0,
        query: { term: { bikeId: parts[1] } },
        aggs: { sys: { terms: { field: "systemId", size: 32 } } },
      });
      if (!ok) return json(request, { remote: true, error: "search failed" }, 502);
      const ids = (data?.aggregations?.sys?.buckets || []).map((b) => b.key);
      const rows = await termsGet(env, "hb-systems", "id", ids);
      if (rows == null) return json(request, { remote: true, error: "search failed" }, 502);
      return json(request, rows);
    }

    if (parts[0] === "bikes" && parts.length === 3 && parts[2] === "parts") {
      const system = (url.searchParams.get("system") || "").trim();
      const filters = [{ term: { bikeId: parts[1] } }];
      if (system) filters.push({ term: { systemId: system } });
      const { ok, data } = await esFetch(env, "POST", "/hb-jobs/_search", {
        size: 200,
        query: { bool: { filter: filters } },
        _source: ["partId"],
      });
      if (!ok) return json(request, { remote: true, error: "search failed" }, 502);
      const ids = sources(data).map((j) => j.partId);
      const rows = await termsGet(env, "hb-parts", "id", ids);
      if (rows == null) return json(request, { remote: true, error: "search failed" }, 502);
      return json(request, rows);
    }

    if (parts[0] === "jobs" && parts.length === 3) {
      const id = `${parts[1]}__${parts[2]}`;
      const { ok, status, data } = await esFetch(
        env,
        "GET",
        `/hb-jobs/_doc/${encodeURIComponent(id)}`,
      );
      if (status === 404 || !ok) return json(request, { error: "not found" }, 404);
      return json(request, data._source || {});
    }

    if (parts[0] === "pages" && parts.length === 3) {
      const n = Number(parts[2]);
      if (!Number.isInteger(n) || n < 1) return json(request, { error: "bad page" }, 400);
      const id = `${parts[1]}__${n}`;
      const { ok, status, data } = await esFetch(
        env,
        "GET",
        `/hb-pages/_doc/${encodeURIComponent(id)}`,
      );
      if (status === 404 || !ok) return json(request, { error: "not found" }, 404);
      const src = data._source || {};
      return json(request, {
        manualId: src.manualId,
        page: src.page,
        printedPage: src.printedPage,
        ocr: src.ocr,
        chars: src.text ? String(src.text).length : 0,
      });
    }

    if (parts[0] === "search" && parts.length === 1) {
      if (!q) return json(request, { hits: [] });
      const { ok, status, data } = await esFetch(env, "POST", "/hb-pages/_search", {
        size: 20,
        query: { match: { text: q } },
        highlight: {
          fields: { text: { fragment_size: 180, number_of_fragments: 1 } },
        },
        _source: ["manualId", "page", "printedPage", "ocr"],
      });
      if (!ok) return json(request, { remote: true, error: "search failed" }, status || 502);
      const hits = (data?.hits?.hits || []).map((h) => ({
        ...(h._source || {}),
        score: h._score,
        highlight: h.highlight?.text?.[0] || "",
      }));
      return json(request, { hits });
    }

    if (parts[0] === "parts" && parts.length === 2) {
      const part = await getPart(env, parts[1]);
      if (!part) return json(request, { error: "not found" }, 404);
      return json(request, part);
    }

    if (parts[0] === "catalog" && parts.length === 1) {
      const [bikesRes, systemsRes, partsRes] = await Promise.all([
        esFetch(env, "POST", "/hb-bikes/_search", {
          query: { match_all: {} },
          size: 50,
          sort: [{ seq: "asc" }],
        }),
        esFetch(env, "POST", "/hb-systems/_search", {
          query: { match_all: {} },
          size: 50,
          sort: [{ seq: "asc" }],
        }),
        esFetch(env, "POST", "/hb-parts/_search", {
          query: { match_all: {} },
          size: 200,
          sort: [{ seq: "asc" }],
        }),
      ]);
      if (!bikesRes.ok || !systemsRes.ok || !partsRes.ok) {
        return json(request, { remote: true, error: "search failed" }, 502);
      }
      const bikes = sources(bikesRes.data);
      const manuals = [];
      const seen = new Set();
      for (const b of bikes) {
        const m = b?.manual;
        const id = m?.id;
        if (!m || !id || seen.has(id)) continue;
        seen.add(id);
        manuals.push(m);
      }
      return json(request, {
        bikes,
        systems: sources(systemsRes.data),
        parts: sources(partsRes.data),
        manuals,
      });
    }

    return json(request, { error: "not found" }, 404);
  } catch (err) {
    return json(request, { remote: true, error: "proxy failed" }, 502);
  }
}

export async function onRequest(context) {
  const method = context.request.method;
  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(context.request) });
  }
  if (method !== "GET" && method !== "HEAD") {
    return json(context.request, { error: "method not allowed" }, 405);
  }
  const res = await handleGet(context);
  if (method === "HEAD") {
    return new Response(null, { status: res.status, headers: res.headers });
  }
  return res;
}
