import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { supabaseServer } from "@/lib/supabase/server";
import type { Store } from "@/components/store/types";
import { Kiosk, type TotemInfo } from "./kiosk";

export const dynamic = "force-dynamic";

const load = cache(async (token: string): Promise<{ info: TotemInfo; store: Store } | null> => {
  if (!/^dft_[0-9a-f]{40}$/.test(token)) return null;
  const sb = await supabaseServer();
  const { data: info, error } = await sb.rpc("totem_info", { p_token: token });
  if (error) throw new Error("Não foi possível carregar o totem.");
  if (!info) return null;
  const { data: store, error: e2 } = await sb.rpc("get_store", { p_slug: (info as TotemInfo).slug });
  if (e2) throw new Error("Não foi possível carregar o cardápio.");
  if (!store) return null;
  return { info: info as TotemInfo, store: store as Store };
});

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const { token } = await params;
  const d = await load(token);
  if (!d) return { title: "Totem não encontrado", robots: { index: false, follow: false } };
  return { title: { absolute: `${d.info.unit_name} · Autoatendimento` }, robots: { index: false, follow: false } };
}

export default async function TotemPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const d = await load(token);
  if (!d) notFound();
  return <Kiosk token={token} info={d.info} store={d.store} />;
}
