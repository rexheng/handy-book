const VERSION = "v1";
const SHELL = `handy-book-shell-${VERSION}`;
const RUNTIME = `handy-book-runtime-${VERSION}`;
const RUNTIME_MAX = 300;
const SCREENS = ["identify", "confirm", "pick", "book", "follow", "invoice"];

const PRECACHE = [
  "./",
  "index.html",
  "css/counter.css",
  ...SCREENS.map((id) => `css/screens/${id}.css`),
  "js/app.js",
  "js/bus.js",
  "js/query.js",
  "js/vision.js",
  ...SCREENS.map((id) => `js/screens/${id}.js`),
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-512-maskable.png",
];

function sameOrigin(url) {
  return url.origin === self.location.origin;
}

function isPdfOrOnnx(url) {
  return /\.(?:pdf|onnx)$/i.test(url.pathname);
}

function isCatalog(url) {
  return sameOrigin(url) && url.pathname.endsWith("/store/catalog.json");
}

function isImmutableStore(url) {
  if (!sameOrigin(url)) return false;
  const path = url.pathname;
  if (path.includes("/store/img/")) return true;
  return /\/store\/manuals\/.+\/pages\//.test(path);
}

async function precache() {
  const cache = await caches.open(SHELL);
  await Promise.all(
    PRECACHE.map((url) =>
      cache.add(url).catch((err) => {
        console.warn("precache skip", url, err);
      })
    )
  );
}

async function dropOldCaches() {
  const keep = new Set([SHELL, RUNTIME]);
  const keys = await caches.keys();
  await Promise.all(keys.filter((key) => !keep.has(key)).map((key) => caches.delete(key)));
}

async function trimRuntime(cache) {
  const keys = await cache.keys();
  while (keys.length > RUNTIME_MAX) {
    await cache.delete(keys.shift());
  }
}

async function putRuntime(request, response) {
  if (!response || !response.ok) return;
  if (response.type !== "basic" && response.type !== "cors") return;
  const cache = await caches.open(RUNTIME);
  await cache.put(request, response.clone());
  await trimRuntime(cache);
}

async function cacheFirst(request) {
  const cache = await caches.open(RUNTIME);
  const hit = await cache.match(request);
  if (hit) {
    await cache.delete(request);
    await cache.put(request, hit.clone());
    return hit;
  }
  const response = await fetch(request);
  await putRuntime(request, response);
  return response;
}

async function networkFirst(request) {
  const cache = await caches.open(RUNTIME);
  try {
    const response = await fetch(request);
    await putRuntime(request, response);
    return response;
  } catch (err) {
    const hit = await cache.match(request);
    if (hit) return hit;
    throw err;
  }
}

function shouldShellCache(request, response) {
  if (!response.ok) return false;
  if (response.type !== "basic" && response.type !== "cors") return false;
  const url = new URL(request.url);
  if (!sameOrigin(url) || isPdfOrOnnx(url) || isCatalog(url) || isImmutableStore(url)) return false;
  return url.pathname === "/counter" || url.pathname.startsWith("/counter/");
}

async function shellFirst(request) {
  const cache = await caches.open(SHELL);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (shouldShellCache(request, response)) {
      await cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    if (request.mode === "navigate") {
      const fallback = (await cache.match("./")) || (await cache.match("index.html"));
      if (fallback) return fallback;
    }
    throw err;
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(dropOldCaches().then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") return;

  if (isPdfOrOnnx(url)) {
    event.respondWith(fetch(request));
    return;
  }
  if (isCatalog(url)) {
    event.respondWith(networkFirst(request));
    return;
  }
  if (isImmutableStore(url)) {
    event.respondWith(cacheFirst(request));
    return;
  }
  event.respondWith(shellFirst(request));
});
