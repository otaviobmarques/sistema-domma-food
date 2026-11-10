"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import { canManage, usePanel } from "@/lib/panel/context";
import { Alert } from "@/components/ui";
import { brl, PAYMENT_LABEL, TYPE_LABEL } from "@/lib/format";

type Stats = {
  revenue_cents: number; orders: number; avg_ticket_cents: number; cancelled: number;
  new_customers: number; avg_prep_min: number | null;
  by_hour: { hour: number; orders: number; revenue_cents: number }[];
  by_day: { day: string; orders: number; revenue_cents: number }[];
  by_payment: { method: string; orders: number; revenue_cents: number }[];
  by_type: { type: string; orders: number }[];
  top_products: { name: string; quantity: number; revenue_cents: number }[];
};

const PERIODS = [
  { id: "today", label: "Hoje", days: 0 },
  { id: "7d", label: "7 dias", days: 7 },
  { id: "30d", label: "30 dias", days: 30 },
] as const;

function range(days: number) {
  const to = new Date(Date.now() + 60_000);
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  if (days) from.setDate(from.getDate() - (days - 1));
  return { from: from.toISOString(), to: to.toISOString() };
}

function Bars({ data, label, value, fmt }: {
  data: Record<string, unknown>[]; label: (d: any) => string; value: (d: any) => number; fmt: (n: number) => string;
}) {
  const max = Math.max(1, ...data.map(value));
  if (!data.length) return <p className="py-6 text-center text-sm text-zinc-500">Sem dados no período.</p>;
  return (
    <ul className="space-y-1.5">
      {data.map((d, i) => (
        <li key={i} className="grid grid-cols-[4.5rem_1fr_5.5rem] items-center gap-2 text-xs">
          <span className="truncate text-zinc-600">{label(d)}</span>
          <span className="h-3 rounded bg-zinc-100">
            <span className="block h-3 rounded bg-brand-600" style={{ width: `${(value(d) / max) * 100}%` }} />
          </span>
          <span className="text-right tabular-nums">{fmt(value(d))}</span>
        </li>
      ))}
    </ul>
  );
}

export default function Dashboard() {
  const { unit, role } = usePanel();
  const [period, setPeriod] = useState<(typeof PERIODS)[number]["id"]>("today");
  const [stats, setStats] = useState<Stats | null>(null);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    const p = PERIODS.find((x) => x.id === period)!;
    const { from, to } = range(p.days);
    const { data, error } = await supabaseBrowser().rpc("dashboard_stats", { p_unit_id: unit.id, p_from: from, p_to: to });
    if (error) setErr(error.message); else { setErr(""); setStats(data as Stats); }
  }, [period, unit.id]);

  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, [load]);

  if (!canManage(role)) {
    return <div className="card"><p>Seu perfil não tem acesso ao dashboard. <Link className="text-brand-700 underline" href="/painel/pedidos">Ir para pedidos</Link></p></div>;
  }

  const kpis = stats ? [
    ["Faturamento", brl(stats.revenue_cents)],
    ["Pedidos", String(stats.orders)],
    ["Ticket médio", brl(stats.avg_ticket_cents)],
    ["Novos clientes", String(stats.new_customers)],
    ["Cancelados", String(stats.cancelled)],
    ["Preparo médio", stats.avg_prep_min != null ? `${stats.avg_prep_min} min` : "—"],
  ] : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="h1">Dashboard</h1>
        <div className="flex rounded-lg border border-zinc-200 bg-white p-1" role="tablist">
          {PERIODS.map((p) => (
            <button key={p.id} role="tab" aria-selected={period === p.id} onClick={() => setPeriod(p.id)}
              className={`rounded-md px-3 py-1.5 text-sm ${period === p.id ? "bg-brand-700 font-semibold text-white" : "text-zinc-600"}`}>
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <Alert>{err}</Alert>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {kpis.map(([k, v]) => (
          <div key={k} className="card">
            <p className="text-xs font-medium text-zinc-500">{k}</p>
            <p className="mt-1 text-xl font-bold tabular-nums">{v}</p>
          </div>
        ))}
      </div>
      {stats && (
        <div className="grid gap-4 lg:grid-cols-2">
          <section className="card">
            <h2 className="mb-3 font-semibold">{period === "today" ? "Pedidos por hora" : "Faturamento por dia"}</h2>
            {period === "today"
              ? <Bars data={stats.by_hour} label={(d) => `${String(d.hour).padStart(2, "0")}h`} value={(d) => d.orders} fmt={(n) => `${n} ped.`} />
              : <Bars data={stats.by_day} label={(d) => new Date(d.day + "T12:00").toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })} value={(d) => d.revenue_cents} fmt={brl} />}
          </section>
          <section className="card">
            <h2 className="mb-3 font-semibold">Mais vendidos</h2>
            <Bars data={stats.top_products} label={(d) => d.name} value={(d) => d.quantity} fmt={(n) => `${n} un.`} />
          </section>
          <section className="card">
            <h2 className="mb-3 font-semibold">Formas de pagamento</h2>
            <Bars data={stats.by_payment} label={(d) => PAYMENT_LABEL[d.method] ?? d.method} value={(d) => d.revenue_cents} fmt={brl} />
          </section>
          <section className="card">
            <h2 className="mb-3 font-semibold">Tipo de pedido</h2>
            <Bars data={stats.by_type} label={(d) => TYPE_LABEL[d.type] ?? d.type} value={(d) => d.orders} fmt={(n) => `${n} ped.`} />
          </section>
        </div>
      )}
    </div>
  );
}
