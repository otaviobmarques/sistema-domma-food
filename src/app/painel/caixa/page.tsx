"use client";
import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { usePanel } from "@/lib/panel/context";
import { Alert, Field } from "@/components/ui";
import { brl, errorMessage, parseBRL } from "@/lib/format";
import { diffClass, type CashStatus } from "./types";
import { Pos } from "./pos";
import { Movement } from "./movement";

export default function CaixaPage() {
  const { unit, role } = usePanel();
  const allowed = role === "owner" || role === "manager" || role === "cashier";
  const [status, setStatus] = useState<CashStatus | null>(null);
  const [tab, setTab] = useState<"pdv" | "mov">("pdv");
  const [float, setFloat] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!allowed) return;
    const { data, error } = await supabaseBrowser().rpc("cash_status", { p_unit_id: unit.id });
    if (error) setErr(errorMessage(error)); else { setErr(""); setStatus(data as CashStatus); }
  }, [unit.id, allowed]);
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, [load]);

  if (!allowed) return <div className="card"><p>O caixa é acessado pelo dono, gerente ou operador de caixa.</p></div>;

  async function open(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr("");
    const { error } = await supabaseBrowser().rpc("cash_open", { p_unit_id: unit.id, p_float_cents: parseBRL(float) });
    setBusy(false);
    if (error) setErr(errorMessage(error)); else { setFloat(""); setTab("pdv"); load(); }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="h1">Caixa / PDV</h1>
          {status && <span className={`badge ${status.open ? "bg-green-100 text-green-800" : "bg-zinc-200 text-zinc-700"}`}>{status.open ? "Caixa aberto" : "Caixa fechado"}</span>}
        </div>
        {status?.open && (
          <div className="flex rounded-xl border border-zinc-200 bg-white p-1" role="tablist">
            {([["pdv", "Vender (PDV)"], ["mov", "Movimento do caixa"]] as const).map(([k, l]) => (
              <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
                className={`rounded-lg px-3.5 py-1.5 text-sm font-semibold ${tab === k ? "bg-brand-600 text-white" : "text-zinc-600"}`}>{l}</button>
            ))}
          </div>
        )}
      </div>
      {(!status || !status.open) && <Alert>{err}</Alert>}

      {!status ? <p className="text-sm text-zinc-500">Carregando...</p> : status.open ? (
        // os dois ficam montados para não perder a venda em andamento ao trocar de aba
        <>
          <div hidden={tab !== "pdv"}><Pos onSold={load} /></div>
          <div hidden={tab !== "mov"}><Movement status={status} onChange={load} /></div>
        </>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
          <form onSubmit={open} className="card space-y-3 self-start">
            <h2 className="font-semibold">Abrir caixa</h2>
            <p className="text-sm text-zinc-600">Informe o dinheiro que já está na gaveta para troco.</p>
            <Field label="Fundo de troco (R$)"><input className="input" inputMode="decimal" placeholder="0,00" value={float} onChange={(e) => setFloat(e.target.value)} autoFocus /></Field>
            <button className="btn-primary w-full" disabled={busy}>{busy ? "Abrindo..." : "Abrir caixa"}</button>
          </form>
          <section className="card">
            <h2 className="mb-2 font-semibold">Últimos fechamentos</h2>
            {status.history.length === 0 ? <p className="py-6 text-center text-sm text-zinc-500">Nenhum caixa fechado ainda.</p> : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase text-zinc-500">
                    <tr><th className="p-2">Abertura</th><th className="p-2">Fechamento</th><th className="p-2 text-right">Vendas</th><th className="p-2 text-right">Esperado</th><th className="p-2 text-right">Contado</th><th className="p-2 text-right">Diferença</th><th className="p-2">Obs.</th></tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100">
                    {status.history.map((h) => {
                      const exp = h.expected.cash + h.expected.pix + h.expected.credit_card + h.expected.debit_card + h.expected.voucher;
                      const cnt = Object.values(h.counted ?? {}).reduce((a: number, b) => a + (Number(b) || 0), 0);
                      const dt = (s: string) => new Date(s).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
                      return (
                        <tr key={h.id}>
                          <td className="p-2 whitespace-nowrap">{dt(h.opened_at)}</td><td className="p-2 whitespace-nowrap">{dt(h.closed_at)}</td>
                          <td className="p-2 text-right tabular-nums">{brl(h.expected.sales_total)}</td>
                          <td className="p-2 text-right tabular-nums">{brl(exp)}</td><td className="p-2 text-right tabular-nums">{brl(cnt)}</td>
                          <td className={`p-2 text-right font-semibold tabular-nums ${diffClass(h.difference_cents)}`}>{brl(h.difference_cents)}</td>
                          <td className="max-w-[14rem] truncate p-2 text-zinc-600" title={h.notes ?? ""}>{h.notes ?? ""}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
