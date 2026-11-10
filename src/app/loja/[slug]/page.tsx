import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { supabaseServer } from "@/lib/supabase/server";
import { StoreMenu } from "@/components/store/store-menu";
import type { Store } from "@/components/store/types";

export const dynamic = "force-dynamic";

const getStore = cache(async (slug: string): Promise<Store | null> => {
  if (!/^[a-z0-9-]{3,50}$/.test(slug)) return null;
  const sb = await supabaseServer();
  const { data, error } = await sb.rpc("get_store", { p_slug: slug });
  if (error) throw new Error("Não foi possível carregar o cardápio.");
  return (data as Store | null) ?? null;
});

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const store = await getStore(slug);
  if (!store) return { title: "Loja não encontrada" };
  const u = store.unit;
  const description = u.description || `Peça online em ${u.name}. Cardápio digital com entrega e retirada.`;
  return {
    title: { absolute: `${u.name} · Cardápio digital` },
    description,
    openGraph: { title: u.name, description, type: "website", images: u.cover_url ? [u.cover_url] : u.logo_url ? [u.logo_url] : [] },
  };
}

export default async function StorePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const store = await getStore(slug);
  if (!store) notFound();
  return <StoreMenu store={store} />;
}
