// Service worker for the Aisle Freight Scheduler PWA shell.
// Caches the app's own files so the three screens keep working with a flaky
// or absent connection during a shift. Does NOT cache the Tesseract.js OCR
// library or its language data (loaded from a CDN by the photo-import
// feature) — those still need a connection the first time they're used in
// a session.
// Bumped v3 -> v4: worker_roster.html (no query string) is one of the
// install-time precached CORE_ASSETS below, and the fetch handler only
// refreshes that cache entry on a SUCCESSFUL network fetch — on a flaky
// store connection, a failed fetch silently falls back to whatever was
// cached at install time, with no error and no visible sign anything's
// stale. Bumping the name forces activate() to wipe every old cache and
// start clean, so this can't keep quietly serving a months-old build
// through the plain nav-tab link while a query-stringed URL (like
// worker_roster.html?edit=<id>, which was never precached and almost
// always requires an actual network hit) shows the real, current version.
// Bumped v4 -> v5: added zone_priority.html as a 4th core screen — same
// "bump on any CORE_ASSETS change" rule, otherwise a phone that installed
// under v4 would never precache the new page for offline use until some
// unrelated cache-busting event happened to come along.
const CACHE_NAME = "aisle-scheduler-v5";
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./worker_roster.html",
  "./review_correct.html",
  "./output_schedule.html",
  "./zone_priority.html",
  "./assignment_engine.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

// Network-first, cache as a fallback: always try to get the latest file
// from GitHub Pages first, and only fall back to the cached copy if there's
// no connection. This is the opposite tradeoff from stale-while-revalidate
// (that approach always showed one-reload-old content, which meant every
// fix needed a manual cache-clear on the phone before it would show up —
// not worth the offline speed boost while this is still actively being
// built and tested). Still falls back to cache when truly offline.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // don't try to cache CDN scripts

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
