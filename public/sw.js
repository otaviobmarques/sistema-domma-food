/* Domma Food · service worker
   - App do cliente: avisos do pedido no aparelho (Web Push) e página simples sem internet
   - Caixa (PDV) offline: guarda a tela /painel/caixa e os arquivos dela para abrir sem internet
   O resto do painel passa direto. */
const VERSION = "df-sw-2";
const PANEL = "df-caixa-1";        // tela do caixa (apagada ao sair da conta)
const STATIC = "df-static-1";      // arquivos de /_next/static (nome com hash, nunca mudam)
const KEEP = [VERSION, PANEL, STATIC];
const CAIXA = "/painel/caixa";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (!KEEP.includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

const OFFLINE_HTML = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sem internet</title><style>body{font-family:system-ui,sans-serif;background:#fbf7f2;color:#27272a;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;text-align:center}
button{margin-top:16px;border:0;border-radius:999px;padding:12px 22px;background:#27272a;color:#fff;font-weight:600;font-size:15px}</style></head>
<body><main><p style="font-size:42px;margin:0">📶</p><h1 style="font-size:20px">Você está sem internet</h1>
<p style="color:#71717a;max-width:300px">Assim que a conexão voltar, o cardápio e o seu pedido aparecem de novo.</p>
<button onclick="location.reload()">Tentar de novo</button></main></body></html>`;

async function fromCaixa(event) {
  const id = event.clientId || event.resultingClientId;
  const c = id ? await self.clients.get(id) : null;
  return !!c && new URL(c.url).pathname.startsWith(CAIXA);
}
async function trim(cache, max) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

self.addEventListener("message", (event) => {
  // ao sair da conta: apaga a tela guardada (tem o nome da loja e o e-mail de quem entrou)
  if (event.data && event.data.type === "logout") event.waitUntil(caches.delete(PANEL));
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // tela do caixa: sempre tenta a internet; sem conexão, abre a última versão guardada
  if (req.mode === "navigate" && url.pathname === CAIXA) {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok && !res.redirected) { const c = await caches.open(PANEL); await c.put(CAIXA, res.clone()); }
        return res;
      } catch {
        const hit = await caches.match(CAIXA, { cacheName: PANEL });
        return hit || new Response(OFFLINE_HTML.replace("Assim que a conexão voltar, o cardápio e o seu pedido aparecem de novo.",
          "A tela do caixa ainda não foi guardada neste aparelho. Abra o caixa com internet uma vez para poder vender sem conexão depois."), { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
    })());
    return;
  }
  // arquivos do Next: do cache quando houver; guarda os que a tela do caixa usa
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith((async () => {
      const hit = await caches.match(req, { cacheName: STATIC });
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok && (await fromCaixa(event))) {
        const c = await caches.open(STATIC); await c.put(req, res.clone()); await trim(c, 400);
      }
      return res;
    })());
    return;
  }
  // imagens e ícones da própria plataforma usados pelo caixa: internet primeiro, cópia guardada sem conexão
  if (req.mode !== "navigate" && req.destination === "image" && !url.searchParams.has("_rsc")) {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok && (await fromCaixa(event))) { const c = await caches.open(PANEL); await c.put(req, res.clone()); }
        return res;
      } catch {
        const hit = await caches.match(req, { cacheName: PANEL });
        if (hit) return hit;
        throw new Error("offline");
      }
    })());
    return;
  }

  if (req.mode !== "navigate") return;
  if (/^\/(painel|admin|login|onboarding|auth|api|entregador|totem)(\/|$)/.test(url.pathname)) return;
  event.respondWith(fetch(req).catch(() => new Response(OFFLINE_HTML, { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } })));
});

self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { title: "Atualização do pedido", body: event.data ? event.data.text() : "" }; }
  const title = d.title || "Atualização do seu pedido";
  event.waitUntil(self.registration.showNotification(title, {
    body: d.body || "", icon: d.icon || undefined, badge: d.icon || undefined,
    tag: d.tag || undefined, renotify: !!d.tag, data: { url: d.url || "/" }, lang: "pt-BR",
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin);
  if (target.origin !== self.location.origin) return;
  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of list) {
      if (new URL(c.url).pathname === target.pathname && "focus" in c) return c.focus();
    }
    for (const c of list) {
      // reaproveita só uma janela do cardápio ou de pedido (nunca o painel)
      if (/^\/(loja|pedido)\//.test(new URL(c.url).pathname) && "navigate" in c && "focus" in c) { await c.navigate(target.href); return c.focus(); }
    }
    return self.clients.openWindow(target.href);
  })());
});
