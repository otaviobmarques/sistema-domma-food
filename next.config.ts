import type { NextConfig } from "next";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const supabaseHost = supabaseUrl.replace(/^https?:\/\//, "");

// Cabeçalhos de segurança aplicados a todas as páginas.
type CspExtra = Partial<Record<"script" | "style" | "img" | "font" | "connect" | "frame", string[]>>;
function buildCsp(extra: CspExtra = {}) {
  const add = (k: keyof CspExtra) => (extra[k]?.length ? " " + extra[k]!.join(" ") : "");
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${add("script")}`,
    `style-src 'self' 'unsafe-inline'${add("style")}`,
    `img-src 'self' data: blob: https://${supabaseHost}${add("img")}`,
    `font-src 'self' data:${add("font")}`,
    `connect-src 'self' https://${supabaseHost} wss://${supabaseHost}${add("connect")}`,
    ...(extra.frame?.length ? [`frame-src ${extra.frame.join(" ")}`] : []),
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

// Página do pedido: libera o formulário seguro de cartão do Mercado Pago.
const mercadoPago: CspExtra = {
  script: ["https://sdk.mercadopago.com", "https://http2.mlstatic.com", "https://www.mercadopago.com"],
  style: ["https://http2.mlstatic.com"],
  img: ["https://*.mlstatic.com", "https://*.mercadopago.com", "https://www.mercadolibre.com", "https://www.mercadolivre.com"],
  font: ["https://http2.mlstatic.com"],
  connect: ["https://api.mercadopago.com", "https://api.mercadolibre.com", "https://events.mercadopago.com",
    "https://http2.mlstatic.com", "https://www.mercadopago.com", "https://*.mercadopago.com",
    // identificação do aparelho (antifraude do Mercado Pago)
    "https://www.mercadolibre.com", "https://www.mercadolivre.com"],
  frame: ["https://*.mercadopago.com", "https://*.mercadolibre.com", "https://*.mercadolivre.com"],
};

// Pixel do Meta, Google Analytics 4 e Google Ads: só nas páginas públicas da loja
// (o cardápio só carrega essas ferramentas depois do aceite de cookies).
const tracking: CspExtra = {
  script: ["https://connect.facebook.net", "https://www.googletagmanager.com", "https://googleads.g.doubleclick.net", "https://www.googleadservices.com"],
  img: ["https://www.facebook.com", "https://*.google-analytics.com", "https://*.googletagmanager.com", "https://googleads.g.doubleclick.net",
    "https://www.google.com", "https://www.google.com.br", "https://*.g.doubleclick.net"],
  connect: ["https://www.facebook.com", "https://connect.facebook.net", "https://*.google-analytics.com", "https://*.analytics.google.com",
    "https://*.googletagmanager.com", "https://googleads.g.doubleclick.net", "https://www.google.com", "https://www.google.com.br", "https://*.g.doubleclick.net"],
  frame: ["https://td.doubleclick.net", "https://www.googletagmanager.com"],
};
const merge = (...xs: CspExtra[]) => {
  const out: CspExtra = {};
  for (const x of xs) for (const k of Object.keys(x) as (keyof CspExtra)[]) out[k] = [...(out[k] ?? []), ...x[k]!];
  return out;
};
const storeCsp = buildCsp(tracking);
const orderCsp = buildCsp(merge(mercadoPago, tracking));

// Domínios da plataforma (o resto é domínio próprio de loja, que só serve o cardápio)
const mainHosts = [".+\\.vercel\\.app", "localhost", "127\\.0\\.0\\.1",
  ...(process.env.NEXT_PUBLIC_MAIN_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean).map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))];
const MAIN_HOST_RE = `(${mainHosts.join("|")})`;

const baseHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(self), payment=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];
const securityHeaders = [{ key: "Content-Security-Policy", value: buildCsp() }, ...baseHeaders];
const storeHeaders = [{ key: "Content-Security-Policy", value: storeCsp }, ...baseHeaders];
const orderHeaders = [{ key: "Content-Security-Policy", value: orderCsp }, ...baseHeaders];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  images: { remotePatterns: supabaseHost ? [{ protocol: "https", hostname: supabaseHost }] : [] },
  async headers() {
    return [
      // regras que não se sobrepõem (cabeçalhos repetidos seriam somados pelo navegador)
      { source: "/pedido/:path*", headers: orderHeaders },
      { source: "/loja/:path*", headers: storeHeaders },
      { source: "/((?!pedido/|loja/).*)", has: [{ type: "host", value: MAIN_HOST_RE }], headers: securityHeaders },
      // domínio próprio da loja: "/" é o cardápio (reescrito para /loja/<slug>)
      { source: "/((?!pedido/|loja/).*)", missing: [{ type: "host", value: MAIN_HOST_RE }], headers: storeHeaders },
    ];
  },
};

export default nextConfig;
