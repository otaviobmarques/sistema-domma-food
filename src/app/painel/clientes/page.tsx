"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { usePanel } from "@/lib/panel/context";
import { Alert, Empty } from "@/components/ui";
import { brl, formatPhone } from "@/lib/format";

type Customer = {
  id: string; name: string; phone: string; email: string | null; opt_in_marketing: boolean;
  orders_count: number; total_spent_cents: number; first_order_at: string | null; last_order_at: string | null; created_at: string;
};

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
    const head = ["nome", "whatsapp", "email", "pedidos", "total_gasto", "ultimo_pedido", "aceita_marketing"];
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = filtered.map((r) => [r.name, r.phone, r.email, r.orders_count, (r.total_spent_cents / 100).toFixed(2),
      r.last_order_at?.slice(0, 10), r.opt_in_marketing ? "sim" : "nao"].map(esc).join(";"));
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
        <div className="overflow-x-auto rounded-2xl border border-zinc-200/70 bg-white shadow-soft">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50/80 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              <tr><th className="p-3">Cliente</th><th className="p-3">Segmento</th><th className="p-3">Pedidos</th><th className="p-3">Total gasto</th><th className="p-3">Ticket médio</th><th className="p-3">Último pedido</th><th className="p-3">Marketing</th><th /></tr>
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
                    <td className="p-3 text-xs">{c.last_order_at ? new Date(c.last_order_at).toLocaleDateString("pt-BR") : "—"}</td>
                    <td className="p-3 text-xs">{c.opt_in_marketing ? "Aceita" : "Não"}</td>
                    <td className="p-3 text-right">
                      {(role === "owner" || role === "manager") && <button className="btn-ghost text-xs text-red-600" onClick={() => erase(c)}>Excluir dados</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-zinc-500">Só envie campanhas de marketing para clientes que aceitaram (coluna Marketing), conforme a LGPD.</p>
    </div>
  );
}
