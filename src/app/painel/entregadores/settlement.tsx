"use client";
import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { usePanel } from "@/lib/panel/context";
import { Alert, Empty, Field } from "@/components/ui";
import { brl, centsToInput, errorMessage, parseBRL } from "@/lib/format";
import { COLLECT_LABEL, type Courier } from "./shared";

type Balance = {
  deliveries: number; fees_cents: number; cash_cents: number; card_cents: number; pix_cents: number; returned: number;
  since: string | null; items: { id: string; number: number; delivered_at: string; fee_cents: number; collect_cents: number; method: string | null }[];
};
type Hist = { id: string; courier_id: string; deliveries: number; fees_cents: number; cash_expected_cents: number; cash_received_cents: number;
  difference_cents: number; paid_from_cash: boolean; note: string | null; created_at: string };

const when = (iso: string) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export function Settlement({ couriers }: { couriers: Courier[] }) {
  const { unit, role } = usePanel();
  const sb = supabaseBrowser();
  const canSettle = ["owner", "manager", "cashier"].includes(role);
  const [cid, setCid] = useState("");
  const [bal, setBal] = useState<Balance | null>(null);
  const [cash, setCash] = useState("");
  const [payFromCash, setPayFromCash] = useState(false);
  const [note, setNote] = useState("");
  const [hist, setHist] = useState<Hist[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [result, setResult] = useState<{ fees_cents: number; cash_expected_cents: number; difference_cents: number } | null>(null);

  useEffect(() => { if (!cid && couriers[0]) setCid(couriers[0].id); }, [couriers, cid]);

  const loadHist = useCallback(async () => {
    const { data } = await sb.from("courier_settlements").select("*").eq("unit_id", unit.id).order("created_at", { ascending: false }).limit(30);
    setHist((data ?? []) as Hist[]);
  }, [sb, unit.id]);

  const loadBal = useCallback(async () => {
    if (!cid || !canSettle) return;
    setErr("");
    const { data, error } = await sb.rpc("courier_open_balance", { p_courier_id: cid });
    if (error) { setErr(errorMessage(error)); setBal(null); return; }
    const b = data as Balance;
    setBal(b); setCash(centsToInput(b.cash_cents));
  }, [sb, cid, canSettle]);

  useEffect(() => { void loadBal(); setResult(null); }, [loadBal]);
  useEffect(() => { if (canSettle) void loadHist(); }, [loadHist, canSettle]);

  if (!canSettle) return <Empty>O acerto com os entregadores é feito pelo caixa ou pela gerência.</Empty>;
  if (couriers.length === 0) return <Empty>Cadastre um entregador primeiro.</Empty>;

  async function settle(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr("");
    const { data, error } = await sb.rpc("courier_settle", { p_courier_id: cid, p_cash_received_cents: parseBRL(cash), p_pay_from_cash: payFromCash, p_note: note || null });
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return; }
    setResult(data as typeof result); setNote(""); setPayFromCash(false);
    await Promise.all([loadBal(), loadHist()]);
  }

  const name = (id: string) => couriers.find((c) => c.id === id)?.name ?? "—";
  const empty = !!bal && bal.deliveries === 0 && bal.returned === 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-64"><Field label="Entregador">
          <select className="input" value={cid} onChange={(e) => setCid(e.target.value)}>
            {couriers.map((c) => <option key={c.id} value={c.id}>{c.name}{c.active ? "" : " (inativo)"}</option>)}
          </select>
        </Field></div>
        <button className="btn-secondary" onClick={() => void loadBal()}>Atualizar</button>
      </div>
      <Alert>{err}</Alert>
      {result && (
        <div className={`rounded-lg border p-4 text-sm ${result.difference_cents === 0 ? "border-green-200 bg-green-50" : result.difference_cents < 0 ? "border-red-200 bg-red-50" : "border-amber-200 bg-amber-50"}`}>
          <p className="font-semibold">Acerto registrado.</p>
          <p>Taxas do entregador: {brl(result.fees_cents)} · dinheiro esperado: {brl(result.cash_expected_cents)}</p>
          <p className="font-medium">{result.difference_cents === 0 ? "Sem diferença no dinheiro." : result.difference_cents < 0 ? `Faltou ${brl(-result.difference_cents)}.` : `Sobrou ${brl(result.difference_cents)}.`}</p>
        </div>
      )}
      {bal && (empty ? <Empty>Nada em aberto para este entregador.</Empty> : (
        <>
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {[["Entregas", String(bal.deliveries)], ["Taxas a pagar", brl(bal.fees_cents)], ["Dinheiro a trazer", brl(bal.cash_cents)],
              ["Cartão / vale", brl(bal.card_cents)], ["Pix", brl(bal.pix_cents)], ["Devolvidas", String(bal.returned)]].map(([l, v]) => (
              <div key={l} className="card p-4"><p className="text-xs font-medium text-zinc-500">{l}</p><p className="mt-1 text-lg font-semibold tabular-nums">{v}</p></div>
            ))}
          </div>
          {bal.items.length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
              <table className="w-full text-sm">
                <thead className="bg-zinc-50 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                  <tr><th className="p-2.5">Pedido</th><th className="p-2.5">Entregue</th><th className="p-2.5">Recebido do cliente</th><th className="p-2.5 text-right">Valor</th><th className="p-2.5 text-right">Taxa</th></tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {bal.items.map((i) => (
                    <tr key={i.id}>
                      <td className="p-2.5 font-medium">#{i.number}</td>
                      <td className="p-2.5 tabular-nums text-zinc-600">{when(i.delivered_at)}</td>
                      <td className="p-2.5">{i.collect_cents > 0 ? COLLECT_LABEL[i.method ?? ""] ?? i.method : "Já pago online"}</td>
                      <td className="p-2.5 text-right tabular-nums">{i.collect_cents > 0 ? brl(i.collect_cents) : "—"}</td>
                      <td className="p-2.5 text-right tabular-nums">{brl(i.fee_cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <form onSubmit={settle} className="card space-y-3">
            <h3 className="font-semibold">Registrar acerto</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Dinheiro entregue pelo entregador (R$)" hint={`Esperado: ${brl(bal.cash_cents)} (pedidos pagos em dinheiro).`}>
                <input className="input text-right tabular-nums" inputMode="decimal" required value={cash} onChange={(e) => setCash(e.target.value)} />
              </Field>
              <Field label="Observação"><input className="input" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
            </div>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={payFromCash} onChange={(e) => setPayFromCash(e.target.checked)} />
              <span>Pagar as taxas ({brl(bal.fees_cents)}) agora com o dinheiro do caixa
                <span className="block text-xs text-zinc-500">Precisa do caixa aberto. Sai como sangria e entra no Financeiro como despesa paga. Desmarcado, a despesa fica em aberto em Contas a pagar.</span></span>
            </label>
            <p className="text-xs text-zinc-500">Com o caixa aberto, o dinheiro trazido pelo entregador entra no caixa.</p>
            <button className="btn-primary" disabled={busy}>{busy ? "Registrando..." : "Registrar acerto"}</button>
          </form>
        </>
      ))}

      <section>
        <h3 className="mb-2 font-semibold">Acertos recentes</h3>
        {hist.length === 0 ? <p className="text-sm text-zinc-500">Nenhum acerto ainda.</p> : (
          <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                <tr><th className="p-2.5">Data</th><th className="p-2.5">Entregador</th><th className="p-2.5 text-right">Entregas</th><th className="p-2.5 text-right">Taxas</th>
                  <th className="p-2.5 text-right">Esperado</th><th className="p-2.5 text-right">Recebido</th><th className="p-2.5 text-right">Diferença</th></tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {hist.map((h) => (
                  <tr key={h.id}>
                    <td className="p-2.5 tabular-nums text-zinc-600">{when(h.created_at)}</td>
                    <td className="p-2.5">{name(h.courier_id)}{h.note ? <span className="block text-xs text-zinc-500">{h.note}</span> : null}</td>
                    <td className="p-2.5 text-right tabular-nums">{h.deliveries}</td>
                    <td className="p-2.5 text-right tabular-nums">{brl(h.fees_cents)}{h.paid_from_cash ? <span className="block text-xs text-zinc-500">pago no caixa</span> : null}</td>
                    <td className="p-2.5 text-right tabular-nums">{brl(h.cash_expected_cents)}</td>
                    <td className="p-2.5 text-right tabular-nums">{brl(h.cash_received_cents)}</td>
                    <td className={`p-2.5 text-right font-medium tabular-nums ${h.difference_cents === 0 ? "text-green-700" : h.difference_cents < 0 ? "text-red-700" : "text-amber-700"}`}>{brl(h.difference_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
