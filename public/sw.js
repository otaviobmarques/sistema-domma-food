/* Domma Food · app do cliente (cardápio instalável)
   - Avisos do pedido no aparelho (Web Push)
   - Página simples quando o aparelho está sem internet
   Só mexe nas páginas do cardápio e do pedido; o painel passa direto. */
const VERSION = "df-sw-1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

const OFFLINE_HTML = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sem internet</title><style>body{font-family:system-ui,sans-serif;background:#fbf7f2;color:#27272a;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;text-align:center}
button{margin-top:16px;border:0;border-radius:999px;padding:12px 22px;background:#27272a;color:#fff;font-weight:600;font-size:15px}</style></head>
<body><main><p style="font-size:42px;margin:0">📶</p><h1 style="font-size:20px">Você está sem internet</h1>
<p style="color:#71717a;max-width:300px">Assim que a conexão voltar, o cardápio e o seu pedido aparecem de novo.</p>
<button onclick="location.reload()">Tentar de novo</button></main></body></html>`;

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.mode !== "navigate" || req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || /^\/(painel|admin|login|onboarding|auth|api|entregador|totem)(\/|$)/.test(url.pathname)) return;
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
