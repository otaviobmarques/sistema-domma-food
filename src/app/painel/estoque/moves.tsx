"use client";
import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { usePanel } from "@/lib/panel/context";
import { Alert, Empty } from "@/components/ui";
import { brl, errorMessage } from "@/lib/format";
import { fmtQty, MOVE_LABEL } from "./shared";

type Move = {
  id: number; kind: string; qty: number; unit_cost_cents: number; balance_after: number; note: string | null; created_at: string;
  order_id: string | null; stock_items: { name: string; unit: string; unit_id: string };
};

const KIND_CLS: Record<string, string> = {
  purchase: "bg-green-100 text-green-800", adjust: "bg-sky-100 text-sky-800", loss: "bg-red-100 text-red-800",
  sale: "bg-zinc-100 text-zinc-700", sale_reversal: "bg-amber-100 text-amber-800",
};

export function Moves() {
  const { unit } = usePanel();
  const sb = supabaseBrowser();
  const [list, setList] = useState<Move[] | null>(null);
  const [kind, setKind] = useState("");
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    let qb = sb.from("stock_moves").select("*, stock_items!inner(name, unit, unit_id)").eq("stock_items.unit_id", unit.id);
    if (kind) qb = qb.eq("kind", kind);
    const { data, error } = await qb.order("id", { ascending: false }).limit(200);
    if (error) setErr(errorMessage(error)); else setList(data as Move[]);
  }, [sb, unit.id, kind]);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select className="input w-auto" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Filtrar por tipo">
          <option value="">Todos os tipos</option>
          {Object.entries(MOVE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <span className="text-xs text-zinc-500">Últimas 200 movimentações desta loja.</span>
      </div>
      <Alert>{err}</Alert>
      {list === null ? null : list.length === 0 ? <Empty>Nenhuma movimentação ainda.</Empty> : (
        <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              <tr>
                <th className="p-3">Data</th><th className="p-3">Insumo</th><th className="p-3">Tipo</th>
                <th className="p-3 text-right">Quantidade</th><th className="p-3 text-right">Saldo</th><th className="p-3 text-right">Custo un.</th><th className="p-3">Observação</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {list.map((m) => {
                const q = Number(m.qty);
                return (
                  <tr key={m.id}>
                    <td className="whitespace-nowrap p-3 text-xs text-zinc-600">{new Date(m.created_at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}</td>
                    <td className="p-3 font-medium">{m.stock_items.name}</td>
                    <td className="p-3"><span className={`badge ${KIND_CLS[m.kind] ?? "bg-zinc-100"}`}>{MOVE_LABEL[m.kind] ?? m.kind}</span></td>
                    <td className={`p-3 text-right tabular-nums ${q < 0 ? "text-red-700" : "text-green-700"}`}>{q > 0 ? "+" : ""}{fmtQty(q)} {m.stock_items.unit}</td>
                    <td className="p-3 text-right tabular-nums">{fmtQty(Number(m.balance_after))}</td>
                    <td className="p-3 text-right tabular-nums text-zinc-600">{brl(Math.round(Number(m.unit_cost_cents)))}</td>
                    <td className="p-3 text-xs text-zinc-600">{m.note ?? (m.order_id ? "Pedido" : "")}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
