"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { usePanel } from "@/lib/panel/context";
import { Alert, Empty, Field, Modal } from "@/components/ui";
import { brl, errorMessage, formatPhone, parseBRL } from "@/lib/format";

type Customer = {
  id: string; name: string; phone: string; email: string | null; opt_in_marketing: boolean;
  orders_count: number; total_spent_cents: number; first_order_at: string | null; last_order_at: string | null; created_at: string;
  cashback_cents: number; points_balance: number;
};
type Ledger = { id: number; kind: "cashback" | "points"; amount: number; reason: string; note: string | null; expires_at: string | null; created_at: string };
type Reward = { id: string; name: string; description: string | null; points_cost: number };

const REASON: Record<string, string> = { earn: "Ganhou", redeem: "Usou", refund: "Devolvido", expire: "Expirou", manual: "Ajuste", reward: "Recompensa" };

function LoyaltyModal({ customer, canAdjust, onClose, onChanged }: { customer: Customer; canAdjust: boolean; onClose: () => void; onChanged: () => void }) {
  const sb = supabaseBrowser();
  const { tenantId } = usePanel();
  const [c, setC] = useState(customer);
  const [ledger, setLedger] = useState<Ledger[]>([]);
  const [rewards, setRewards] = useState<Reward[]>([]);
  const [kind, setKind] = useState<"cashback" | "points">("cashback");
  const [dir, setDir] = useState<"credit" | "debit">("credit");
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [l, r, cu] = await Promise.all([
      sb.from("loyalty_ledger").select("id, kind, amount, reason, note, expires_at, created_at").eq("customer_id", customer.id).order("created_at", { ascending: false }).limit(30),
      sb.from("rewards").select("id, name, description, points_cost").eq("tenant_id", tenantId).eq("active", true).order("points_cost"),
      sb.from("customers").select("*").eq("id", customer.id).single(),
    ]);
    if (l.error) setErr(l.error.message); else setLedger((l.data ?? []) as Ledger[]);
    setRewards((r.data ?? []) as Reward[]);
    if (cu.data) setC(cu.data as Customer);
  }, [sb, customer.id, tenantId]);
  useEffect(() => { load(); }, [load]);

  async function adjust(e: React.FormEvent) {
    e.preventDefault();
    setErr(""); setMsg("");
    const n = kind === "cashback" ? parseBRL(value) : Math.round(Number(value.replace(",", ".")) || 0);
    if (n <= 0) { setErr("Informe um valor maior que zero."); return; }
    if (!note.trim()) { setErr("Informe o motivo do ajuste."); return; }
    setBusy(true);
    const { error } = await sb.rpc("loyalty_adjust", { p_customer_id: customer.id, p_kind: kind, p_amount: dir === "credit" ? n : -n, p_note: note.trim() });
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return; }
    setValue(""); setNote(""); setMsg("Ajuste registrado."); await load(); onChanged();
  }

  async function redeem(r: Reward) {
    if (!confirm(`Resgatar "${r.name}" por ${r.points_cost} pontos?`)) return;
    setErr(""); setMsg(""); setBusy(true);
    const { error } = await sb.rpc("redeem_reward", { p_customer_id: customer.id, p_reward_id: r.id });
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return; }
    setMsg(`Recompensa "${r.name}" resgatada. Entregue ao cliente.`); await load(); onChanged();
  }

  const fmt = (l: Ledger) => l.kind === "cashback" ? brl(Math.abs(l.amount)) : `${Math.abs(l.amount)} pts`;

  return (
    <Modal open onClose={onClose} title={`Fidelidade · ${customer.name}`} wide>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-xl bg-green-50 p-3"><p className="text-xs font-medium text-green-800">Cashback</p><p className="text-xl font-bold tabular-nums text-green-900">{brl(c.cashback_cents)}</p></div>
          <div className="rounded-xl bg-brand-50 p-3"><p className="text-xs font-medium text-brand-800">Pontos</p><p className="text-xl font-bold tabular-nums text-brand-900">{c.points_balance}</p></div>
        </div>
        <Alert>{err}</Alert>
        <Alert kind="success">{msg}</Alert>

        {rewards.length > 0 && (
          <section>
            <h3 className="mb-2 text-sm font-semibold">Resgatar recompensa</h3>
            <ul className="divide-y divide-zinc-100 rounded-xl border border-zinc-200">
              {rewards.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 p-3 text-sm">
                  <span><b>{r.name}</b>{r.description && <span className="block text-xs text-zinc-500">{r.description}</span>}</span>
                  <button className="btn-secondary shrink-0 text-xs" disabled={busy || c.points_balance < r.points_cost} onClick={() => redeem(r)}>
                    {c.points_balance >= r.points_cost ? `Resgatar · ${r.points_cost} pts` : `Faltam ${r.points_cost - c.points_balance} pts`}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {canAdjust && (
          <form onSubmit={adjust} className="space-y-3 rounded-xl border border-zinc-200 p-3">
            <h3 className="text-sm font-semibold">Ajuste manual</h3>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Tipo">
                <select className="input" value={kind} onChange={(e) => setKind(e.target.value as "cashback" | "points")}>
                  <option value="cashback">Cashback (R$)</option><option value="points">Pontos</option>
                </select>
              </Field>
              <Field label="Operação">
                <select className="input" value={dir} onChange={(e) => setDir(e.target.value as "credit" | "debit")}>
                  <option value="credit">Crédito (+)</option><option value="debit">Débito (−)</option>
                </select>
              </Field>
              <Field label={kind === "cashback" ? "Valor (R$)" : "Pontos"}>
                <input className="input" inputMode="decimal" required value={value} onChange={(e) => setValue(e.target.value)} />
              </Field>
            </div>
            <Field label="Motivo"><input className="input" required maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ex.: cortesia por atraso" /></Field>
            <button className="btn-primary" disabled={busy}>{busy ? "Salvando..." : "Registrar ajuste"}</button>
          </form>
        )}

        <section>
          <h3 className="mb-2 text-sm font-semibold">Extrato</h3>
          {ledger.length === 0 ? <p className="text-sm text-zinc-500">Nenhuma movimentação ainda.</p> : (
            <ul className="divide-y divide-zinc-100 text-sm">
              {ledger.map((l) => (
                <li key={l.id} className="flex items-center justify-between gap-3 py-2">
                  <span>
                    <b>{REASON[l.reason] ?? l.reason}</b> <span className="text-zinc-500">· {l.kind === "cashback" ? "cashback" : "pontos"}</span>
                    {l.note && <span className="text-zinc-500"> · {l.note}</span>}
                    <span className="block text-xs text-zinc-500">
                      {new Date(l.created_at).toLocaleString("pt-BR")}
                      {l.amount > 0 && l.expires_at && ` · vale até ${new Date(l.expires_at).toLocaleDateString("pt-BR")}`}
                    </span>
                  </span>
                  <span className={`shrink-0 font-semibold tabular-nums ${l.amount > 0 ? "text-green-700" : "text-red-700"}`}>{l.amount > 0 ? "+" : "−"}{fmt(l)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Modal>
  );
}

const SORTS = {
  recent: { label: "Último pedido", col: "last_order_at" },
  orders: { label: "Mais pedidos", col: "orders_count" },
  spent: { label: "Maior gasto", col: "total_spent_cents" },
  new: { label: "Mais novos", col: "created_at" },
} as const;

function segment(c: Customer) {
  const days = c.last_order_at ? (Date.now() - new Date(c.last_order_at).getTime()) / 86400000 : Infinity;
  if (c.orders_count === 0) return { label: "Sem pedido concluído", cls: "bg-zinc-100 text-zinc-600" };
  if (days > 60) return { label: "Inativo", cls: "bg-zinc-200 text-zinc-700" };
  if (days > 30) return { label: "Em risco", cls: "bg-amber-100 text-amber-800" };
  if (c.orders_count >= 5) return { label: "Fiel", cls: "bg-green-100 text-green-800" };
  if (c.orders_count === 1) return { label: "Novo", cls: "bg-brand-100 text-brand-800" };
  return { label: "Recorrente", cls: "bg-sky-50 text-sky-800" };
}

export default function Clientes() {
  const { tenantId, role } = usePanel();
  const sb = supabaseBrowser();
  const [rows, setRows] = useState<Customer[]>([]);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<keyof typeof SORTS>("recent");
  const [err, setErr] = useState("");
  const [loyalty, setLoyalty] = useState<Customer | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await sb.from("customers").select("*").eq("tenant_id", tenantId)
      .order(SORTS[sort].col, { ascending: false, nullsFirst: false }).limit(1000);
    if (error) setErr(error.message); else setRows(data as Customer[]);
  }, [sb, tenantId, sort]);
  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    const d = t.replace(/\D/g, "");
    return t ? rows.filter((r) => r.name.toLowerCase().includes(t) || (d && r.phone.includes(d))) : rows;
  }, [rows, q]);

  function exportCsv() {
    const head = ["nome", "whatsapp", "email", "pedidos", "total_gasto", "ultimo_pedido", "aceita_marketing", "cashback", "pontos"];
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = filtered.map((r) => [r.name, r.phone, r.email, r.orders_count, (r.total_spent_cents / 100).toFixed(2),
      r.last_order_at?.slice(0, 10), r.opt_in_marketing ? "sim" : "nao", ((r.cashback_cents ?? 0) / 100).toFixed(2), r.points_balance ?? 0].map(esc).join(";"));
    const blob = new Blob(["﻿" + [head.join(";"), ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `clientes-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function erase(c: Customer) {
    if (!confirm(`Excluir os dados pessoais de ${c.name} (pedido de exclusão LGPD)? Os valores dos pedidos ficam para fins fiscais, sem nome, telefone ou endereço. Esta ação não pode ser desfeita.`)) return;
    const { error } = await sb.rpc("anonymize_customer", { p_customer_id: c.id });
    if (error) setErr(error.message); else load();
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="h1">Clientes <span className="text-base font-normal text-zinc-500">({rows.length})</span></h1>
        <button className="btn-secondary" onClick={exportCsv} disabled={!filtered.length}>Exportar CSV</button>
      </div>
      <div className="flex flex-wrap gap-2">
        <input className="input max-w-xs" placeholder="Buscar por nome ou telefone" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar clientes" />
        <select className="input w-auto" value={sort} onChange={(e) => setSort(e.target.value as keyof typeof SORTS)} aria-label="Ordenar">
          {Object.entries(SORTS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
      </div>
      <Alert>{err}</Alert>
      {filtered.length === 0 ? <Empty>Os clientes aparecem aqui automaticamente a cada pedido.</Empty> : (
        <div className="overflow-x-auto rounded-lg border border-zinc-200/70 bg-white shadow-soft">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50/80 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              <tr><th className="p-3">Cliente</th><th className="p-3">Segmento</th><th className="p-3">Pedidos</th><th className="p-3">Total gasto</th><th className="p-3">Ticket médio</th><th className="p-3">Cashback</th><th className="p-3">Pontos</th><th className="p-3">Último pedido</th><th className="p-3">Marketing</th><th /></tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {filtered.map((c) => {
                const s = segment(c);
                return (
                  <tr key={c.id}>
                    <td className="p-3">
                      <p className="font-medium">{c.name}</p>
                      <a className="text-xs text-brand-700 hover:underline" href={`https://wa.me/55${c.phone}`} target="_blank" rel="noopener noreferrer">{formatPhone(c.phone)}</a>
                    </td>
                    <td className="p-3"><span className={`badge ${s.cls}`}>{s.label}</span></td>
                    <td className="p-3 tabular-nums">{c.orders_count}</td>
                    <td className="p-3 tabular-nums">{brl(c.total_spent_cents)}</td>
                    <td className="p-3 tabular-nums">{c.orders_count ? brl(Math.round(c.total_spent_cents / c.orders_count)) : "—"}</td>
                    <td className="p-3 tabular-nums">{c.cashback_cents ? brl(c.cashback_cents) : "—"}</td>
                    <td className="p-3 tabular-nums">{c.points_balance || "—"}</td>
                    <td className="p-3 text-xs">{c.last_order_at ? new Date(c.last_order_at).toLocaleDateString("pt-BR") : "—"}</td>
                    <td className="p-3 text-xs">{c.opt_in_marketing ? "Aceita" : "Não"}</td>
                    <td className="whitespace-nowrap p-3 text-right">
                      <button className="btn-ghost text-xs" onClick={() => setLoyalty(c)}>Fidelidade</button>
                      {(role === "owner" || role === "manager") && <button className="btn-ghost text-xs text-red-600" onClick={() => erase(c)}>Excluir dados</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {loyalty && <LoyaltyModal customer={loyalty} canAdjust={role === "owner" || role === "manager"} onClose={() => setLoyalty(null)} onChanged={load} />}
      <p className="text-xs text-zinc-500">Só envie campanhas de marketing para clientes que aceitaram (coluna Marketing), conforme a LGPD.</p>
    </div>
  );
}
