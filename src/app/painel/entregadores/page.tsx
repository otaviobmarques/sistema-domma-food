"use client";
import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { usePanel } from "@/lib/panel/context";
import { Empty } from "@/components/ui";
import { errorMessage } from "@/lib/format";
import { Dispatch } from "./dispatch";
import { CouriersTab } from "./couriers";
import { Settlement } from "./settlement";
import { COURIER_COLS, type Courier } from "./shared";

const TABS = [["dispatch", "Despacho"], ["couriers", "Entregadores"], ["settle", "Acerto"]] as const;
type TabKey = (typeof TABS)[number][0];

export default function EntregadoresPage() {
  const { unit, role } = usePanel();
  const allowed = ["owner", "manager", "cashier", "attendant"].includes(role);
  const [tab, setTab] = useState<TabKey>("dispatch");
  const [couriers, setCouriers] = useState<Courier[]>([]);
  const [err, setErr] = useState("");

  const loadCouriers = useCallback(async () => {
    const { data, error } = await supabaseBrowser().from("couriers").select(COURIER_COLS).eq("unit_id", unit.id).order("name");
    if (error) setErr(errorMessage(error)); else setCouriers((data ?? []) as Courier[]);
  }, [unit.id]);
  useEffect(() => { if (allowed) void loadCouriers(); }, [loadCouriers, allowed]);

  if (!allowed) return <Empty>Esta tela é usada pela gerência, caixa e atendimento.</Empty>;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="h1">Entregadores e rotas</h1>
        <p className="text-sm text-zinc-500">Despache os pedidos em rota, acompanhe as entregas e faça o acerto do dia com cada entregador.</p>
      </div>
      {err && <p className="text-sm text-red-700">{err}</p>}
      <div className="flex gap-1 border-b border-zinc-200" role="tablist">
        {TABS.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === k ? "border-brand-600 text-brand-700" : "border-transparent text-zinc-500 hover:text-zinc-800"}`}>
            {l}
          </button>
        ))}
      </div>
      {tab === "dispatch" && <Dispatch couriers={couriers} />}
      {tab === "couriers" && <CouriersTab couriers={couriers} reload={loadCouriers} />}
      {tab === "settle" && <Settlement couriers={couriers} />}
    </div>
  );
}
