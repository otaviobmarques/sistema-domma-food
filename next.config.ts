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
const mercadoPagoCsp = buildCsp({
  script: ["https://sdk.mercadopago.com", "https://http2.mlstatic.com", "https://www.mercadopago.com"],
  style: ["https://http2.mlstatic.com"],
  img: ["https://*.mlstatic.com", "https://*.mercadopago.com", "https://www.mercadolibre.com", "https://www.mercadolivre.com"],
  font: ["https://http2.mlstatic.com"],
  connect: ["https://api.mercadopago.com", "https://api.mercadolibre.com", "https://events.mercadopago.com",
    "https://http2.mlstatic.com", "https://www.mercadopago.com", "https://*.mercadopago.com",
    // identificação do aparelho (antifraude do Mercado Pago)
    "https://www.mercadolibre.com", "https://www.mercadolivre.com"],
  frame: ["https://*.mercadopago.com", "https://*.mercadolibre.com", "https://*.mercadolivre.com"],
});

const baseHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(self), payment=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];
const securityHeaders = [{ key: "Content-Security-Policy", value: buildCsp() }, ...baseHeaders];
const paymentHeaders = [{ key: "Content-Security-Policy", value: mercadoPagoCsp }, ...baseHeaders];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  images: { remotePatterns: supabaseHost ? [{ protocol: "https", hostname: supabaseHost }] : [] },
  async headers() {
    return [
      // duas regras que não se sobrepõem (cabeçalhos repetidos seriam somados pelo navegador)
      { source: "/((?!pedido/).*)", headers: securityHeaders },
      { source: "/pedido/:path*", headers: paymentHeaders },
    ];
  },
};

export default nextConfig;
