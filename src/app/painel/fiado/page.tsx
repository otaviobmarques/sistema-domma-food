"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { canManage, usePanel } from "@/lib/panel/context";
import { Alert, Empty, Field, Modal } from "@/components/ui";
import { brl, centsToInput, errorMessage, formatPhone, onlyDigits, parseBRL } from "@/lib/format";

type Cust = { id: string; name: string; phone: string; credit_limit_cents: number; credit_balance_cents: number };
type Entry = { id: number; kind: "charge" | "payment" | "adjust" | "reversal"; amount_cents: number; balance_after: number;
  method: string | null; note: string | null; created_at: string; order_id: string | null };

const KIND: Record<Entry["kind"], string> = { charge: "Compra", payment: "Pagamento", adjust: "Ajuste", reversal: "Estorno" };
const PAY: Record<string, string> = { cash: "Dinheiro", pix: "Pix", credit_card: "Crédito", debit_card: "Débito" };
const when = (iso: string) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });

export default function Fiado() {
  const { tenantId, role, unit } = usePanel();
  const sb = supabaseBrowser();
  const manager = canManage(role);
  const allowed = manager || role === "cashier";
  const [list, setList] = useState<Cust[]>([]);
  const [q, setQ] = useState("");
  const [onlyDebt, setOnlyDebt] = useState(false);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState<Cust | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await sb.from("customers").select("id, name, phone, credit_limit_cents, credit_balance_cents")
      .eq("tenant_id", tenantId).or("credit_limit_cents.gt.0,credit_balance_cents.gt.0")
      .order("credit_balance_cents", { ascending: false }).limit(1000);
    if (error) setErr(errorMessage(error)); else setList(data as Cust[]);
  }, [sb, tenantId]);
  useEffect(() => { if (allowed) load(); }, [load, allowed]);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase(), d = onlyDigits(q);
    return list.filter((c) => (!onlyDebt || c.credit_balance_cents > 0)
      && (!t || c.name.toLowerCase().includes(t) || (d.length >= 3 && c.phone.includes(d))));
  }, [list, q, onlyDebt]);
  const totalDebt = list.reduce((s, c) => s + Math.max(0, c.credit_balance_cents), 0);
  const debtors = list.filter((c) => c.credit_balance_cents > 0).length;
  const totalLimit = list.reduce((s, c) => s + c.credit_limit_cents, 0);

  if (!allowed) return <Empty>O fiado é acessado pelo caixa e pela gerência.</Empty>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="h1">Fiado</h1>
          <p className="text-sm text-zinc-500">Conta do cliente: venda no PDV ou na mesa com a forma &quot;Fiado&quot; e receba depois.</p>
        </div>
        {manager && <button className="btn-primary" onClick={() => setAdding(true)}>+ Liberar fiado para cliente</button>}
      </div>
      <Alert>{err}</Alert>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="card"><p className="text-xs font-medium text-zinc-500">Total a receber</p><p className="mt-1 text-2xl font-semibold tabular-nums text-brand-700">{brl(totalDebt)}</p></div>
        <div className="card"><p className="text-xs font-medium text-zinc-500">Clientes devendo</p><p className="mt-1 text-2xl font-semibold tabular-nums">{debtors}</p></div>
        <div className="card"><p className="text-xs font-medium text-zinc-500">Limite total liberado</p><p className="mt-1 text-2xl font-semibold tabular-nums">{brl(totalLimit)}</p></div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input className="input max-w-xs" placeholder="Buscar por nome ou telefone" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar cliente" />
        <label className="flex items-center gap-2 text-sm text-zinc-600"><input type="checkbox" checked={onlyDebt} onChange={(e) => setOnlyDebt(e.target.checked)} /> Só quem está devendo</label>
      </div>

      {shown.length === 0 ? <Empty>{list.length ? "Nenhum cliente encontrado." : "Nenhum cliente com fiado ainda. Libere um limite para começar."}</Empty> : (
        <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              <tr><th className="p-3">Cliente</th><th className="p-3">Telefone</th><th className="p-3 text-right">Deve</th><th className="p-3 text-right">Limite</th><th className="p-3 text-right">Disponível</th><th /></tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {shown.map((c) => {
                const avail = Math.max(0, c.credit_limit_cents - c.credit_balance_cents);
                const pct = c.credit_limit_cents ? Math.min(100, (c.credit_balance_cents / c.credit_limit_cents) * 100) : 100;
                return (
                  <tr key={c.id} className="hover:bg-zinc-50">
                    <td className="p-3 font-medium">{c.name}</td>
                    <td className="p-3 tabular-nums text-zinc-600">{formatPhone(c.phone)}</td>
                    <td className={`p-3 text-right font-semibold tabular-nums ${c.credit_balance_cents > 0 ? "text-brand-700" : "text-zinc-400"}`}>{brl(c.credit_balance_cents)}</td>
                    <td className="p-3 text-right tabular-nums">
                      {brl(c.credit_limit_cents)}
                      <span className="mt-1 block h-1 w-full overflow-hidden rounded bg-zinc-100"><span className={`block h-full ${pct >= 90 ? "bg-red-500" : "bg-brand-400"}`} style={{ width: `${pct}%` }} /></span>
                    </td>
                    <td className="p-3 text-right tabular-nums">{brl(avail)}</td>
                    <td className="p-3 text-right"><button className="btn-secondary" onClick={() => setOpen(c)}>Abrir conta</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {open && <Account key={open.id} cust={open} manager={manager} unitId={unit.id} storeName={unit.name}
        onClose={() => setOpen(null)} onChanged={async () => { await load(); }} />}
      {adding && <Grant tenantId={tenantId} onClose={() => setAdding(false)} onDone={async (c) => { setAdding(false); await load(); setOpen(c); }} />}
    </div>
  );
}

function Account({ cust, manager, unitId, storeName, onClose, onChanged }: {
  cust: Cust; manager: boolean; unitId: string; storeName: string; onClose: () => void; onChanged: () => Promise<void>;
}) {
  const sb = supabaseBrowser();
  const [c, setC] = useState(cust);
  const [rows, setRows] = useState<Entry[]>([]);
  const [mode, setMode] = useState<"view" | "pay" | "limit" | "adjust">("view");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("pix");
  const [note, setNote] = useState("");
  const [sign, setSign] = useState<1 | -1>(-1);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  const refresh = useCallback(async () => {
    const [a, b] = await Promise.all([
      sb.from("customers").select("id, name, phone, credit_limit_cents, credit_balance_cents").eq("id", cust.id).single(),
      sb.from("credit_ledger").select("id, kind, amount_cents, balance_after, method, note, created_at, order_id").eq("customer_id", cust.id).order("id", { ascending: false }).limit(150),
    ]);
    if (a.data) setC(a.data as Cust);
    if (b.error) setErr(errorMessage(b.error)); else setRows(b.data as Entry[]);
  }, [sb, cust.id]);
  useEffect(() => { refresh(); }, [refresh]);

  function start(m: typeof mode) {
    setErr(""); setMsg(""); setNote(""); setMode(m);
    setAmount(m === "pay" ? centsToInput(c.credit_balance_cents) : m === "limit" ? centsToInput(c.credit_limit_cents) : "");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr("");
    const v = parseBRL(amount);
    const res = mode === "pay" ? await sb.rpc("credit_pay", { p_customer_id: c.id, p_amount_cents: v, p_method: method, p_unit_id: unitId, p_note: note || null })
      : mode === "limit" ? await sb.rpc("credit_set_limit", { p_customer_id: c.id, p_limit_cents: v })
      : await sb.rpc("credit_adjust", { p_customer_id: c.id, p_amount_cents: sign * v, p_note: note });
    setBusy(false);
    if (res.error) { setErr(errorMessage(res.error)); return; }
    if (mode === "pay") setMsg((res.data as { in_cash_session: boolean }).in_cash_session ? "Pagamento recebido e lançado no caixa." : "Pagamento recebido. O caixa está fechado, então não entrou na gaveta.");
    else setMsg(mode === "limit" ? "Limite atualizado." : "Ajuste lançado.");
    setMode("view"); await refresh(); await onChanged();
  }

  const wa = `https://wa.me/55${c.phone.replace(/^55/, "")}?text=${encodeURIComponent(
    `Olá, ${c.name.split(" ")[0]}! Passando para lembrar do seu saldo em aberto de ${brl(c.credit_balance_cents)} na ${storeName}. Qualquer dúvida, é só chamar.`)}`;

  return (
    <Modal open onClose={onClose} title={`Fiado · ${c.name}`} wide>
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-lg border border-zinc-200 p-3"><p className="text-xs text-zinc-500">Deve</p><p className="text-xl font-semibold tabular-nums text-brand-700">{brl(c.credit_balance_cents)}</p></div>
          <div className="rounded-lg border border-zinc-200 p-3"><p className="text-xs text-zinc-500">Limite</p><p className="text-xl font-semibold tabular-nums">{brl(c.credit_limit_cents)}</p></div>
          <div className="rounded-lg border border-zinc-200 p-3"><p className="text-xs text-zinc-500">Disponível</p><p className="text-xl font-semibold tabular-nums">{brl(Math.max(0, c.credit_limit_cents - c.credit_balance_cents))}</p></div>
        </div>
        <Alert kind="success">{msg}</Alert>

        {mode === "view" ? (
          <div className="flex flex-wrap gap-2">
            <button className="btn-success" disabled={c.credit_balance_cents <= 0} onClick={() => start("pay")}>Receber pagamento</button>
            {manager && <button className="btn-secondary" onClick={() => start("limit")}>Alterar limite</button>}
            {manager && <button className="btn-secondary" onClick={() => start("adjust")}>Ajuste manual</button>}
            {c.credit_balance_cents > 0 && <a className="btn-ghost" href={wa} target="_blank" rel="noopener noreferrer">Cobrar no WhatsApp</a>}
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3 rounded-lg border border-zinc-200 p-4">
            <h3 className="font-semibold">{mode === "pay" ? "Receber pagamento" : mode === "limit" ? "Limite de fiado" : "Ajuste manual"}</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={mode === "limit" ? "Novo limite (R$)" : "Valor (R$)"} hint={mode === "limit" ? "Use 0 para bloquear novas compras no fiado." : undefined}>
                <input className="input text-right tabular-nums" inputMode="decimal" required autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} />
              </Field>
              {mode === "pay" && (
                <Field label="Forma de pagamento">
                  <select className="input" value={method} onChange={(e) => setMethod(e.target.value)}>
                    {Object.entries(PAY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                </Field>
              )}
              {mode === "adjust" && (
                <Field label="Tipo">
                  <select className="input" value={sign} onChange={(e) => setSign(Number(e.target.value) as 1 | -1)}>
                    <option value={-1}>Abater da dívida</option><option value={1}>Aumentar a dívida</option>
                  </select>
                </Field>
              )}
            </div>
            {mode !== "limit" && (
              <Field label={mode === "adjust" ? "Motivo (obrigatório)" : "Observação"}>
                <input className="input" maxLength={200} required={mode === "adjust"} value={note} onChange={(e) => setNote(e.target.value)} />
              </Field>
            )}
            {mode === "pay" && <p className="text-xs text-zinc-500">Com o caixa aberto, o valor entra no caixa na forma escolhida. Em dinheiro, o caixa precisa estar aberto.</p>}
            <Alert>{err}</Alert>
            <div className="flex gap-2">
              <button type="button" className="btn-ghost" onClick={() => setMode("view")}>Cancelar</button>
              <button className="btn-primary flex-1" disabled={busy}>{busy ? "Salvando..." : "Confirmar"}</button>
            </div>
          </form>
        )}

        <div>
          <h3 className="mb-2 font-semibold">Extrato</h3>
          {rows.length === 0 ? <p className="rounded-lg border border-dashed border-zinc-300 p-4 text-center text-sm text-zinc-500">Nenhum lançamento ainda.</p> : (
            <div className="max-h-[45vh] overflow-y-auto rounded-lg border border-zinc-200">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-zinc-50 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                  <tr><th className="p-2.5">Data</th><th className="p-2.5">Lançamento</th><th className="p-2.5 text-right">Valor</th><th className="p-2.5 text-right">Saldo</th></tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td className="whitespace-nowrap p-2.5 tabular-nums text-zinc-600">{when(r.created_at)}</td>
                      <td className="p-2.5">{KIND[r.kind]}{r.method ? ` · ${PAY[r.method] ?? r.method}` : ""}{r.note ? <span className="block text-xs text-zinc-500">{r.note}</span> : null}</td>
                      <td className={`p-2.5 text-right font-medium tabular-nums ${r.amount_cents > 0 ? "text-brand-700" : "text-green-700"}`}>{r.amount_cents > 0 ? "+ " : "− "}{brl(Math.abs(r.amount_cents))}</td>
                      <td className="p-2.5 text-right tabular-nums">{brl(r.balance_after)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function Grant({ tenantId, onClose, onDone }: { tenantId: string; onClose: () => void; onDone: (c: Cust) => void }) {
  const sb = supabaseBrowser();
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Cust[]>([]);
  const [pick, setPick] = useState<Cust | null>(null);
  const [newName, setNewName] = useState("");
  const [limit, setLimit] = useState("200,00");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const digits = onlyDigits(q);

  useEffect(() => {
    const t = q.trim();
    if (t.length < 2) { setFound([]); return; }
    let alive = true;
    const h = setTimeout(async () => {
      let req = sb.from("customers").select("id, name, phone, credit_limit_cents, credit_balance_cents").eq("tenant_id", tenantId).limit(8);
      req = digits.length >= 4 ? req.like("phone", `%${digits}%`) : req.ilike("name", `%${t.replace(/[%_]/g, "")}%`);
      const { data } = await req;
      if (alive) setFound((data as Cust[]) ?? []);
    }, 250);
    return () => { alive = false; clearTimeout(h); };
  }, [q, digits, sb, tenantId]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr("");
    let c = pick;
    if (!c) {
      if (digits.length < 10 || newName.trim().length < 2) { setBusy(false); setErr("Informe o WhatsApp completo e o nome do cliente."); return; }
      const { data, error } = await sb.from("customers").insert({ tenant_id: tenantId, name: newName.trim(), phone: digits })
        .select("id, name, phone, credit_limit_cents, credit_balance_cents").single();
      if (error) { setBusy(false); setErr(error.code === "23505" ? "Já existe cliente com este telefone. Busque por ele acima." : errorMessage(error)); return; }
      c = data as Cust;
    }
    const { error } = await sb.rpc("credit_set_limit", { p_customer_id: c.id, p_limit_cents: parseBRL(limit) });
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return; }
    onDone({ ...c, credit_limit_cents: parseBRL(limit) });
  }

  return (
    <Modal open onClose={onClose} title="Liberar fiado">
      <form onSubmit={save} className="space-y-3">
        {pick ? (
          <div className="flex items-center justify-between rounded-lg border border-brand-200 bg-brand-50 p-3 text-sm">
            <span><b>{pick.name}</b> · {formatPhone(pick.phone)}</span>
            <button type="button" className="btn-ghost text-xs" onClick={() => setPick(null)}>Trocar</button>
          </div>
        ) : (
          <>
            <Field label="Cliente" hint="Busque pelo nome ou WhatsApp. Se não existir, cadastramos agora.">
              <input className="input" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nome ou (31) 99999-9999" />
            </Field>
            {found.length > 0 && (
              <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200">
                {found.map((c) => (
                  <li key={c.id}><button type="button" className="flex w-full justify-between p-2.5 text-left text-sm hover:bg-zinc-50" onClick={() => { setPick(c); setLimit(centsToInput(c.credit_limit_cents || 20000)); }}>
                    <span className="font-medium">{c.name}</span><span className="tabular-nums text-zinc-500">{formatPhone(c.phone)}</span>
                  </button></li>
                ))}
              </ul>
            )}
            {digits.length >= 10 && !found.some((c) => c.phone === digits) && (
              <Field label="Nome do novo cliente"><input className="input" value={newName} onChange={(e) => setNewName(e.target.value)} /></Field>
            )}
          </>
        )}
        <Field label="Limite de fiado (R$)"><input className="input text-right tabular-nums" inputMode="decimal" required value={limit} onChange={(e) => setLimit(e.target.value)} /></Field>
        <Alert>{err}</Alert>
        <button className="btn-primary w-full" disabled={busy || (!pick && digits.length < 10)}>{busy ? "Salvando..." : "Liberar fiado"}</button>
      </form>
    </Modal>
  );
}
