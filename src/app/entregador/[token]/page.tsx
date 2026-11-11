import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { supabaseServer } from "@/lib/supabase/server";
import { CourierApp, type Portal } from "./courier-app";

export const dynamic = "force-dynamic";

const TOKEN_RE = /^[0-9a-f]{32}$/;

const load = cache(async (token: string): Promise<Portal | null> => {
  if (!TOKEN_RE.test(token)) return null;
  const sb = await supabaseServer();
  const { data, error } = await sb.rpc("courier_portal", { p_token: token });
  if (error) throw new Error("Não foi possível carregar as entregas.");
  return (data as Portal | null) ?? null;
});

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const { token } = await params;
  const p = await load(token);
  return {
    title: { absolute: p ? `Entregas · ${p.store.name}` : "Entregas" },
    robots: { index: false, follow: false },
  };
}

export default async function CourierPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!TOKEN_RE.test(token)) notFound();
  const portal = await load(token);
  return <CourierApp token={token} initial={portal} />;
}
