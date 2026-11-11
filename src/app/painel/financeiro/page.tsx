"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import { canManage, usePanel } from "@/lib/panel/context";
import { Alert, Empty } from "@/components/ui";
import { brl, errorMessage, PAYMENT_LABEL } from "@/lib/format";
import { Bars, InOutChart, ymd, type Summary } from "./shared";
import { Entries } from "./entries";

type Period = "today" | "7d" | "month" | "lastmonth" | "custom";
const PERIODS: { id: Period; label: string }[] = [
  { id: "today", label: "Hoje" }, { id: "7d", label: "7 dias" }, { id: "month", label: "Este mês" },
  { id: "lastmonth", label: "Mês passado" }, { id: "custom", label: "Personalizado" },
];
const METHOD = (m: string) => (m === "credit_account" ? "Fiado" : PAYMENT_LABEL[m] ?? m);

function range(p: Period): [string, string] {
  const now = new Date();
  if (p === "today") return [ymd(now), ymd(now)];
  if (p === "7d") { const a = new Date(now); a.setDate(a.getDate() - 6); return [ymd(a), ymd(now)]; }
  if (p === "lastmonth") return [ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1)), ymd(new Date(now.getFullYear(), now.getMonth(), 0))];
  return [ymd(new Date(now.getFullYear(), now.getMonth(), 1)), ymd(now)];
}

function Kpi({ label, value, tone, children }: { label: string; value: string; tone?: "good" | "bad"; children?: React.ReactNode }) {
  return (
    <div className="card">
      <p className="text-sm text-zinc-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${tone === "good" ? "text-green-700" : tone === "bad" ? "text-red-700" : "text-zinc-900"}`}>{value}</p>
      {children && <div className="mt-1 text-xs text-zinc-500">{children}</div>}
    </div>
  );
}

function Line({ label, value, sign, strong, muted }: { label: string; value: number; sign?: "+" | "−"; strong?: boolean; muted?: boolean }) {
  return (
    <div className={`flex justify-between py-1.5 ${strong ? "border-t border-zinc-200 pt-2.5 text-base font-semibold" : ""} ${muted ? "text-zinc-500" : ""}`}>
      <dt>{sign && <span className="mr-1.5 inline-block w-3 text-zinc-400">{sign}</span>}{label}</dt>
      <dd className={`tabular-nums ${strong ? (value >= 0 ? "text-green-700" : "text-red-700") : ""}`}>{brl(value)}</dd>
    </div>
  );
}

export default function Financeiro() {
  const { tenantId, unit, units, role } = usePanel();
  const [period, setPeriod] = useState<Period>("month");
  const [custom, setCustom] = useState<[string, string]>(range("month"));
  const [allUnits, setAllUnits] = useState(false);
  const [s, setS] = useState<Summary | null>(null);
  const [err, setErr] = useState("");
  const [from, to] = period === "custom" ? custom : range(period);

  const load = useCallback(async () => {
    if (!canManage(role)) return;
    if (!from || !to || to < from) { setErr("Confira as datas do período."); return; }
    const { data, error } = await supabaseBrowser().rpc("fin_summary", {
      p_tenant_id: tenantId, p_unit_id: allUnits ? null : unit.id, p_from: from, p_to: to,
    });
    if (error) { setErr(errorMessage(error)); return; }
    setErr(""); setS(data as Summary);
  }, [role, tenantId, unit.id, allUnits, from, to]);
  useEffect(() => { load(); }, [load]);

  if (!canManage(role)) return <Empty>O financeiro é restrito ao dono e aos gerentes.</Empty>;

  const gross = s ? s.sales_cents - s.cmv_cents : 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="h1">Financeiro</h1>
          <p className="text-sm text-zinc-500">Resultado do período, contas a pagar e a receber.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {units.length > 1 && (
            <div className="flex rounded-lg bg-zinc-100 p-0.5 text-sm font-medium" role="radiogroup" aria-label="Lojas">
              {([[false, "Esta loja"], [true, "Todas as lojas"]] as const).map(([v, l]) => (
                <button key={l} role="radio" aria-checked={allUnits === v} onClick={() => setAllUnits(v)}
                  className={`rounded-md px-3 py-1.5 ${allUnits === v ? "bg-white shadow-sm" : "text-zinc-500"}`}>{l}</button>
              ))}
            </div>
          )}
          <div className="flex flex-wrap rounded-lg bg-zinc-100 p-0.5 text-sm font-medium" role="radiogroup" aria-label="Período">
            {PERIODS.map((p) => (
              <button key={p.id} role="radio" aria-checked={period === p.id}
                onClick={() => { if (p.id === "custom") setCustom([from, to]); setPeriod(p.id); }}
                className={`rounded-md px-3 py-1.5 ${period === p.id ? "bg-white shadow-sm" : "text-zinc-500"}`}>{p.label}</button>
            ))}
          </div>
          {period === "custom" && (
            <div className="flex items-center gap-1.5 text-sm">
              <input type="date" className="input w-auto" value={custom[0]} onChange={(e) => setCustom([e.target.value, custom[1]])} aria-label="De" />
              <span className="text-zinc-500">até</span>
              <input type="date" className="input w-auto" value={custom[1]} onChange={(e) => setCustom([custom[0], e.target.value])} aria-label="Até" />
            </div>
          )}
        </div>
      </div>

      <Alert>{err}</Alert>

      {s && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Kpi label="Resultado do período" value={brl(s.result_cents)} tone={s.result_cents >= 0 ? "good" : "bad"}>
              {s.orders} pedido(s) · vendas {brl(s.sales_cents)}
            </Kpi>
            <Kpi label="Contas a pagar em aberto" value={brl(s.payable_open_cents)}>
              {s.payable_overdue_cents > 0 && <span className="font-semibold text-red-700">{brl(s.payable_overdue_cents)} vencidas · </span>}
              {brl(s.payable_week_cents)} nos próximos 7 dias
            </Kpi>
            <Kpi label="A receber em aberto" value={brl(s.receivable_open_cents)}>Lançamentos manuais a receber</Kpi>
            <Kpi label="Fiado em aberto" value={brl(s.credit_open_cents)}>
              <Link href="/painel/fiado" className="font-medium text-brand-700 hover:underline">Ver clientes com fiado →</Link>
            </Kpi>
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,380px)_1fr]">
            <section className="card" aria-label="Resultado">
              <h2 className="font-semibold">Resultado (DRE simplificada)</h2>
              <dl className="mt-3 text-sm">
                <Line label="Vendas" value={s.sales_cents} />
                <Line label="Taxa de serviço (mesas)" value={s.service_fee_cents} sign="+" />
                <Line label="Descontos de mesa" value={-s.tab_discount_cents} sign="−" />
                <Line label="Outras receitas recebidas" value={s.other_income_cents} sign="+" />
                <Line label="Despesas pagas" value={-s.expenses_cents} sign="−" />
                <Line label="Resultado" value={s.result_cents} strong />
              </dl>
              <dl className="mt-4 rounded-lg bg-zinc-50 p-3 text-sm">
                <Line label="CMV estimado" value={s.cmv_cents} muted />
                <Line label="Margem bruta (vendas − CMV)" value={gross} />
                <p className="mt-1 text-xs text-zinc-500">
                  CMV vem da ficha técnica do <Link href="/painel/estoque" className="underline">Estoque</Link>.
                  {s.sales_cents > 0 && ` Margem de ${Math.round((gross / s.sales_cents) * 100)}%.`}
                  {" "}Vendas já incluem taxas de entrega ({brl(s.delivery_fee_cents)}) e estão líquidas de cupons ({brl(s.discount_cents)}).
                </p>
              </dl>
            </section>
            <section className="card" aria-label="Entradas e saídas">
              <h2 className="mb-3 font-semibold">Entradas x saídas por dia</h2>
              <InOutChart data={s.by_day} />
            </section>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="card" aria-label="Despesas por categoria">
              <h2 className="mb-3 font-semibold">Despesas por categoria</h2>
              <Bars data={s.expenses_by_category} label={(d) => d.category} value={(d) => d.amount_cents} fmt={brl} color="bg-red-500" />
            </section>
            <section className="card" aria-label="Recebimentos por forma">
              <h2 className="mb-3 font-semibold">Recebimentos por forma de pagamento</h2>
              <Bars data={s.by_method} label={(d) => METHOD(d.method)} value={(d) => d.amount_cents} fmt={brl} />
            </section>
          </div>

          <Entries allUnits={allUnits} today={s.today} onChanged={load} />
        </>
      )}
    </div>
  );
}
