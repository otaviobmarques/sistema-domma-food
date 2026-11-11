"use client";
import { brl } from "@/lib/format";

export type FinEntry = {
  id: string; tenant_id: string; unit_id: string | null; kind: "payable" | "receivable";
  description: string; category: string; party: string | null; amount_cents: number;
  due_date: string; paid_at: string | null; paid_method: string | null; notes: string | null; created_at: string;
};

export type Summary = {
  sales_cents: number; orders: number; service_fee_cents: number; tab_discount_cents: number;
  delivery_fee_cents: number; discount_cents: number; other_income_cents: number; expenses_cents: number;
  cmv_cents: number; result_cents: number;
  expenses_by_category: { category: string; amount_cents: number }[];
  by_method: { method: string; amount_cents: number }[];
  by_day: { day: string; in_cents: number; out_cents: number }[];
  payable_open_cents: number; payable_overdue_cents: number; payable_week_cents: number;
  receivable_open_cents: number; credit_open_cents: number; today: string;
};

export const PAID_METHOD: Record<string, string> = {
  cash: "Dinheiro", pix: "Pix", card: "Cartão", transfer: "Transferência", boleto: "Boleto", other: "Outro",
};

export const PAYABLE_CATEGORIES = ["Aluguel", "Energia", "Água", "Internet", "Salários", "Fornecedores", "Compras de insumos",
  "Impostos", "Marketing", "Manutenção", "Taxas de marketplace", "Outros"];
export const RECEIVABLE_CATEGORIES = ["Eventos", "Vendas a prazo", "Outros"];

export const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const fmtDate = (s: string) => new Date(s.length === 10 ? s + "T12:00" : s).toLocaleDateString("pt-BR");

/** Soma meses a uma data AAAA-MM-DD mantendo o dia (ou o último dia do mês). */
export function addMonths(date: string, n: number) {
  const [y, m, d] = date.split("-").map(Number);
  const last = new Date(y, m - 1 + n + 1, 0).getDate();
  return ymd(new Date(y, m - 1 + n, Math.min(d, last)));
}

export function Bars<T>({ data, label, value, fmt, color = "bg-brand-600" }: {
  data: T[]; label: (d: T) => string; value: (d: T) => number; fmt: (n: number) => string; color?: string;
}) {
  if (!data.length) return <p className="py-6 text-center text-sm text-zinc-500">Sem dados no período.</p>;
  const max = Math.max(...data.map(value), 1);
  return (
    <ul className="space-y-2">
      {data.map((d, i) => (
        <li key={i} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3 text-sm">
          <span className="truncate text-zinc-600">{label(d)}</span>
          <span className="h-3 rounded bg-zinc-100"><span className={`block h-3 rounded ${color}`} style={{ width: `${(value(d) / max) * 100}%` }} /></span>
          <span className="tabular-nums font-medium">{fmt(value(d))}</span>
        </li>
      ))}
    </ul>
  );
}

/** Colunas lado a lado: entradas (verde) e saídas (vermelho) por dia. */
export function InOutChart({ data }: { data: Summary["by_day"] }) {
  if (!data.length) return <p className="py-6 text-center text-sm text-zinc-500">Sem movimento no período.</p>;
  const max = Math.max(...data.flatMap((d) => [d.in_cents, d.out_cents]), 1);
  const W = Math.max(data.length * 28, 280), H = 160;
  const bw = Math.min(10, (W / data.length - 6) / 2);
  return (
    <div>
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H + 18}`} className="h-48 min-w-full" style={{ width: W }} role="img" aria-label="Entradas e saídas por dia">
          <line x1="0" x2={W} y1={H} y2={H} stroke="#e4e4e7" />
          {data.map((d, i) => {
            const x = i * (W / data.length) + (W / data.length) / 2;
            const hi = (d.in_cents / max) * (H - 8), ho = (d.out_cents / max) * (H - 8);
            return (
              <g key={d.day}>
                <rect x={x - bw - 1} y={H - hi} width={bw} height={hi} rx="2" fill="#16a34a"><title>{`${fmtDate(d.day)} · entradas ${brl(d.in_cents)}`}</title></rect>
                <rect x={x + 1} y={H - ho} width={bw} height={ho} rx="2" fill="#dc2626"><title>{`${fmtDate(d.day)} · saídas ${brl(d.out_cents)}`}</title></rect>
                {(data.length <= 14 || i % Math.ceil(data.length / 14) === 0) && (
                  <text x={x} y={H + 13} textAnchor="middle" fontSize="9" fill="#71717a">{d.day.slice(8, 10)}/{d.day.slice(5, 7)}</text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="mt-2 flex gap-4 text-xs text-zinc-600">
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-green-600" /> Entradas</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-red-600" /> Saídas</span>
      </div>
    </div>
  );
}
