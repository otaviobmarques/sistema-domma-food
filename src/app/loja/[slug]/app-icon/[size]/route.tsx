import { ImageResponse } from "next/og";
import { storeBrand } from "@/lib/store-brand";

const SIZES = new Set([180, 192, 512]);

/** Busca o logo (PNG, JPEG ou WebP) e devolve como data URL para o gerador de imagem. */
async function logoDataUrl(url: string | null): Promise<string | null> {
  if (!url || !/^https:\/\//.test(url)) return null;
  try {
    const r = await fetch(url, { next: { revalidate: 3600 }, signal: AbortSignal.timeout(5000) });
    const type = (r.headers.get("content-type") ?? "").split(";")[0].trim();
    if (!r.ok || !["image/png", "image/jpeg", "image/webp"].includes(type)) return null;
    let buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 4_000_000) return null;
    if (type === "image/webp") {
      // o gerador não lê WebP: converte para PNG (sharp vem com o Next); sem ele, usa a inicial
      const sharp = (await import("sharp")).default;
      buf = await sharp(buf).resize(512, 512, { fit: "cover" }).png().toBuffer();
      return `data:image/png;base64,${buf.toString("base64")}`;
    }
    return `data:${type};base64,${buf.toString("base64")}`;
  } catch { return null; }
}

/** Ícone do app da loja: logo (ou a inicial) sobre a cor da loja. ?m=1 = versão "maskable" com margem. */
export async function GET(req: Request, { params }: { params: Promise<{ slug: string; size: string }> }) {
  const { slug, size } = await params;
  const s = Number(size);
  if (!SIZES.has(s)) return new Response("Tamanho inválido", { status: 404 });
  const b = await storeBrand(slug);
  if (!b) return new Response("Loja não encontrada", { status: 404 });
  const maskable = new URL(req.url).searchParams.get("m") === "1";
  const logo = await logoDataUrl(b.logo_url);
  const inner = Math.round(s * (maskable ? 0.62 : 0.8));
  const img = new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: b.color }}>
        {logo ? (
          // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
          <img src={logo} width={inner} height={inner} style={{ borderRadius: inner / 2, objectFit: "cover", background: "#fff" }} />
        ) : (
          <div style={{ width: inner, height: inner, borderRadius: inner / 2, background: "rgba(255,255,255,0.16)", display: "flex",
            alignItems: "center", justifyContent: "center", color: "#fff", fontSize: Math.round(inner * 0.56), fontWeight: 800 }}>
            {b.name.trim().slice(0, 1).toUpperCase()}
          </div>
        )}
      </div>
    ),
    { width: s, height: s },
  );
  img.headers.set("Cache-Control", "public, max-age=3600, s-maxage=3600");
  return img;
}
