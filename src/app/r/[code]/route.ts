import { NextResponse, type NextRequest } from "next/server";

/** Link de indicação da revenda: guarda o código por 30 dias e leva ao cadastro. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const code = (await params).code.trim().toLowerCase();
  const url = new URL("/login?modo=cadastro", request.url);
  const res = NextResponse.redirect(url, 307);
  if (/^[a-z0-9][a-z0-9-]{2,29}$/.test(code)) {
    res.cookies.set("df_ref", code, { path: "/", maxAge: 60 * 60 * 24 * 30, sameSite: "lax", secure: url.protocol === "https:" });
  }
  return res;
}
