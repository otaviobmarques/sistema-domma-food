"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { usePanel } from "@/lib/panel/context";
import { Alert } from "@/components/ui";
import { brl, centsToInput, errorMessage, formatPhone, onlyDigits, parseBRL } from "@/lib/format";
import { linesToPayload, linesTotal, ProductPicker, usePosCatalog, type PosLine } from "@/components/pos/product-picker";
import { METHOD_LABEL, PAY_METHODS, type PayMethod as Method } from "./types";
import { CreditInfo, creditAvailable, useCreditCustomer } from "@/components/pos/credit-info";
import { printReceipt, type Receipt } from "./receipt";
import { EmitButton } from "@/components/fiscal/emit-button";
import { isNetworkError, saleCode, type PosQueue } from "@/lib/offline/pos-queue";

type Pay = { key: string; method: Method; value: string };

export function Pos({ onSold, queue, sessionId, netDown = false }: { onSold: () => void; queue: PosQueue; sessionId: string; netDown?: boolean }) {
  const { unit, tenantId } = usePanel();
  const catalog = usePosCatalog(tenantId, unit.id, "counter");
  const [lines, setLines] = useState<PosLine[]>([]);
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState<"pickup" | "dine_in">("pickup");
  const [notes, setNotes] = useState("");
  const [discMode, setDiscMode] = useState<"R$" | "%">("R$");
  const [disc, setDisc] = useState("");
  const [pays, setPays] = useState<Pay[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState<Receipt | null>(null);
  const [doneOrderId, setDoneOrderId] = useState<string | null>(null);

  const subtotal = linesTotal(lines);
  const discount = useMemo(() => {
    if (!disc.trim()) return 0;
    const v = discMode === "%" ? Math.round(subtotal * Math.min(100, Number(disc.replace(",", ".")) || 0) / 100) : parseBRL(disc);
    return Math.max(0, Math.min(v, subtotal));
  }, [disc, discMode, subtotal]);
  const total = subtotal - discount;
  const paid = pays.reduce((s, p) => s + parseBRL(p.value), 0);
  const cashPaid = pays.filter((p) => p.method === "cash").reduce((s, p) => s + parseBRL(p.value), 0);
  const remaining = Math.max(0, total - paid);
  const change = Math.max(0, paid - total);
  const creditAmt = pays.filter((p) => p.method === "credit_account").reduce((s, p) => s + parseBRL(p.value), 0);
  const creditCust = useCreditCustomer(tenantId, phone, creditAmt > 0 || pays.some((p) => p.method === "credit_account"));
  const creditOk = creditAmt === 0 || (!!creditCust && creditAvailable(creditCust) >= creditAmt);
  const offline = netDown || !queue.online;
  const creditBlocked = offline && pays.some((p) => p.method === "credit_account");
  const canFinish = !creditBlocked && creditOk && lines.length > 0 && paid >= total && change <= cashPaid && pays.every((p) => parseBRL(p.value) > 0) && pays.length > 0 && !busy;

  const addLine = useCallback((l: PosLine) => {
    setErr("");
    setLines((cur) => {
      // junta itens idênticos sem complementos nem observação
      const same = cur.find((x) => x.product_id === l.product_id && !x.options.length && !l.options.length && !x.notes && !l.notes);
      return same ? cur.map((x) => (x === same ? { ...x, quantity: Math.min(99, x.quantity + l.quantity) } : x)) : [...cur, l];
    });
  }, []);
  const setQty = (key: string, q: number) => setLines((cur) => (q <= 0 ? cur.filter((l) => l.key !== key) : cur.map((l) => (l.key === key ? { ...l, quantity: Math.min(99, q) } : l))));

  function addPay(method: Method) {
    setErr("");
    setPays((cur) => {
      const rest = Math.max(0, total - cur.reduce((s, p) => s + parseBRL(p.value), 0));
      return [...cur, { key: crypto.randomUUID(), method, value: rest ? centsToInput(rest) : "" }];
    });
  }

  function reset() {
    setLines([]); setPhone(""); setName(""); setNotes(""); setDisc(""); setPays([]); setErr(""); setDone(null); setDoneOrderId(null); setType("pickup");
  }

  const finish = useCallback(async () => {
    if (!canFinish) return;
    setBusy(true); setErr("");
    const payments = pays.map((p) => ({ method: p.method, amount_cents: parseBRL(p.value) }));
    // o identificador acompanha a venda: se a resposta se perder, o reenvio não duplica
    const ref = crypto.randomUUID();
    const p = { unit_id: unit.id, type, items: linesToPayload(lines), customer: { name: name.trim(), phone: onlyDigits(phone) },
      discount_cents: discount, notes: notes.trim(), payments, client_ref: ref };
    const base: Receipt = {
      store: unit.name, number: 0, lines, subtotal, discount, total, change,
      payments: payments.map((x) => ({ label: METHOD_LABEL[x.method], amount: x.amount_cents })),
      customer: name.trim() || undefined, type: type === "dine_in" ? "Comer aqui" : "Para viagem", notes: notes.trim() || undefined,
    };
    let netDown = offline;
    if (!netDown) {
      const { data, error } = await supabaseBrowser().rpc("pos_sale", { p }).abortSignal(AbortSignal.timeout(12_000));
      if (!error) {
        queue.setNet(true);
        setBusy(false);
        setDoneOrderId(data.order_id ?? null);
        setDone({ ...base, number: data.number, total: data.total_cents, change: data.change_cents });
        onSold();
        return;
      }
      if (!isNetworkError(error)) { setBusy(false); setErr(errorMessage(error)); return; }
      netDown = true;
      queue.setNet(false);
    }
    // sem internet: guarda no aparelho e envia quando a conexão voltar
    if (payments.some((x) => x.method === "credit_account")) { setBusy(false); setErr("Sem internet: fiado não pode ser vendido agora. Use outra forma de pagamento."); return; }
    const at = new Date().toISOString();
    const code = saleCode(ref);
    const receipt: Receipt = { ...base, number: code, offline: true, at };
    const ok = queue.add({
      ref, code, sold_at: at, total_cents: total, customer: name.trim() || undefined, receipt,
      payload: { ...p, offline_sold_at: at, subtotal_cents: subtotal, cash_session_id: sessionId,
        snapshot: lines.map((l) => ({ product_id: l.product_id, quantity: l.quantity, unit_price_cents: l.unit_price_cents, notes: l.notes || undefined,
          options: l.options.map((o) => ({ option_id: o.option_id, name: o.name, price_cents: o.price_cents, quantity: o.quantity, group: o.group })) })) },
    });
    setBusy(false);
    if (!ok) { setErr("Sem internet e sem espaço para guardar a venda neste aparelho. Anote a venda à mão."); return; }
    setDoneOrderId(null);
    setDone(receipt);
  }, [canFinish, offline, pays, unit.id, unit.name, type, lines, name, phone, discount, notes, subtotal, total, change, queue, sessionId, onSold]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "F10") { e.preventDefault(); if (done) reset(); else finish(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [finish, done]);

  if (done) {
    return (
      <div className="card mx-auto max-w-md space-y-4 p-8 text-center">
        {done.offline ? (
          <>
            <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-amber-100 text-2xl text-amber-800">⏳</div>
            <div>
              <p className="text-sm text-zinc-500">Venda guardada neste aparelho (sem internet)</p>
              <p className="text-3xl font-semibold">Venda {done.number}</p>
              <p className="mt-1 text-sm text-zinc-600">Total {brl(done.total)}. Imprima o cupom e entregue à cozinha: o pedido entra no sistema quando a conexão voltar.</p>
            </div>
          </>
        ) : (
          <>
            <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-green-100 text-2xl text-green-700">✓</div>
            <div>
              <p className="text-sm text-zinc-500">Venda registrada</p>
              <p className="text-3xl font-semibold">Pedido #{done.number}</p>
              <p className="mt-1 text-sm text-zinc-600">Total {brl(done.total)} · enviado para a cozinha</p>
            </div>
          </>
        )}
        {done.change > 0 && (
          <div className="rounded-xl bg-amber-50 p-4 ring-1 ring-amber-200">
            <p className="text-sm font-semibold text-amber-900">Troco</p>
            <p className="text-4xl font-semibold tabular-nums text-amber-900">{brl(done.change)}</p>
          </div>
        )}
        {doneOrderId && <EmitButton orderId={doneOrderId} compact />}
        <div className="flex gap-2">
          <button className={`${done.offline ? "btn-primary" : "btn-secondary"} flex-1`} onClick={() => printReceipt(done)}>{done.offline ? "Imprimir cupom (cozinha)" : "Imprimir cupom"}</button>
          <button className={`${done.offline ? "btn-secondary" : "btn-primary"} flex-1`} onClick={reset} autoFocus>Nova venda (F10)</button>
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
      <section aria-label="Produtos"><ProductPicker catalog={catalog} onAdd={addLine} /></section>

      <aside className="card flex flex-col gap-3 self-start lg:sticky lg:top-4" aria-label="Venda atual">
        <div className="flex items-center justify-between">
          <h2 className="font-bold">Venda</h2>
          <div className="flex rounded-lg bg-zinc-100 p-0.5 text-xs font-semibold" role="radiogroup" aria-label="Tipo">
            {([["pickup", "Para viagem"], ["dine_in", "Comer aqui"]] as const).map(([k, l]) => (
              <button key={k} type="button" role="radio" aria-checked={type === k} onClick={() => setType(k)}
                className={`rounded-md px-2.5 py-1 ${type === k ? "bg-white shadow-sm" : "text-zinc-500"}`}>{l}</button>
            ))}
          </div>
        </div>

        {lines.length === 0 ? <p className="rounded-lg border border-dashed border-zinc-300 py-8 text-center text-sm text-zinc-500">Toque nos produtos para adicionar.</p> : (
          <ul className="max-h-[38vh] divide-y divide-zinc-100 overflow-y-auto">
            {lines.map((l) => (
              <li key={l.key} className="py-2 text-sm">
                <div className="flex items-start justify-between gap-2">
                  <span className="font-medium">{l.name}</span>
                  <span className="shrink-0 font-semibold tabular-nums">{brl(l.unit_price_cents * l.quantity)}</span>
                </div>
                {l.options.map((o) => <p key={o.option_id} className="text-xs text-zinc-500">+ {o.quantity > 1 ? `${o.quantity}x ` : ""}{o.name}</p>)}
                {l.notes && <p className="text-xs font-medium text-amber-800">Obs.: {l.notes}</p>}
                <div className="mt-1 flex items-center gap-2">
                  <button type="button" className="h-7 w-7 rounded-md border border-zinc-300" onClick={() => setQty(l.key, l.quantity - 1)} aria-label="Diminuir">−</button>
                  <span className="w-5 text-center font-semibold tabular-nums">{l.quantity}</span>
                  <button type="button" className="h-7 w-7 rounded-md border border-zinc-300" onClick={() => setQty(l.key, l.quantity + 1)} aria-label="Aumentar">+</button>
                  <button type="button" className="ml-auto text-xs text-red-600 hover:underline" onClick={() => setQty(l.key, 0)}>Remover</button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="grid grid-cols-2 gap-2">
          <input className="input" placeholder="WhatsApp (opcional)" inputMode="tel" value={phone} onChange={(e) => setPhone(formatPhone(e.target.value))} aria-label="WhatsApp do cliente" />
          <input className="input" placeholder="Nome" value={name} onChange={(e) => setName(e.target.value)} aria-label="Nome do cliente" />
        </div>
        <input className="input" placeholder="Observação do pedido" maxLength={300} value={notes} onChange={(e) => setNotes(e.target.value)} aria-label="Observação" />

        <div className="flex items-center gap-2">
          <span className="text-sm text-zinc-600">Desconto</span>
          <div className="flex rounded-lg bg-zinc-100 p-0.5 text-xs font-semibold">
            {(["R$", "%"] as const).map((m) => (
              <button key={m} type="button" onClick={() => { setDiscMode(m); setDisc(""); }} className={`rounded-md px-2 py-1 ${discMode === m ? "bg-white shadow-sm" : "text-zinc-500"}`}>{m}</button>
            ))}
          </div>
          <input className="input w-24 text-right" inputMode="decimal" placeholder="0" value={disc} onChange={(e) => setDisc(e.target.value)} aria-label="Valor do desconto" />
        </div>

        <dl className="space-y-0.5 border-t border-zinc-200 pt-2 text-sm">
          <div className="flex justify-between"><dt className="text-zinc-500">Subtotal</dt><dd className="tabular-nums">{brl(subtotal)}</dd></div>
          {discount > 0 && <div className="flex justify-between text-green-700"><dt>Desconto</dt><dd className="tabular-nums">− {brl(discount)}</dd></div>}
          <div className="flex justify-between text-lg font-semibold"><dt>Total</dt><dd className="tabular-nums">{brl(total)}</dd></div>
        </dl>

        <div>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500">Pagamento</p>
          <div className="grid grid-cols-3 gap-1.5">
            {PAY_METHODS.map((m) => (
              <button key={m} type="button" disabled={!lines.length || (offline && m === "credit_account")} onClick={() => addPay(m)}
                title={offline && m === "credit_account" ? "Fiado precisa de internet" : undefined}
                className="rounded-lg border border-zinc-300 bg-white px-1 py-2 text-xs font-semibold hover:border-brand-500 hover:text-brand-700 disabled:opacity-40">
                {METHOD_LABEL[m]}
              </button>
            ))}
          </div>
          {pays.map((p) => (
            <div key={p.key} className="mt-2 flex items-center gap-2">
              <span className="w-20 text-sm font-medium">{METHOD_LABEL[p.method]}</span>
              <input className="input flex-1 text-right tabular-nums" inputMode="decimal" value={p.value} autoFocus
                aria-label={p.method === "cash" ? "Valor recebido em dinheiro" : `Valor em ${METHOD_LABEL[p.method]}`}
                placeholder={p.method === "cash" ? "Valor recebido" : "0,00"}
                onChange={(e) => setPays((cur) => cur.map((x) => (x.key === p.key ? { ...x, value: e.target.value } : x)))} />
              <button type="button" className="px-1 text-red-600" onClick={() => setPays((cur) => cur.filter((x) => x.key !== p.key))} aria-label="Remover pagamento">✕</button>
            </div>
          ))}
          {pays.length > 0 && (
            <div className="mt-2 flex justify-between rounded-lg bg-zinc-50 px-3 py-2 text-sm font-semibold">
              {remaining > 0 ? <><span className="text-red-700">Falta</span><span className="tabular-nums text-red-700">{brl(remaining)}</span></>
                : change > 0 ? <><span className="text-amber-800">Troco</span><span className="text-lg tabular-nums text-amber-800">{brl(change)}</span></>
                : <><span className="text-green-700">Valor exato</span><span className="text-green-700">✓</span></>}
            </div>
          )}
          {pays.some((p) => p.method === "credit_account") && <div className="mt-1.5"><CreditInfo customer={creditCust} phone={phone} amount={creditAmt} /></div>}
          {change > cashPaid && <p className="mt-1 text-xs text-red-700">Só é possível dar troco sobre o valor em dinheiro.</p>}
        </div>

        {creditBlocked && <p className="text-xs text-red-700">Sem internet: fiado não pode ser vendido agora.</p>}
        <Alert>{err}</Alert>
        <button type="button" className="btn-success w-full py-3 text-base" disabled={!canFinish} onClick={finish}>
          {busy ? "Registrando..." : `${offline ? "Finalizar sem internet" : "Finalizar"} (F10) · ${brl(total)}`}
        </button>
      </aside>
    </div>
  );
}
