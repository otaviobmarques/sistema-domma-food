"use client";
import { useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { usePanel } from "@/lib/panel/context";
import { Alert, Field, Modal } from "@/components/ui";
import { brl, errorMessage, parseBRL, timeHM } from "@/lib/format";
import { diffClass, METHOD_LABEL, METHODS, type CashStatus, type Method, type Totals } from "./types";

type Open = Extract<CashStatus, { open: true }>;
type CloseResult = { expected: Totals; counted: Partial<Record<Method, number>>; difference_cents: number };
const KIND = { sale: "Venda", supply: "Suprimento", withdrawal: "Sangria" } as const;

export function Movement({ status, onChange }: { status: Open; onChange: () => void }) {
  const { unit } = usePanel();
  const sb = supabaseBrowser();
  const [move, setMove] = useState<null | "supply" | "withdrawal">(null);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [closing, setClosing] = useState(false);
  const [counted, setCounted] = useState<Record<Method, string>>({ cash: "", pix: "", credit_card: "", debit_card: "", voucher: "" });
  const [closeNotes, setCloseNotes] = useState("");
  const [result, setResult] = useState<CloseResult | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const e = status.expected;

  async function submitMove(ev: React.FormEvent) {
    ev.preventDefault();
    if (!move) return;
    setBusy(true); setErr("");
    const { error } = await sb.rpc("cash_move", { p_unit_id: unit.id, p_kind: move, p_amount_cents: parseBRL(amount), p_note: note });
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return; }
    setMove(null); setAmount(""); setNote(""); onChange();
  }

  async function submitClose(ev: React.FormEvent) {
    ev.preventDefault();
    setBusy(true); setErr("");
    const p_counted = Object.fromEntries(METHODS.map((m) => [m, parseBRL(counted[m])]));
    const { data, error } = await sb.rpc("cash_close", { p_unit_id: unit.id, p_counted, p_notes: closeNotes });
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return; }
    setResult(data as CloseResult);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-zinc-600">
          Aberto às <b>{timeHM(status.opened_at)}</b> de {new Date(status.opened_at).toLocaleDateString("pt-BR")}
          {status.opened_by ? <> por <b>{status.opened_by}</b></> : null} · fundo de troco {brl(status.opening_float_cents)}
        </p>
        <div className="flex flex-wrap gap-2">
          <button className="btn-secondary" onClick={() => { setErr(""); setMove("supply"); }}>+ Suprimento</button>
          <button className="btn-secondary" onClick={() => { setErr(""); setMove("withdrawal"); }}>− Sangria</button>
          <button className="btn-danger" onClick={() => { setErr(""); setResult(null); setClosing(true); }}>Fechar caixa</button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <div className="card col-span-2 md:col-span-1"><p className="text-xs font-medium text-zinc-500">Vendas ({e.sales_count})</p><p className="mt-1 text-xl font-bold tabular-nums">{brl(e.sales_total)}</p></div>
        {(["pix", "credit_card", "debit_card", "voucher"] as Method[]).map((m) => (
          <div key={m} className="card"><p className="text-xs font-medium text-zinc-500">{METHOD_LABEL[m]}</p><p className="mt-1 text-lg font-bold tabular-nums">{brl(e[m])}</p></div>
        ))}
        <div className="card"><p className="text-xs font-medium text-zinc-500">Suprimentos</p><p className="mt-1 text-lg font-bold tabular-nums text-green-700">{brl(e.supply)}</p></div>
        <div className="card"><p className="text-xs font-medium text-zinc-500">Sangrias</p><p className="mt-1 text-lg font-bold tabular-nums text-red-700">{brl(e.withdrawal)}</p></div>
      </div>
      <p className="text-xs text-zinc-500">O dinheiro esperado na gaveta só aparece depois do fechamento (conferência cega).</p>

      <section className="card">
        <h2 className="mb-2 font-semibold">Movimentações</h2>
        {status.moves.length === 0 ? <p className="py-4 text-center text-sm text-zinc-500">Nenhuma movimentação ainda.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-zinc-500"><tr><th className="p-2">Hora</th><th className="p-2">Tipo</th><th className="p-2">Forma</th><th className="p-2 text-right">Valor</th><th className="p-2">Obs.</th></tr></thead>
              <tbody className="divide-y divide-zinc-100">
                {status.moves.map((m) => (
                  <tr key={m.id}>
                    <td className="p-2 tabular-nums">{timeHM(m.created_at)}</td>
                    <td className="p-2">{KIND[m.kind]}</td>
                    <td className="p-2">{METHOD_LABEL[m.method] ?? m.method}</td>
                    <td className={`p-2 text-right font-semibold tabular-nums ${m.kind === "withdrawal" ? "text-red-700" : ""}`}>{m.kind === "withdrawal" ? "− " : ""}{brl(m.amount_cents)}</td>
                    <td className="p-2 text-zinc-600">{m.note ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Modal open={!!move} onClose={() => setMove(null)} title={move === "supply" ? "Suprimento (entrada de dinheiro)" : "Sangria (retirada de dinheiro)"}>
        <form onSubmit={submitMove} className="space-y-3">
          <Field label="Valor (R$)"><input className="input" inputMode="decimal" required autoFocus value={amount} onChange={(ev) => setAmount(ev.target.value)} /></Field>
          <Field label="Motivo"><input className="input" required maxLength={200} value={note} onChange={(ev) => setNote(ev.target.value)} placeholder={move === "supply" ? "Ex.: troco trazido do banco" : "Ex.: pagamento do motoboy"} /></Field>
          <Alert>{err}</Alert>
          <button className="btn-primary w-full" disabled={busy || parseBRL(amount) <= 0}>Registrar</button>
        </form>
      </Modal>

      <Modal open={closing} onClose={() => { setClosing(false); if (result) onChange(); }} title={result ? "Caixa fechado" : "Fechar caixa"}>
        {result ? (
          <div className="space-y-3">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-zinc-500"><tr><th className="py-1">Forma</th><th className="py-1 text-right">Esperado</th><th className="py-1 text-right">Contado</th><th className="py-1 text-right">Diferença</th></tr></thead>
              <tbody className="divide-y divide-zinc-100">
                {METHODS.map((m) => {
                  const d = (result.counted[m] ?? 0) - result.expected[m];
                  return (
                    <tr key={m}><td className="py-1.5">{METHOD_LABEL[m]}</td><td className="py-1.5 text-right tabular-nums">{brl(result.expected[m])}</td>
                      <td className="py-1.5 text-right tabular-nums">{brl(result.counted[m] ?? 0)}</td>
                      <td className={`py-1.5 text-right font-semibold tabular-nums ${diffClass(d)}`}>{brl(d)}</td></tr>
                  );
                })}
              </tbody>
            </table>
            <div className={`rounded-xl p-4 text-center ring-1 ${result.difference_cents === 0 ? "bg-green-50 ring-green-200" : result.difference_cents < 0 ? "bg-red-50 ring-red-200" : "bg-amber-50 ring-amber-200"}`}>
              <p className="text-sm font-semibold">{result.difference_cents === 0 ? "Caixa conferido, sem diferença" : result.difference_cents < 0 ? "Faltou no caixa" : "Sobrou no caixa"}</p>
              <p className={`text-3xl font-extrabold tabular-nums ${diffClass(result.difference_cents)}`}>{brl(Math.abs(result.difference_cents))}</p>
            </div>
            <button className="btn-primary w-full" onClick={() => { setClosing(false); onChange(); }}>Concluir</button>
          </div>
        ) : (
          <form onSubmit={submitClose} className="space-y-3">
            <p className="text-sm text-zinc-600">Conte o que há em cada forma de pagamento e informe abaixo. O sistema compara com o esperado depois que você confirmar.</p>
            {status.open_tabs > 0 && <Alert kind="info">Há {status.open_tabs} comanda(s) aberta(s). Feche-as antes ou escreva uma justificativa na observação.</Alert>}
            <div className="grid grid-cols-2 gap-3">
              {METHODS.map((m) => (
                <Field key={m} label={m === "cash" ? "Dinheiro na gaveta (R$)" : `${METHOD_LABEL[m]} (R$)`}>
                  <input className="input text-right tabular-nums" inputMode="decimal" placeholder="0,00" value={counted[m]} autoFocus={m === "cash"}
                    onChange={(ev) => setCounted({ ...counted, [m]: ev.target.value })} />
                </Field>
              ))}
            </div>
            <Field label={status.open_tabs > 0 ? "Observação (obrigatória)" : "Observação"}>
              <textarea className="input" maxLength={500} required={status.open_tabs > 0} value={closeNotes} onChange={(ev) => setCloseNotes(ev.target.value)} />
            </Field>
            <Alert>{err}</Alert>
            <button className="btn-danger w-full" disabled={busy}>{busy ? "Fechando..." : "Confirmar fechamento"}</button>
          </form>
        )}
      </Modal>
    </div>
  );
}
