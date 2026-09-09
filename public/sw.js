var CACHE_NAME = "rep-tracker-shell-v2";
var SHELL_FILES = [
  "/",
  "/index.html",
  "/app.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png"
];

self.addEventListener("install", function(event){
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache){ return cache.addAll(SHELL_FILES); })
  );
});

self.addEventListener("activate", function(event){
  event.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.filter(function(k){ return k !== CACHE_NAME; }).map(function(k){ return caches.delete(k); }));
    }).then(function(){ return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function(event){
  var req = event.request;
  if(req.method !== "GET") return;
  var url = new URL(req.url);
  if(url.pathname.indexOf("/api/") === 0) return;

  // Network-first: always prefer fresh code/content when online, so app
  // updates show up immediately. Fall back to the cached shell whenever the
  // network is unreachable OR returns a non-OK response — a tunnel/proxy
  // error page (e.g. ngrok's 502 when the local server is down) resolves
  // as a "successful" fetch, not a thrown error, so !res.ok must also
  // trigger the fallback, not just a rejected promise.
  event.respondWith(
    fetch(req).then(function(res){
      if(res && res.ok){
        var resClone = res.clone();
        caches.open(CACHE_NAME).then(function(cache){ cache.put(req, resClone); });
        return res;
      }
      return caches.match(req).then(function(cached){ return cached || res; });
    }).catch(function(){
      return caches.match(req);
    })
  );
});
