"use client";
import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { canManage, usePanel } from "@/lib/panel/context";
import { Alert, Empty, Field, Modal, Toggle } from "@/components/ui";
import { brl, centsToInput, errorMessage, parseBRL } from "@/lib/format";

type Settings = {
  cashback_enabled: boolean; cashback_pct: number; cashback_pct_by_dow: (number | null)[] | null;
  cashback_expires_days: number; cashback_max_use_pct: number; cashback_min_order_cents: number;
  stack_with_coupon: boolean; points_enabled: boolean; points_per_real: number;
};
type Reward = { id: string; name: string; description: string | null; points_cost: number; active: boolean };
type Ledger = {
  id: number; kind: "cashback" | "points"; amount: number; reason: string; note: string | null; created_at: string;
  customers: { name: string } | { name: string }[] | null;
};

const DEFAULTS: Settings = {
  cashback_enabled: false, cashback_pct: 5, cashback_pct_by_dow: null, cashback_expires_days: 30,
  cashback_max_use_pct: 50, cashback_min_order_cents: 0, stack_with_coupon: false, points_enabled: false, points_per_real: 1,
};
const DOW = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const REASON: Record<string, string> = { earn: "Ganhou", redeem: "Usou", refund: "Devolvido", expire: "Expirou", manual: "Ajuste", reward: "Recompensa" };
const num = (v: string) => Number(v.replace(",", "."));

export default function Fidelidade() {
  const { tenantId, role } = usePanel();
  const sb = supabaseBrowser();
  const [f, setF] = useState({ pct: "5", dow: ["", "", "", "", "", "", ""], days: "30", maxUse: "50", minOrder: "", perReal: "1" });
  const [flags, setFlags] = useState({ cashback: false, stack: false, points: false });
  const [rewards, setRewards] = useState<Reward[]>([]);
  const [ledger, setLedger] = useState<Ledger[]>([]);
  const [sum, setSum] = useState({ earned: 0, used: 0, expired: 0, open: 0, ptsIn: 0, ptsOut: 0, capped: false });
  const [edit, setEdit] = useState<{ id?: string; name: string; description: string; cost: string; active: boolean } | null>(null);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const [st, rw, recent, agg, cust] = await Promise.all([
      sb.from("loyalty_settings").select("*").eq("tenant_id", tenantId).maybeSingle(),
      sb.from("rewards").select("*").eq("tenant_id", tenantId).order("points_cost"),
      sb.from("loyalty_ledger").select("id, kind, amount, reason, note, created_at, customers(name)").eq("tenant_id", tenantId)
        .order("created_at", { ascending: false }).limit(20),
      sb.from("loyalty_ledger").select("kind, amount, reason").eq("tenant_id", tenantId).gte("created_at", since).limit(5000),
      sb.from("customers").select("cashback_cents").eq("tenant_id", tenantId).gt("cashback_cents", 0).limit(5000),
    ]);
    const firstErr = st.error ?? rw.error ?? recent.error ?? agg.error;
    if (firstErr) setErr(firstErr.message);
    const s: Settings = { ...DEFAULTS, ...((st.data as Partial<Settings> | null) ?? {}) };
    setF({
      pct: String(s.cashback_pct), dow: DOW.map((_, i) => (s.cashback_pct_by_dow?.[i] != null ? String(s.cashback_pct_by_dow[i]) : "")),
      days: String(s.cashback_expires_days), maxUse: String(s.cashback_max_use_pct),
      minOrder: s.cashback_min_order_cents ? centsToInput(s.cashback_min_order_cents) : "", perReal: String(s.points_per_real),
    });
    setFlags({ cashback: s.cashback_enabled, stack: s.stack_with_coupon, points: s.points_enabled });
    setRewards((rw.data ?? []) as Reward[]);
    setLedger((recent.data ?? []) as unknown as Ledger[]);
    const rows = (agg.data ?? []) as { kind: string; amount: number; reason: string }[];
    const tot = (k: string, test: (r: { amount: number; reason: string }) => boolean) =>
      rows.filter((r) => r.kind === k && test(r)).reduce((a, r) => a + Math.abs(r.amount), 0);
    setSum({
      earned: tot("cashback", (r) => r.amount > 0 && r.reason !== "refund"),
      used: tot("cashback", (r) => r.reason === "redeem"),
      expired: tot("cashback", (r) => r.reason === "expire"),
      open: ((cust.data ?? []) as { cashback_cents: number }[]).reduce((a, c) => a + c.cashback_cents, 0),
      ptsIn: tot("points", (r) => r.amount > 0), ptsOut: tot("points", (r) => r.amount < 0),
      capped: rows.length >= 5000,
    });
    setLoaded(true);
  }, [sb, tenantId]);
  useEffect(() => { load(); }, [load]);

  if (!canManage(role)) return <p className="card">Apenas o dono ou o gerente configuram o programa de fidelidade.</p>;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setErr(""); setMsg("");
    const pct = num(f.pct), days = Number(f.days), maxUse = Number(f.maxUse), perReal = num(f.perReal);
    const dow = f.dow.map((v) => (v.trim() === "" ? null : num(v)));
    if (!(pct >= 0 && pct <= 50) || dow.some((v) => v != null && !(v >= 0 && v <= 50))) { setErr("O percentual de cashback deve ficar entre 0 e 50."); return; }
    if (!(days >= 1 && days <= 730)) { setErr("A validade deve ficar entre 1 e 730 dias."); return; }
    if (!(maxUse >= 1 && maxUse <= 90)) { setErr("O uso máximo por pedido deve ficar entre 1% e 90%."); return; }
    if (!(perReal >= 0 && perReal <= 100)) { setErr("Pontos por real deve ficar entre 0 e 100."); return; }
    setBusy(true);
    const { error } = await sb.from("loyalty_settings").upsert({
      tenant_id: tenantId, cashback_enabled: flags.cashback, cashback_pct: pct,
      cashback_pct_by_dow: dow.every((v) => v == null) ? null : dow,
      cashback_expires_days: days, cashback_max_use_pct: maxUse, cashback_min_order_cents: parseBRL(f.minOrder),
      stack_with_coupon: flags.stack, points_enabled: flags.points, points_per_real: perReal,
    }, { onConflict: "tenant_id" });
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return; }
    setMsg("Programa de fidelidade salvo.");
  }

  async function saveReward(e: React.FormEvent) {
    e.preventDefault();
    if (!edit) return;
    const cost = Math.round(Number(edit.cost));
    if (!(cost > 0)) { setErr("Informe o custo em pontos."); return; }
    const row = { tenant_id: tenantId, name: edit.name.trim(), description: edit.description.trim() || null, points_cost: cost, active: edit.active };
    const { error } = edit.id ? await sb.from("rewards").update(row).eq("id", edit.id) : await sb.from("rewards").insert(row);
    if (error) { setErr(errorMessage(error)); return; }
    setEdit(null); setErr(""); load();
  }

  async function removeReward(r: Reward) {
    if (!confirm(`Excluir a recompensa "${r.name}"?`)) return;
    const { error } = await sb.from("rewards").delete().eq("id", r.id);
    if (error) setErr(errorMessage(error)); else load();
  }

  const set = (k: keyof typeof f, v: string) => setF((s) => ({ ...s, [k]: v }));
  const cards: [string, string][] = [
    ["Cashback creditado (30 dias)", brl(sum.earned)], ["Cashback usado (30 dias)", brl(sum.used)],
    ["Cashback expirado (30 dias)", brl(sum.expired)], ["Saldo em aberto dos clientes", brl(sum.open)],
    ["Pontos emitidos (30 dias)", String(sum.ptsIn)], ["Pontos resgatados (30 dias)", String(sum.ptsOut)],
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="h1">Fidelidade</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-600">Cashback e pontos para o cliente voltar a pedir. O crédito entra quando o pedido é concluído e vale para o cardápio próprio e o balcão (pedidos de marketplace não pontuam).</p>
      </div>
      <Alert>{err && !edit ? err : ""}</Alert>
      <Alert kind="success">{msg}</Alert>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {cards.map(([k, v]) => (
          <div key={k} className="card"><p className="text-xs font-medium text-zinc-500">{k}</p><p className="mt-1 text-xl font-bold tabular-nums">{v}</p></div>
        ))}
      </div>
      {sum.capped && <p className="text-xs text-zinc-500">Resumo calculado sobre os 5.000 lançamentos mais recentes do período.</p>}

      <form onSubmit={save} className="space-y-6">
        <section className="card space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div><h2 className="font-semibold">Cashback</h2><p className="text-xs text-zinc-500">Uma parte do valor do pedido volta como saldo para o próximo.</p></div>
            <Toggle checked={flags.cashback} onChange={(v) => setFlags((s) => ({ ...s, cashback: v }))} label="Cashback ativo" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Percentual padrão (%)"><input className="input" inputMode="decimal" required value={f.pct} onChange={(e) => set("pct", e.target.value)} /></Field>
            <Field label="Validade do saldo (dias)"><input className="input" type="number" min={1} max={730} required value={f.days} onChange={(e) => set("days", e.target.value)} /></Field>
            <Field label="Uso máximo por pedido (%)" hint="Quanto do pedido pode ser pago com saldo.">
              <input className="input" type="number" min={1} max={90} required value={f.maxUse} onChange={(e) => set("maxUse", e.target.value)} />
            </Field>
            <Field label="Pedido mínimo para ganhar (R$)"><input className="input" inputMode="decimal" placeholder="Sem mínimo" value={f.minOrder} onChange={(e) => set("minOrder", e.target.value)} /></Field>
          </div>
          <div>
            <p className="label">Percentual por dia da semana (opcional)</p>
            <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
              {DOW.map((d, i) => (
                <label key={d} className="block text-center text-xs text-zinc-600">
                  {d}
                  <input className="input mt-1 text-center" inputMode="decimal" placeholder={f.pct} value={f.dow[i]} aria-label={`Cashback de ${d} (%)`}
                    onChange={(e) => setF((s) => ({ ...s, dow: s.dow.map((v, j) => (j === i ? e.target.value : v)) }))} />
                </label>
              ))}
            </div>
            <p className="mt-1 text-xs text-zinc-500">Deixe em branco para usar o percentual padrão. Ex.: 10% às terças para movimentar o dia fraco.</p>
          </div>
          <label className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 p-3 text-sm">
            <span>Pode acumular com cupom<span className="block text-xs text-zinc-500">Desligado: no pedido com cupom o cliente não usa o saldo.</span></span>
            <Toggle checked={flags.stack} onChange={(v) => setFlags((s) => ({ ...s, stack: v }))} label="Acumular com cupom" />
          </label>
          <Alert kind="info">Segurança: o cliente só usa o saldo no aparelho em que já fez um pedido com aquele telefone. Assim ninguém gasta o cashback de outra pessoa só digitando o número dela.</Alert>
        </section>

        <section className="card space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div><h2 className="font-semibold">Pontos</h2><p className="text-xs text-zinc-500">O cliente junta pontos e troca por recompensas.</p></div>
            <Toggle checked={flags.points} onChange={(v) => setFlags((s) => ({ ...s, points: v }))} label="Pontos ativos" />
          </div>
          <div className="max-w-xs">
            <Field label="Pontos por real gasto"><input className="input" inputMode="decimal" required value={f.perReal} onChange={(e) => set("perReal", e.target.value)} /></Field>
          </div>
        </section>

        <button className="btn-primary" disabled={busy || !loaded}>{busy ? "Salvando..." : "Salvar programa"}</button>
      </form>

      <section className="card space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><h2 className="font-semibold">Recompensas</h2><p className="text-xs text-zinc-500">O resgate é feito pela equipe na tela de Clientes (botão Fidelidade).</p></div>
          <button className="btn-secondary" onClick={() => setEdit({ name: "", description: "", cost: "", active: true })}>+ Nova recompensa</button>
        </div>
        {rewards.length === 0 ? <Empty>Nenhuma recompensa ainda. Ex.: “Refrigerante grátis” por 100 pontos.</Empty> : (
          <ul className="divide-y divide-zinc-100">
            {rewards.map((r) => (
              <li key={r.id} className={`flex flex-wrap items-center justify-between gap-3 py-3 text-sm ${r.active ? "" : "opacity-60"}`}>
                <span><b>{r.name}</b> <span className="badge bg-brand-50 text-brand-800">{r.points_cost} pts</span>
                  {r.description && <span className="block text-xs text-zinc-500">{r.description}</span>}</span>
                <span className="flex items-center gap-2">
                  <Toggle checked={r.active} label="Ativa" onChange={async (v) => { const { error } = await sb.from("rewards").update({ active: v }).eq("id", r.id); if (error) setErr(errorMessage(error)); else load(); }} />
                  <button className="btn-ghost" onClick={() => setEdit({ id: r.id, name: r.name, description: r.description ?? "", cost: String(r.points_cost), active: r.active })}>Editar</button>
                  <button className="btn-ghost text-red-600" onClick={() => removeReward(r)}>Excluir</button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2 className="mb-2 font-semibold">Últimas movimentações</h2>
        {ledger.length === 0 ? <p className="text-sm text-zinc-500">Nada por aqui ainda. Os créditos aparecem quando os pedidos são concluídos.</p> : (
          <ul className="divide-y divide-zinc-100 text-sm">
            {ledger.map((l) => {
              const c = Array.isArray(l.customers) ? l.customers[0] : l.customers;
              return (
                <li key={l.id} className="flex items-center justify-between gap-3 py-2">
                  <span><b>{c?.name ?? "Cliente"}</b> · {REASON[l.reason] ?? l.reason} {l.kind === "cashback" ? "cashback" : "pontos"}
                    {l.note && <span className="text-zinc-500"> · {l.note}</span>}
                    <span className="block text-xs text-zinc-500">{new Date(l.created_at).toLocaleString("pt-BR")}</span></span>
                  <span className={`shrink-0 font-semibold tabular-nums ${l.amount > 0 ? "text-green-700" : "text-red-700"}`}>
                    {l.amount > 0 ? "+" : "−"}{l.kind === "cashback" ? brl(Math.abs(l.amount)) : `${Math.abs(l.amount)} pts`}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <Modal open={!!edit} onClose={() => { setEdit(null); setErr(""); }} title={edit?.id ? "Editar recompensa" : "Nova recompensa"}>
        {edit && (
          <form onSubmit={saveReward} className="space-y-3">
            <Field label="Nome"><input className="input" required maxLength={80} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="Ex.: Refrigerante grátis" /></Field>
            <Field label="Descrição (opcional)"><input className="input" value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field>
            <Field label="Custo em pontos"><input className="input" type="number" min={1} required value={edit.cost} onChange={(e) => setEdit({ ...edit, cost: e.target.value })} /></Field>
            <label className="flex items-center justify-between gap-3 text-sm">Ativa<Toggle checked={edit.active} onChange={(v) => setEdit({ ...edit, active: v })} label="Ativa" /></label>
            <Alert>{err}</Alert>
            <button className="btn-primary w-full">Salvar</button>
          </form>
        )}
      </Modal>
    </div>
  );
}
