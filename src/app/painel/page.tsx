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

// Período atual e o período imediatamente anterior, de mesmo tamanho (hoje x ontem inteiro).
function ranges(days: number) {
  const to = new Date(Date.now() + 60_000);
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  if (days) from.setDate(from.getDate() - (days - 1));
  const prevFrom = new Date(from);
  prevFrom.setDate(prevFrom.getDate() - (days || 1));
  return { from, to, prevFrom, prevTo: from };
}

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function Delta({ cur, prev, invert = false }: { cur: number; prev: number; invert?: boolean }) {
  if (!prev && !cur) return <span className="text-xs text-zinc-400">—</span>;
  if (!prev) return <span className="text-xs font-semibold text-zinc-500">novo</span>;
  const pct = ((cur - prev) / prev) * 100;
  if (Math.abs(pct) < 0.05) return <span className="text-xs font-semibold text-zinc-500">= 0%</span>;
  const up = pct > 0;
  const good = invert ? !up : up;
  return (
    <span className={`text-xs font-semibold ${good ? "text-green-700" : "text-red-600"}`}>
      <span aria-hidden="true">{up ? "↑" : "↓"}</span> {Math.abs(pct).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%
      <span className="sr-only">{up ? " a mais" : " a menos"} que o período anterior</span>
    </span>
  );
}

type Point = { label: string; cur: number; prev: number; future?: boolean };

function LineChart({ points, curLabel, prevLabel }: { points: Point[]; curLabel: string; prevLabel: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640, H = 240, L = 56, R = 12, T = 12, B = 28;
  const max = Math.max(100, ...points.map((p) => Math.max(p.cur, p.prev)));
  const n = points.length;
  const x = (i: number) => L + (n <= 1 ? 0 : (i * (W - L - R)) / (n - 1));
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  const path = (get: (p: Point) => number, upTo: number) =>
    points.slice(0, upTo).map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(get(p)).toFixed(1)}`).join(" ");
  const lastCur = points.findIndex((p) => p.future);
  const curLen = lastCur === -1 ? n : lastCur;
  const step = Math.max(1, Math.ceil(n / 8));
  const totalCur = points.reduce((s, p) => s + p.cur, 0), totalPrev = points.reduce((s, p) => s + p.prev, 0);
  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-4 text-xs text-zinc-600">
        <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-5 rounded bg-brand-600" />{curLabel}</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-0 w-5 border-t-2 border-dashed border-amber-500" />{prevLabel}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img"
        aria-label={`Faturamento: ${curLabel} ${brl(totalCur)}, ${prevLabel} ${brl(totalPrev)}`} onMouseLeave={() => setHover(null)}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={L} x2={W - R} y1={y(max * f)} y2={y(max * f)} stroke="#e4e4e7" strokeWidth="1" />
            <text x={L - 6} y={y(max * f) + 3.5} textAnchor="end" fontSize="10" fill="#71717a">
              {(max * f / 100).toLocaleString("pt-BR", { maximumFractionDigits: 0 })}
            </text>
          </g>
        ))}
        <text x={4} y={T + 4} fontSize="9" fill="#a1a1aa">R$</text>
        {points.map((p, i) => (i % step === 0 || i === n - 1) && (
          <text key={i} x={x(i)} y={H - 8} textAnchor="middle" fontSize="10" fill="#71717a">{p.label}</text>
        ))}
        <path d={path((p) => p.prev, n)} fill="none" stroke="#f59e0b" strokeWidth="2" strokeDasharray="5 4" strokeLinejoin="round" strokeLinecap="round" />
        <path d={path((p) => p.cur, curLen)} fill="none" stroke="#d9262b" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
        {hover != null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} stroke="#a1a1aa" strokeWidth="1" strokeDasharray="2 3" />
            <circle cx={x(hover)} cy={y(points[hover].prev)} r="3.5" fill="#f59e0b" />
            {hover < curLen && <circle cx={x(hover)} cy={y(points[hover].cur)} r="4" fill="#d9262b" />}
          </g>
        )}
        {points.map((_, i) => (
          <rect key={i} x={x(i) - (W - L - R) / Math.max(1, n - 1) / 2} y={T} width={(W - L - R) / Math.max(1, n - 1)} height={H - T - B}
            fill="transparent" onMouseEnter={() => setHover(i)} onTouchStart={() => setHover(i)} />
        ))}
      </svg>
      <p className="mt-1 min-h-5 text-xs text-zinc-600" aria-live="polite">
        {hover != null ? (
          <><b>{points[hover].label}</b> · atual {hover < curLen ? brl(points[hover].cur) : "—"} · anterior {brl(points[hover].prev)}</>
        ) : <>Passe o mouse ou toque no gráfico para ver os valores.</>}
      </p>
    </div>
  );
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
  const [prev, setPrev] = useState<Stats | null>(null);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    const p = PERIODS.find((x) => x.id === period)!;
    const r = ranges(p.days);
    const sb = supabaseBrowser();
    const [cur, before] = await Promise.all([
      sb.rpc("dashboard_stats", { p_unit_id: unit.id, p_from: r.from.toISOString(), p_to: r.to.toISOString() }),
      sb.rpc("dashboard_stats", { p_unit_id: unit.id, p_from: r.prevFrom.toISOString(), p_to: r.prevTo.toISOString() }),
    ]);
    if (cur.error) { setErr(cur.error.message); return; }
    setErr(""); setStats(cur.data as Stats); setPrev(before.error ? null : (before.data as Stats));
  }, [period, unit.id]);

  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, [load]);

  if (!canManage(role)) {
    return <div className="card"><p>Seu perfil não tem acesso ao dashboard. <Link className="text-brand-700 underline" href="/painel/pedidos">Ir para pedidos</Link></p></div>;
  }

  const days = PERIODS.find((x) => x.id === period)!.days;
  const prevName = period === "today" ? "ontem" : `${days} dias anteriores`;
  const kpis: { k: string; v: string; cur?: number; prev?: number; invert?: boolean }[] = stats ? [
    { k: "Faturamento", v: brl(stats.revenue_cents), cur: stats.revenue_cents, prev: prev?.revenue_cents },
    { k: "Pedidos", v: String(stats.orders), cur: stats.orders, prev: prev?.orders },
    { k: "Ticket médio", v: brl(stats.avg_ticket_cents), cur: stats.avg_ticket_cents, prev: prev?.avg_ticket_cents },
    { k: "Novos clientes", v: String(stats.new_customers), cur: stats.new_customers, prev: prev?.new_customers },
    { k: "Cancelados", v: String(stats.cancelled), cur: stats.cancelled, prev: prev?.cancelled, invert: true },
    { k: "Preparo médio", v: stats.avg_prep_min != null ? `${stats.avg_prep_min} min` : "—",
      cur: stats.avg_prep_min ?? undefined, prev: prev?.avg_prep_min ?? undefined, invert: true },
  ] : [];

  // Série do gráfico: horas do dia (hoje x ontem) ou dias (período x período anterior), com zeros onde não houve venda
  let points: Point[] = [];
  if (stats) {
    if (period === "today") {
      const nowH = new Date().getHours();
      const c = new Map(stats.by_hour.map((h) => [h.hour, h.revenue_cents]));
      const pv = new Map((prev?.by_hour ?? []).map((h) => [h.hour, h.revenue_cents]));
      points = Array.from({ length: 24 }, (_, h) => ({ label: `${String(h).padStart(2, "0")}h`, cur: c.get(h) ?? 0, prev: pv.get(h) ?? 0, future: h > nowH }));
    } else {
      const r = ranges(days);
      const c = new Map(stats.by_day.map((d) => [d.day, d.revenue_cents]));
      const pv = new Map((prev?.by_day ?? []).map((d) => [d.day, d.revenue_cents]));
      points = Array.from({ length: days }, (_, i) => {
        const d = new Date(r.from); d.setDate(d.getDate() + i);
        const pd = new Date(r.prevFrom); pd.setDate(pd.getDate() + i);
        return { label: d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }), cur: c.get(ymd(d)) ?? 0, prev: pv.get(ymd(pd)) ?? 0 };
      });
    }
  }

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
        {kpis.map(({ k, v, cur, prev: pv, invert }) => (
          <div key={k} className="card">
            <p className="text-xs font-medium text-zinc-500">{k}</p>
            <p className="mt-1 text-xl font-bold tabular-nums">{v}</p>
            <p className="mt-0.5">{prev && cur != null && pv != null ? <Delta cur={cur} prev={pv} invert={invert} /> : <span className="text-xs text-zinc-400">—</span>}</p>
          </div>
        ))}
      </div>
      {stats && <p className="-mt-3 text-xs text-zinc-500">Variação em relação a {prevName}{period === "today" ? " (dia inteiro)" : ""}.</p>}
      {stats && (
        <section className="card">
          <h2 className="mb-3 font-semibold">Análise de vendas · faturamento por {period === "today" ? "hora" : "dia"}</h2>
          <LineChart points={points} curLabel={period === "today" ? "Hoje" : `Últimos ${days} dias`} prevLabel={period === "today" ? "Ontem" : `${days} dias anteriores`} />
        </section>
      )}
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
