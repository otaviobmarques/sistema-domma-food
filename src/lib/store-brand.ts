import "server-only";
import { storeColor } from "@/components/store/brand";

export type StoreBrand = { slug: string; name: string; description: string | null; color: string; logo_url: string | null };

/** Nome, cor e logo da loja para o manifesto e os ícones do app (cache de 5 min). */
export async function storeBrand(slug: string): Promise<StoreBrand | null> {
  if (!/^[a-z0-9-]{3,50}$/.test(slug)) return null;
  try {
    const r = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/get_store`, {
      method: "POST",
      headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, "Content-Type": "application/json" },
      body: JSON.stringify({ p_slug: slug }),
      next: { revalidate: 300 },
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return null;
    const d = (await r.json()) as { unit?: { slug: string; name: string; description: string | null; primary_color: string; logo_url: string | null } } | null;
    if (!d?.unit) return null;
    const u = d.unit;
    return { slug: u.slug, name: u.name, description: u.description, color: storeColor(u.primary_color), logo_url: u.logo_url };
  } catch { return null; }
}

/** Domínio da plataforma (o resto é domínio próprio de uma loja). */
export function isMainHost(host: string) {
  const extra = (process.env.NEXT_PUBLIC_MAIN_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  return host.endsWith(".vercel.app") || host === "localhost" || host === "127.0.0.1" || extra.includes(host);
}
