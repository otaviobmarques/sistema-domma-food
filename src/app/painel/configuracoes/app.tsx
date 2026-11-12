"use client";
import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { usePanel } from "@/lib/panel/context";

type Stats = { slug: string; ready: boolean; orders_30d: number; orders_with_push_30d: number; devices_30d: number; sent_30d: number; failed_30d: number };

/** App do cliente: o cardápio instala na tela do celular e avisa o andamento do pedido. */
export function CustomerAppCard() {
  const { unit } = usePanel();
  const [s, setS] = useState<Stats | null>(null);
  useEffect(() => {
    void (async () => {
      const { data } = await supabaseBrowser().rpc("push_stats", { p_unit_id: unit.id });
      setS((data as Stats | null) ?? null);
    })();
  }, [unit.id]);
  if (!s) return null;
  const pct = s.orders_30d ? Math.round((s.orders_with_push_30d / s.orders_30d) * 100) : 0;
  const tile = (label: string, value: string, hint?: string) => (
    <div className="rounded-xl bg-zinc-50 p-3">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className="text-xl font-bold">{value}</p>
      {hint && <p className="text-[11px] text-zinc-500">{hint}</p>}
    </div>
  );
  return (
    <section className="card space-y-3">
      <div>
        <h2 className="text-lg font-semibold">App do cliente</h2>
        <p className="mt-1 text-sm text-zinc-600">
          O seu cardápio já funciona como app: o cliente instala na tela do celular (Android e iPhone) com o nome, a cor e o logo da loja,
          recebe uma notificação a cada etapa do pedido e pede de novo com um toque. Nada para configurar.
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-4">
        {tile("Pedidos com avisos no aparelho", `${s.orders_with_push_30d}`, `${pct}% dos pedidos do cardápio`)}
        {tile("Aparelhos", `${s.devices_30d}`)}
        {tile("Avisos entregues", `${s.sent_30d}`)}
        {tile("Avisos com falha", `${s.failed_30d}`)}
      </div>
      <p className="text-xs text-zinc-500">
        Últimos 30 dias. Divulgue o link <span className="font-medium text-zinc-700">/loja/{s.slug}</span>: ao abrir pelo celular, o cliente vê o convite para instalar.
        No iPhone os avisos funcionam com o app instalado (iOS 16.4 ou mais novo).
      </p>
    </section>
  );
}
