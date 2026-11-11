"use client";
import { useState } from "react";
import { canManage, usePanel } from "@/lib/panel/context";
import { Empty } from "@/components/ui";
import { Items } from "./items";
import { Recipes } from "./recipes";
import { Moves } from "./moves";

const TABS = [
  { key: "items", label: "Insumos" },
  { key: "recipes", label: "Ficha técnica" },
  { key: "moves", label: "Movimentações" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export default function Estoque() {
  const { role } = usePanel();
  const [tab, setTab] = useState<TabKey>("items");

  if (!canManage(role)) return <Empty>Somente o dono ou o gerente acessam o estoque.</Empty>;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="h1">Estoque</h1>
        <p className="mt-1 text-sm text-zinc-500">
          A baixa é automática pela ficha técnica quando o pedido é aceito, e o insumo volta ao estoque se o pedido for cancelado.
        </p>
      </div>
      <div className="flex gap-1 border-b border-zinc-200" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition ${tab === t.key ? "border-brand-600 text-brand-700" : "border-transparent text-zinc-500 hover:text-zinc-800"}`}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === "items" && <Items />}
      {tab === "recipes" && <Recipes />}
      {tab === "moves" && <Moves />}
    </div>
  );
}
