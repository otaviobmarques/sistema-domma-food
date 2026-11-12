import { storeBrand, isMainHost } from "@/lib/store-brand";

/** Manifesto do app da loja: cada loja instala como um app próprio na tela do celular. */
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const b = await storeBrand(slug);
  if (!b) return new Response("Loja não encontrada", { status: 404 });
  const host = (req.headers.get("host") ?? "").toLowerCase().split(":")[0];
  // no domínio próprio o cardápio fica em "/"
  const start = isMainHost(host) ? `/loja/${b.slug}` : "/";
  const icon = (s: number, purpose?: string) => ({ src: `/loja/${b.slug}/app-icon/${s}${purpose ? "?m=1" : ""}`, sizes: `${s}x${s}`, type: "image/png", ...(purpose ? { purpose } : {}) });
  const manifest = {
    id: start,
    name: b.name,
    short_name: b.name.length > 14 ? b.name.split(/\s+/).slice(0, 2).join(" ").slice(0, 14) : b.name,
    description: b.description || `Peça em ${b.name} direto pelo app.`,
    lang: "pt-BR",
    dir: "ltr",
    start_url: `${start}${start.includes("?") ? "&" : "?"}utm_source=app`,
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#fbf7f2",
    theme_color: b.color,
    categories: ["food", "shopping"],
    icons: [icon(192), icon(512), icon(512, "maskable")],
  };
  return new Response(JSON.stringify(manifest), {
    headers: { "Content-Type": "application/manifest+json; charset=utf-8", "Cache-Control": "public, max-age=300" },
  });
}
