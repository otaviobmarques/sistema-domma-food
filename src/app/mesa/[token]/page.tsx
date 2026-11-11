import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { supabaseServer } from "@/lib/supabase/server";
import type { Store } from "@/components/store/types";
import { TableMenu, type TableInfo } from "./table-menu";

export const dynamic = "force-dynamic";

const load = cache(async (token: string): Promise<{ info: TableInfo; store: Store } | null> => {
  if (!/^[0-9a-f]{24}$/.test(token)) return null;
  const sb = await supabaseServer();
  const { data: info, error } = await sb.rpc("table_info", { p_token: token });
  if (error) throw new Error("Não foi possível carregar a mesa.");
  if (!info) return null;
  const { data: store, error: e2 } = await sb.rpc("get_store", { p_slug: (info as TableInfo).slug });
  if (e2) throw new Error("Não foi possível carregar o cardápio.");
  if (!store) return null;
  return { info: info as TableInfo, store: store as Store };
});

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const { token } = await params;
  const d = await load(token);
  if (!d) return { title: "Mesa não encontrada", robots: { index: false, follow: false } };
  return { title: { absolute: `${d.info.unit_name} · Mesa ${d.info.table}` }, robots: { index: false, follow: false } };
}

export default async function TablePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const d = await load(token);
  if (!d) notFound();
  return <TableMenu token={token} initialInfo={d.info} store={d.store} />;
}
