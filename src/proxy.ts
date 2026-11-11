import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const MAIN_URL = "https://domma-food.vercel.app";
const EXTRA_MAIN_HOSTS = (process.env.NEXT_PUBLIC_MAIN_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);

/** Domínio da plataforma (painel, site, prévias da Vercel e ambiente local). */
function isMainHost(host: string) {
  return host.endsWith(".vercel.app") || host === "localhost" || host === "127.0.0.1" || EXTRA_MAIN_HOSTS.includes(host);
}

// Cache por instância: domínio → slug da loja (ou null), por 60 s
const domainCache = new Map<string, { slug: string | null; exp: number }>();
async function slugForHost(host: string): Promise<string | null> {
  const hit = domainCache.get(host);
  if (hit && hit.exp > Date.now()) return hit.slug;
  let slug: string | null = null;
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/get_unit_by_domain`, {
      method: "POST",
      headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, "Content-Type": "application/json" },
      body: JSON.stringify({ p_host: host }),
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) slug = (await res.json()) as string | null;
    else if (hit) return hit.slug;        // falha momentânea: mantém o último valor conhecido
  } catch {
    if (hit) return hit.slug;
  }
  domainCache.set(host, { slug, exp: Date.now() + 60_000 });
  return slug;
}

/** Domínio próprio de loja: serve o cardápio daquela loja; painel e login só no domínio da plataforma. */
async function customDomain(request: NextRequest, host: string) {
  const path = request.nextUrl.pathname;
  const slug = await slugForHost(host);
  if (!slug) return NextResponse.redirect(MAIN_URL, 307);
  if (/^\/(painel|admin|login|onboarding|auth)(\/|$)/.test(path)) return NextResponse.redirect(MAIN_URL + path + request.nextUrl.search, 307);
  if (/^\/(pedido|mesa|entregador|api)(\/|$)/.test(path)) return NextResponse.next();
  const m = path.match(/^\/loja\/([^/]+)(\/.*)?$/);
  if (m) {
    // outra loja não abre pelo domínio desta
    return m[1] === slug ? NextResponse.next() : NextResponse.redirect(MAIN_URL + path, 307);
  }
  const url = request.nextUrl.clone();
  url.pathname = `/loja/${slug}${path === "/" ? "" : path}`;
  return NextResponse.rewrite(url);
}

// Renova a sessão em toda requisição e protege o painel.
export async function proxy(request: NextRequest) {
  const host = (request.headers.get("host") ?? "").toLowerCase().split(":")[0];
  if (host && !isMainHost(host)) return customDomain(request, host);

  const path = request.nextUrl.pathname;
  const isPrivate = path.startsWith("/painel") || path.startsWith("/onboarding") || path.startsWith("/admin");
  if (!isPrivate && !path.startsWith("/login")) return NextResponse.next();

  let response = NextResponse.next({ request });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (list) => {
          list.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          list.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    },
  );

  const { data: { user } } = await supabase.auth.getUser();

  if (isPrivate && !user) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", path);
    return NextResponse.redirect(url);
  }

  // 2FA: quem ativou o autenticador precisa validar o código (AAL2) antes do painel.
  if (isPrivate && user) {
    const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (data && data.nextLevel === "aal2" && data.currentLevel !== "aal2") {
      const url = request.nextUrl.clone();
      url.pathname = "/login/2fa";
      url.searchParams.set("next", path);
      return NextResponse.redirect(url);
    }
  }
  return response;
}

export const config = {
  // tudo, menos arquivos do Next e estáticos (com extensão)
  matcher: ["/((?!_next/static|_next/image|.*\\.[A-Za-z0-9]+$).*)"],
};
