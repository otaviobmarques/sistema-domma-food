"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import { usePanel } from "@/lib/panel/context";
import { Alert, Field, Modal, Toggle } from "@/components/ui";
import { ProductPicker, linesToPayload, linesTotal, type PosCatalog, type PosLine } from "@/components/pos/product-picker";
import { brl, centsToInput, errorMessage, parseBRL, PAYMENT_LABEL, STATUS_LABEL, timeHM } from "@/lib/format";
import { printPreBill } from "./prebill";
import { fmtDuration, liveOrders, minutesSince, tabSubtotal, tabTitle, type DTable, type Tab } from "./types";

const METHODS = ["pix", "cash", "credit_card", "debit_card", "voucher"] as const;
type Pay = { method: (typeof METHODS)[number]; amount: string };
type Mode = "view" | "add" | "close" | "transfer";

export function TabPanel({ tab, tables, catalog, now, onClose, onChanged }: {
  tab: Tab; tables: DTable[]; catalog: PosCatalog; now: number; onClose: () => void; onChanged: () => Promise<void> | void;
}) {
  const { unit, role } = usePanel();
  const sb = supabaseBrowser();
  const canClose = role === "owner" || role === "manager" || role === "cashier";
  const [mode, setMode] = useState<Mode>("view");
  const [lines, setLines] = useState<PosLine[]>([]);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  // fechamento
  const [withFee, setWithFee] = useState(true);
  const [discount, setDiscount] = useState("");
  const [split, setSplit] = useState(String(Math.max(1, tab.people)));
  const [pays, setPays] = useState<Pay[]>([{ method: "pix", amount: "" }]);
  const [done, setDone] = useState<{ total: number; change: number } | null>(null);

  const title = tabTitle(tab, tables);
  const sub = tabSubtotal(tab);
  const pct = Number(tab.service_fee_pct);
  const fee = withFee ? Math.round((sub * pct) / 100) : 0;
  const disc = Math.min(parseBRL(discount), sub);
  const total = sub + fee - disc;
  const paid = pays.reduce((s, p) => s + parseBRL(p.amount), 0);
  const cashPaid = pays.filter((p) => p.method === "cash").reduce((s, p) => s + parseBRL(p.amount), 0);
  const remaining = Math.max(0, total - paid);
  const change = Math.max(0, paid - total);
  const people = Math.max(1, Number(split) || 1);
  const orders = useMemo(() => [...tab.orders].sort((a, b) => a.number - b.number), [tab.orders]);
  const empty = liveOrders(tab).length === 0;

  async function run(fn: () => PromiseLike<{ error: { message: string } | null }>, ok?: string) {
    setBusy(true); setErr(""); setMsg("");
    const { error } = await fn();
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return false; }
    if (ok) setMsg(ok);
    await onChanged();
    return true;
  }

  async function send() {
    if (!lines.length) return;
    const ok = await run(() => sb.rpc("tab_add_items", { p_tab_id: tab.id, p_items: linesToPayload(lines), p_notes: notes || null }),
      "Itens enviados para a cozinha.");
    if (ok) { setLines([]); setNotes(""); setMode("view"); }
  }

  function startClose() {
    setPays([{ method: "pix", amount: centsToInput(sub + Math.round((sub * pct) / 100)) }]);
    setWithFee(true); setDiscount(""); setErr(""); setMsg(""); setMode("close");
  }

  async function closeBill() {
    setBusy(true); setErr("");
    const payments = pays.map((p) => ({ method: p.method, amount_cents: parseBRL(p.amount) })).filter((p) => p.amount_cents > 0);
    const { data, error } = await sb.rpc("tab_close", { p_tab_id: tab.id, p_payments: payments, p_service_fee: withFee, p_discount_cents: disc });
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return; }
    setDone({ total: data.total_cents, change: data.change_cents });
    await onChanged();
  }

  const setPay = (i: number, patch: Partial<Pay>) => setPays((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const cashClosed = /caixa/i.test(err) && /abra/i.test(err);

  if (done) {
    return (
      <Modal open onClose={onClose} title={`${title} · conta fechada`}>
        <div className="space-y-3 text-center">
          <p className="text-4xl">✓</p>
          <p className="text-lg font-bold">Total recebido: {brl(done.total)}</p>
          {done.change > 0 && <p className="rounded-xl bg-amber-50 p-3 text-lg font-extrabold text-amber-900">Troco: {brl(done.change)}</p>}
          <button className="btn-primary w-full" onClick={onClose}>Voltar ao salão</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open onClose={onClose} title={title} wide>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm text-zinc-600">
        {tab.customer_name && <span className="font-semibold text-zinc-900">{tab.customer_name}</span>}
        <span>{tab.people} pessoa(s)</span>
        <span>· aberta há {fmtDuration(minutesSince(tab.opened_at, now))}</span>
        {tab.bill_requested_at && <span className="badge bg-amber-100 text-amber-800">Pediu a conta</span>}
      </div>
      <div className="space-y-3">
        <Alert>{err && !cashClosed ? err : ""}</Alert>
        {cashClosed && (
          <Alert>O caixa está fechado. <Link href="/painel/caixa" className="font-bold underline">Abrir o caixa</Link> e depois fechar a conta.</Alert>
        )}
        <Alert kind="success">{msg}</Alert>
      </div>

      {mode === "view" && (
        <div className="mt-3 space-y-4">
          {empty ? <p className="rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500">Nenhum item lançado ainda.</p> : (
            <div className="space-y-3">
              {orders.map((o) => (
                <div key={o.id} className={`rounded-xl border border-zinc-200 p-3 ${o.status === "cancelled" ? "opacity-50" : ""}`}>
                  <p className="flex items-center justify-between text-xs text-zinc-500">
                    <span>Pedido #{o.number} · {timeHM(o.created_at)}</span>
                    <span className={`badge ${o.status === "ready" || o.status === "completed" ? "bg-green-100 text-green-800" : o.status === "cancelled" ? "bg-red-100 text-red-800" : "bg-orange-100 text-orange-800"}`}>
                      {o.status === "ready" ? "Pronto" : STATUS_LABEL[o.status] ?? o.status}
                    </span>
                  </p>
                  <ul className="mt-1.5 space-y-1 text-sm">
                    {o.order_items.map((i) => (
                      <li key={i.id}>
                        <span className="flex justify-between gap-2"><span className="font-medium">{i.quantity}x {i.name}</span><span className="tabular-nums">{brl(i.total_cents)}</span></span>
                        {(i.options ?? []).map((op, k) => <span key={k} className="block pl-4 text-xs text-zinc-500">+ {(op.quantity ?? 1) > 1 ? `${op.quantity}x ` : ""}{op.name}</span>)}
                        {i.notes && <span className="block pl-4 text-xs font-semibold text-amber-700">Obs.: {i.notes}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
          <dl className="rounded-xl bg-zinc-50 p-3 text-sm">
            <div className="flex justify-between"><dt>Subtotal</dt><dd className="tabular-nums">{brl(sub)}</dd></div>
            <div className="flex justify-between text-zinc-500"><dt>Taxa de serviço ({pct}%)</dt><dd className="tabular-nums">{brl(Math.round((sub * pct) / 100))}</dd></div>
            <div className="mt-1 flex justify-between text-base font-extrabold"><dt>Total com serviço</dt><dd className="tabular-nums">{brl(sub + Math.round((sub * pct) / 100))}</dd></div>
          </dl>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <button className="btn-primary col-span-2 py-3 sm:col-span-1" onClick={() => { setErr(""); setMsg(""); setMode("add"); }}>+ Lançar itens</button>
            <button className="btn-secondary" disabled={busy || empty || !!tab.bill_requested_at}
              onClick={() => run(() => sb.rpc("tab_update", { p_tab_id: tab.id, p_action: "request_bill" }), "Conta solicitada. O caixa foi avisado.")}>Pedir a conta</button>
            <button className="btn-secondary" disabled={empty} onClick={() => printPreBill(tab, title, unit.name, people)}>Imprimir pré-conta</button>
            <button className="btn-secondary" onClick={() => { setErr(""); setMode("transfer"); }}>Transferir mesa</button>
            {empty && (
              <button className="btn-ghost text-red-600" disabled={busy} onClick={async () => {
                if (!confirm("Cancelar esta comanda vazia?")) return;
                if (await run(() => sb.rpc("tab_update", { p_tab_id: tab.id, p_action: "cancel" }))) onClose();
              }}>Cancelar comanda</button>
            )}
            {canClose && <button className="btn-success col-span-2 py-3 sm:col-span-1" disabled={empty} onClick={startClose}>Fechar conta</button>}
          </div>
          {!canClose && <p className="text-xs text-zinc-500">O fechamento da conta é feito pelo caixa ou pelo gerente.</p>}
        </div>
      )}

      {mode === "add" && (
        <div className="mt-3 grid gap-4 lg:grid-cols-[1fr_18rem]">
          <ProductPicker catalog={catalog} onAdd={(l) => setLines((ls) => [...ls, l])} />
          <div className="space-y-3">
            <h3 className="font-semibold">A enviar</h3>
            {lines.length === 0 ? <p className="text-sm text-zinc-500">Toque nos produtos para adicionar.</p> : (
              <ul className="divide-y divide-zinc-100 text-sm">
                {lines.map((l) => (
                  <li key={l.key} className="py-2">
                    <span className="flex items-start justify-between gap-2">
                      <span className="font-medium">{l.quantity}x {l.name}</span>
                      <span className="flex items-center gap-2 tabular-nums">{brl(l.unit_price_cents * l.quantity)}
                        <button className="text-red-600" aria-label={`Remover ${l.name}`} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>✕</button>
                      </span>
                    </span>
                    {l.options.map((o) => <span key={o.option_id} className="block pl-3 text-xs text-zinc-500">+ {o.quantity > 1 ? `${o.quantity}x ` : ""}{o.name}</span>)}
                    {l.notes && <span className="block pl-3 text-xs font-semibold text-amber-700">Obs.: {l.notes}</span>}
                  </li>
                ))}
              </ul>
            )}
            <Field label="Observação para a cozinha"><input className="input" maxLength={300} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
            <p className="flex justify-between font-bold"><span>Total</span><span className="tabular-nums">{brl(linesTotal(lines))}</span></p>
            <button className="btn-primary w-full py-3" disabled={busy || !lines.length} onClick={send}>{busy ? "Enviando..." : "Enviar para a cozinha"}</button>
            <button className="btn-ghost w-full" onClick={() => setMode("view")}>Voltar</button>
          </div>
        </div>
      )}

      {mode === "transfer" && (
        <div className="mt-3 space-y-3">
          <p className="text-sm text-zinc-600">Escolha a mesa de destino:</p>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
            {tables.filter((t) => t.active && t.id !== tab.table_id).map((t) => (
              <button key={t.id} className="btn-secondary py-3" disabled={busy}
                onClick={async () => { if (await run(() => sb.rpc("tab_update", { p_tab_id: tab.id, p_action: "transfer", p_table_id: t.id }), `Transferida para a mesa ${t.name}.`)) setMode("view"); }}>
                {t.name}
              </button>
            ))}
          </div>
          <button className="btn-ghost" onClick={() => setMode("view")}>Voltar</button>
        </div>
      )}

      {mode === "close" && (
        <div className="mt-3 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex items-center justify-between gap-3 rounded-xl border border-zinc-200 p-3 text-sm">
              <span>Taxa de serviço ({pct}%)<span className="block text-xs text-zinc-500">Opcional para o cliente</span></span>
              <Toggle checked={withFee} onChange={setWithFee} label="Taxa de serviço" />
            </label>
            <Field label="Desconto (R$)"><input className="input" inputMode="decimal" value={discount} onChange={(e) => setDiscount(e.target.value)} placeholder="0,00" /></Field>
          </div>
          <dl className="rounded-xl bg-zinc-50 p-3 text-sm">
            <div className="flex justify-between"><dt>Subtotal</dt><dd className="tabular-nums">{brl(sub)}</dd></div>
            {fee > 0 && <div className="flex justify-between"><dt>Serviço</dt><dd className="tabular-nums">{brl(fee)}</dd></div>}
            {disc > 0 && <div className="flex justify-between text-green-700"><dt>Desconto</dt><dd className="tabular-nums">− {brl(disc)}</dd></div>}
            <div className="mt-1 flex justify-between text-lg font-extrabold"><dt>Total</dt><dd className="tabular-nums">{brl(total)}</dd></div>
          </dl>
          <div className="flex flex-wrap items-end gap-3 rounded-xl border border-zinc-200 p-3">
            <div className="w-28"><Field label="Dividir entre"><input className="input" type="number" min={1} max={99} value={split} onChange={(e) => setSplit(e.target.value)} /></Field></div>
            <p className="pb-2 text-sm">pessoas = <b className="tabular-nums">{brl(Math.ceil(total / people))}</b> cada</p>
            {people > 1 && (
              <button type="button" className="btn-secondary mb-0.5" onClick={() =>
                setPays(Array.from({ length: people }, (_, i) => ({ method: "pix" as const,
                  amount: centsToInput(i === people - 1 ? total - Math.floor(total / people) * (people - 1) : Math.floor(total / people)) })))}>
                Criar {people} pagamentos iguais
              </button>
            )}
          </div>
          <div className="space-y-2">
            <h3 className="font-semibold">Pagamentos</h3>
            {pays.map((p, i) => (
              <div key={i} className="flex items-center gap-2">
                <select className="input w-40" value={p.method} aria-label="Forma de pagamento" onChange={(e) => setPay(i, { method: e.target.value as Pay["method"] })}>
                  {METHODS.map((m) => <option key={m} value={m}>{PAYMENT_LABEL[m]}</option>)}
                </select>
                <input className="input flex-1" inputMode="decimal" aria-label="Valor" value={p.amount} onChange={(e) => setPay(i, { amount: e.target.value })} placeholder="0,00" />
                {pays.length > 1 && <button className="btn-ghost px-2 text-red-600" aria-label="Remover pagamento" onClick={() => setPays((ps) => ps.filter((_, j) => j !== i))}>✕</button>}
              </div>
            ))}
            <button type="button" className="btn-ghost text-sm" onClick={() => setPays((ps) => [...ps, { method: "cash", amount: remaining ? centsToInput(remaining) : "" }])}>+ Outro pagamento</button>
          </div>
          <div className="rounded-xl p-3 text-sm font-bold" role="status">
            {remaining > 0 && <p className="text-red-700">Faltam {brl(remaining)}</p>}
            {remaining === 0 && change === 0 && <p className="text-green-700">Valor exato ✓</p>}
            {change > 0 && change <= cashPaid && <p className="text-amber-800">Troco: {brl(change)}</p>}
            {change > cashPaid && <p className="text-red-700">O valor passa do total em {brl(change)}. Troco só sobre dinheiro.</p>}
          </div>
          <div className="flex gap-2">
            <button className="btn-ghost" onClick={() => setMode("view")}>Voltar</button>
            <button className="btn-success flex-1 py-3" disabled={busy || remaining > 0 || change > cashPaid} onClick={closeBill}>
              {busy ? "Fechando..." : `Fechar conta · ${brl(total)}`}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
