const CACHE_PREFIX = "project-notebook-";
const CACHE_NAME = `${CACHE_PREFIX}realignment-shell-v3`;
const MAX_CACHE_ENTRIES = 80;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const ATLAS_PATH = "/assets/anatomy/authority-atlas-206.glb";
const MAX_ATLAS_RESPONSE_BYTES = 8 * 1024 * 1024;
const SHELL_URLS = [
  "/manifest.webmanifest",
  "/covers/composition-marble-template.png",
];

async function cacheApplicationShell() {
  const cache = await caches.open(CACHE_NAME);
  const shellResponse = await fetch("/desk", { cache: "reload" });
  if (!shellResponse.ok) throw new Error("The notebook shell could not be cached.");
  if (!await putBoundedResponse(cache, "/desk", shellResponse)) {
    throw new Error("The notebook shell exceeds the offline cache policy.");
  }
  const html = await shellResponse.text();
  const assets = [...html.matchAll(/(?:src|href)="(\/_next\/static\/[^"?]+(?:\?[^" ]*)?)"/g)]
    .map((match) => match[1]);
  for (const asset of [...SHELL_URLS, ...new Set(assets)]) {
    const response = await fetch(asset, { cache: "reload" });
    if (!await putBoundedResponse(cache, asset, response)) {
      throw new Error(`Offline asset ${asset} exceeds the cache policy.`);
    }
  }
}

function isNotebookRequest(request, url) {
  if (url.origin !== self.location.origin) return false;
  if (request.mode === "navigate") return url.pathname === "/" || url.pathname === "/desk";
  return isExactAtlasUrl(url) || url.pathname.startsWith("/_next/static/") || SHELL_URLS.includes(url.pathname);
}

function isExactAtlasUrl(url) {
  return url.origin === self.location.origin && url.pathname === ATLAS_PATH && url.search === "";
}

function responseLimitForRequest(request) {
  const requestUrl = new URL(
    typeof request === "string" ? request : request.url,
    self.location.origin,
  );
  return isExactAtlasUrl(requestUrl)
    ? MAX_ATLAS_RESPONSE_BYTES
    : MAX_RESPONSE_BYTES;
}

async function isCacheableResponse(request, response) {
  if (!response.ok || (response.type !== "basic" && response.type !== "default")) return false;
  const responseLimit = responseLimitForRequest(request);
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declaredLength) || declaredLength > responseLimit) return false;
  return (await response.clone().arrayBuffer()).byteLength <= responseLimit;
}

async function trimCache(cache) {
  const keys = await cache.keys();
  const excess = keys.length - MAX_CACHE_ENTRIES;
  if (excess <= 0) return;
  await Promise.all(keys.slice(0, excess).map((key) => cache.delete(key)));
}

async function putBoundedResponse(cache, request, response) {
  if (!await isCacheableResponse(request, response)) return false;
  await cache.put(request, response.clone());
  await trimCache(cache);
  return true;
}

async function fetchAtlasCacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached !== undefined) return cached;
  try {
    const response = await fetch(request);
    await putBoundedResponse(cache, request, response);
    return response;
  } catch {
    return Response.error();
  }
}

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(cacheApplicationShell());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
            .map((name) => caches.delete(name)),
        ),
      ),
      self.clients.claim(),
    ]),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !isNotebookRequest(request, url)
  ) {
    return;
  }

  if (isExactAtlasUrl(url)) {
    event.respondWith(fetchAtlasCacheFirst(request));
    return;
  }

  event.respondWith(
    fetch(request)
      .then(async (response) => {
        const cache = await caches.open(CACHE_NAME);
        await putBoundedResponse(cache, request, response);
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached !== undefined) return cached;
        if (request.mode === "navigate" && url.origin === self.location.origin) {
          const shell = await caches.match("/desk");
          if (shell !== undefined) return shell;
        }
        return Response.error();
      }),
  );
});
