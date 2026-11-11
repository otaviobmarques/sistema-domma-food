"use client";
import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { canManage, usePanel } from "@/lib/panel/context";
import { Alert, Empty } from "@/components/ui";
import { brl, errorMessage } from "@/lib/format";
import { GP_STATUS, methodText, REFUND_LABEL, StatusBadge, type GatewayPayment } from "./shared";

const FILTERS = [["all", "Todos"], ["approved", "Aprovados"], ["pending", "Aguardando"], ["rejected", "Recusados"], ["refund", "Estornos"]] as const;

export function PaymentsList() {
  const { unit, role } = usePanel();
  const sb = supabaseBrowser();
  const [list, setList] = useState<GatewayPayment[]>([]);
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>("all");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    const { data, error } = await sb.from("gateway_payments")
      .select("id, kind, status, status_detail, amount_cents, installments, card_last4, card_brand, refund_status, refund_message, created_at, orders(number, customer_name)")
      .eq("unit_id", unit.id).order("created_at", { ascending: false }).limit(100);
    if (error) setErr(errorMessage(error)); else { setErr(""); setList((data ?? []) as unknown as GatewayPayment[]); }
  }, [sb, unit.id]);

  useEffect(() => {
    void load();
    const ch = sb.channel(`gp-${unit.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "gateway_payments", filter: `unit_id=eq.${unit.id}` }, () => void load())
      .subscribe();
    return () => { void sb.removeChannel(ch); };
  }, [load, sb, unit.id]);

  async function retry(id: string) {
    setBusy(id); setErr("");
    const { error } = await sb.rpc("gateway_retry_refund", { p_gp_id: id });
    setBusy("");
    if (error) setErr(errorMessage(error)); else await load();
  }

  const shown = list.filter((p) => filter === "all" ? true
    : filter === "refund" ? p.refund_status !== "none"
    : filter === "pending" ? ["pending", "in_process", "creating"].includes(p.status)
    : filter === "rejected" ? ["rejected", "error", "cancelled"].includes(p.status)
    : p.status === filter);

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-semibold">Pagamentos online recentes</h2>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg bg-zinc-100 p-0.5 text-xs font-medium">
            {FILTERS.map(([k, l]) => (
              <button key={k} type="button" onClick={() => setFilter(k)} className={`rounded-md px-2.5 py-1 ${filter === k ? "bg-white shadow-sm" : "text-zinc-500"}`}>{l}</button>
            ))}
          </div>
          <button className="btn-secondary" onClick={() => void load()}>Atualizar</button>
        </div>
      </div>
      <Alert>{err}</Alert>
      {shown.length === 0 ? <Empty>{list.length ? "Nenhum pagamento neste filtro." : "Nenhum pagamento online ainda."}</Empty> : (
        <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              <tr><th className="p-3">Data</th><th className="p-3">Pedido</th><th className="p-3">Cliente</th><th className="p-3">Forma</th><th className="p-3 text-right">Valor</th><th className="p-3">Situação</th><th className="p-3">Estorno</th></tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {shown.map((p) => {
                const r = REFUND_LABEL[p.refund_status];
                return (
                  <tr key={p.id}>
                    <td className="whitespace-nowrap p-3 tabular-nums text-zinc-600">{new Date(p.created_at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</td>
                    <td className="p-3 font-medium">{p.orders ? `#${p.orders.number}` : "—"}</td>
                    <td className="p-3">{p.orders?.customer_name ?? "—"}</td>
                    <td className="p-3">{methodText(p)}</td>
                    <td className="p-3 text-right font-medium tabular-nums">{brl(p.amount_cents)}</td>
                    <td className="p-3"><StatusBadge status={p.status} />{p.status_detail && GP_STATUS[p.status]?.label === "Recusado" && <span className="block text-xs text-zinc-500">{p.status_detail}</span>}</td>
                    <td className="p-3">
                      {r ? <span className={`text-xs font-medium ${r.cls}`}>{r.label}</span> : <span className="text-xs text-zinc-400">—</span>}
                      {p.refund_status === "failed" && p.refund_message && <span className="block text-xs text-zinc-500">{p.refund_message}</span>}
                      {p.refund_status === "failed" && canManage(role) && (
                        <button className="btn-ghost mt-1 px-2 text-xs" disabled={busy === p.id} onClick={() => void retry(p.id)}>Tentar de novo</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
