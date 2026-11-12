"use client";
import { useState } from "react";
import { channelLabel } from "@/components/channel-badge";
import { PAYMENT_LABEL, parseBRL } from "@/lib/format";

export type Options = {
  tags: string[]; neighborhoods: string[]; products: { id: string; name: string }[]; units: { id: string; name: string }[];
  segments: { id: string; name: string; filter: Filter }[];
};
/** Filtro no formato do servidor (crm_match). Valores em centavos e dias. */
export type Filter = Partial<{
  q: string; segments: string[]; orders_min: number; orders_max: number; spent_min: number; spent_max: number;
  ticket_min: number; ticket_max: number; inactive_days: number; active_days: number; first_days: number;
  birthday: string; marketing: string; tags: string[]; channels: string[]; products: string[]; neighborhoods: string[];
  payments: string[]; unit_id: string; cashback_min: number; has_credit: boolean; period_days: number;
}>;

export const SEGMENTS: [string, string, string][] = [
  ["new", "Novo", "bg-brand-100 text-brand-800"], ["recurring", "Recorrente", "bg-sky-50 text-sky-800"],
  ["loyal", "Fiel", "bg-green-100 text-green-800"], ["at_risk", "Em risco", "bg-amber-100 text-amber-800"],
  ["inactive", "Inativo", "bg-zinc-200 text-zinc-700"], ["no_orders", "Sem pedido concluído", "bg-zinc-100 text-zinc-600"],
];
const CHANNELS = ["web", "whatsapp", "counter", "table", "totem", "phone", "ifood", "99food", "keeta", "aiqfome", "marketplace"];
const PAYMENTS = ["pix", "cash", "credit_card", "debit_card", "card_on_delivery", "online_card", "voucher", "credit_account"];
const BIRTHDAY: [string, string][] = [["", "Qualquer"], ["today", "Hoje"], ["week", "Próximos 7 dias"], ["month", "Este mês"], ["next_month", "Próximo mês"], ["any", "Informado"]];
const MARKETING: [string, string][] = [["", "Todos"], ["opt_in", "Autorizou marketing"], ["not", "Não autorizou"], ["opt_out", "Descadastrado"]];

/** Quantos critérios estão ativos (para o selo do botão). */
export function activeCount(f: Filter) {
  return Object.entries(f).filter(([k, v]) => k !== "q" && v !== undefined && v !== "" && v !== false && !(Array.isArray(v) && !v.length)).length;
}
/** Resumo legível do filtro (chips). */
export function describe(f: Filter, o: Options | null): string[] {
  const out: string[] = [];
  const money = (c: number) => (c / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const range = (a?: number, b?: number, fmt: (n: number) => string = String) =>
    a != null && b != null ? `${fmt(a)} a ${fmt(b)}` : a != null ? `${fmt(a)} ou mais` : b != null ? `até ${fmt(b)}` : "";
  if (f.segments?.length) out.push(f.segments.map((s) => SEGMENTS.find((x) => x[0] === s)?.[1] ?? s).join(" ou "));
  if (f.orders_min != null || f.orders_max != null) out.push(`Pedidos: ${range(f.orders_min, f.orders_max)}`);
  if (f.spent_min != null || f.spent_max != null) out.push(`Gasto: ${range(f.spent_min, f.spent_max, money)}`);
  if (f.ticket_min != null || f.ticket_max != null) out.push(`Ticket: ${range(f.ticket_min, f.ticket_max, money)}`);
  if (f.inactive_days != null) out.push(`Sem pedir há ${f.inactive_days}+ dias`);
  if (f.active_days != null) out.push(`Pediu nos últimos ${f.active_days} dias`);
  if (f.first_days != null) out.push(`Cliente há até ${f.first_days} dias`);
  if (f.birthday) out.push(`Aniversário: ${BIRTHDAY.find((x) => x[0] === f.birthday)?.[1]}`);
  if (f.marketing) out.push(MARKETING.find((x) => x[0] === f.marketing)?.[1] ?? "");
  if (f.tags?.length) out.push(`Etiqueta: ${f.tags.join(" ou ")}`);
  if (f.channels?.length) out.push(`Canal: ${f.channels.map(channelLabel).join(" ou ")}`);
  if (f.payments?.length) out.push(`Pagou com: ${f.payments.map((p) => PAYMENT_LABEL[p] ?? p).join(" ou ")}`);
  if (f.neighborhoods?.length) out.push(`Bairro: ${f.neighborhoods.join(" ou ")}`);
  if (f.products?.length) out.push(`Comprou: ${f.products.map((id) => o?.products.find((p) => p.id === id)?.name ?? "produto").join(" ou ")}`);
  if (f.unit_id) out.push(`Loja: ${o?.units.find((u) => u.id === f.unit_id)?.name ?? "—"}`);
  if (f.period_days != null) out.push(`Pedidos dos últimos ${f.period_days} dias`);
  if (f.cashback_min != null) out.push(`Cashback a partir de ${money(f.cashback_min)}`);
  if (f.has_credit) out.push("Com fiado em aberto");
  return out.filter(Boolean);
}

function Chips({ all, value, label, onChange }: { all: string[]; value: string[] | undefined; label: (v: string) => string; onChange: (v: string[]) => void }) {
  const sel = value ?? [];
  return (
    <div className="flex flex-wrap gap-1.5">
      {all.map((v) => {
        const on = sel.includes(v);
        return (
          <button key={v} type="button" aria-pressed={on} onClick={() => onChange(on ? sel.filter((x) => x !== v) : [...sel, v])}
            className={`rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${on ? "bg-brand-600 text-white ring-brand-600" : "bg-white text-zinc-700 ring-zinc-200 hover:bg-zinc-50"}`}>{label(v)}</button>
        );
      })}
    </div>
  );
}
function Num({ label, value, onChange, money, placeholder }: { label: string; value: number | undefined; onChange: (v: number | undefined) => void; money?: boolean; placeholder?: string }) {
  const [txt, setTxt] = useState(value == null ? "" : money ? (value / 100).toFixed(2).replace(".", ",") : String(value));
  return (
    <label className="block text-xs text-zinc-600">{label}
      <input className="input mt-1" inputMode={money ? "decimal" : "numeric"} placeholder={placeholder} value={txt}
        onChange={(e) => {
          const t = e.target.value; setTxt(t);
          if (!t.trim()) { onChange(undefined); return; }
          const n = money ? parseBRL(t) : parseInt(t.replace(/\D/g, ""), 10);
          onChange(Number.isFinite(n) && n >= 0 ? n : undefined);
        }} />
    </label>
  );
}
function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return <fieldset className="space-y-2"><legend className="text-xs font-semibold uppercase tracking-wide text-zinc-400">{title}</legend>{children}</fieldset>;
}

export function FilterPanel({ f, set, options }: { f: Filter; set: (p: Filter) => void; options: Options | null }) {
  const [hood, setHood] = useState("");
  const addHood = () => {
    const h = hood.trim();
    if (h && !(f.neighborhoods ?? []).some((x) => x.toLowerCase() === h.toLowerCase())) set({ neighborhoods: [...(f.neighborhoods ?? []), h] });
    setHood("");
  };
  return (
    <div className="grid gap-5 rounded-xl bg-white p-4 ring-1 ring-zinc-200 md:grid-cols-2 xl:grid-cols-3">
      <Group title="Relacionamento">
        <Chips all={SEGMENTS.map((s) => s[0])} value={f.segments} label={(v) => SEGMENTS.find((s) => s[0] === v)?.[1] ?? v} onChange={(v) => set({ segments: v })} />
        <p className="text-[11px] text-zinc-500">Novo: 1 pedido · Recorrente: 2 a 4 · Fiel: 5+ · Em risco: 31 a 60 dias sem pedir · Inativo: 60+ dias.</p>
        <label className="block text-xs text-zinc-600">Marketing
          <select className="input mt-1" value={f.marketing ?? ""} onChange={(e) => set({ marketing: e.target.value || undefined })}>
            {MARKETING.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        {!!options?.tags.length && (
          <div><p className="mb-1 text-xs text-zinc-600">Etiquetas (qualquer uma)</p>
            <Chips all={options.tags} value={f.tags} label={(v) => v} onChange={(v) => set({ tags: v })} /></div>
        )}
      </Group>

      <Group title="Frequência e valor">
        <div className="grid grid-cols-2 gap-2">
          <Num label="Pedidos (mín.)" value={f.orders_min} onChange={(v) => set({ orders_min: v })} />
          <Num label="Pedidos (máx.)" value={f.orders_max} onChange={(v) => set({ orders_max: v })} />
          <Num label="Gasto total a partir de" money value={f.spent_min} onChange={(v) => set({ spent_min: v })} placeholder="R$" />
          <Num label="Gasto total até" money value={f.spent_max} onChange={(v) => set({ spent_max: v })} placeholder="R$" />
          <Num label="Ticket médio a partir de" money value={f.ticket_min} onChange={(v) => set({ ticket_min: v })} placeholder="R$" />
          <Num label="Ticket médio até" money value={f.ticket_max} onChange={(v) => set({ ticket_max: v })} placeholder="R$" />
          <Num label="Cashback a partir de" money value={f.cashback_min} onChange={(v) => set({ cashback_min: v })} placeholder="R$" />
          <label className="mt-5 flex items-center gap-2 text-xs text-zinc-700">
            <input type="checkbox" checked={!!f.has_credit} onChange={(e) => set({ has_credit: e.target.checked || undefined })} /> Com fiado em aberto
          </label>
        </div>
      </Group>

      <Group title="Datas">
        <div className="grid grid-cols-2 gap-2">
          <Num label="Sem pedir há (dias)" value={f.inactive_days} onChange={(v) => set({ inactive_days: v })} placeholder="Ex.: 30" />
          <Num label="Pediu nos últimos (dias)" value={f.active_days} onChange={(v) => set({ active_days: v })} placeholder="Ex.: 7" />
          <Num label="1º pedido nos últimos (dias)" value={f.first_days} onChange={(v) => set({ first_days: v })} placeholder="Ex.: 30" />
          <label className="block text-xs text-zinc-600">Aniversário
            <select className="input mt-1" value={f.birthday ?? ""} onChange={(e) => set({ birthday: e.target.value || undefined })}>
              {BIRTHDAY.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
        </div>
      </Group>

      <Group title="O que e como compra">
        <div><p className="mb-1 text-xs text-zinc-600">Canal do pedido</p>
          <Chips all={CHANNELS} value={f.channels} label={channelLabel} onChange={(v) => set({ channels: v })} /></div>
        <div><p className="mb-1 text-xs text-zinc-600">Forma de pagamento</p>
          <Chips all={PAYMENTS} value={f.payments} label={(v) => PAYMENT_LABEL[v] ?? v} onChange={(v) => set({ payments: v })} /></div>
      </Group>

      <Group title="Produto e local">
        <label className="block text-xs text-zinc-600">Comprou o produto
          <select className="input mt-1" value="" onChange={(e) => { const v = e.target.value; if (v && !(f.products ?? []).includes(v)) set({ products: [...(f.products ?? []), v] }); }}>
            <option value="">Adicionar produto...</option>
            {options?.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        {!!f.products?.length && (
          <div className="flex flex-wrap gap-1.5">{f.products.map((id) => (
            <button key={id} type="button" className="rounded-full bg-brand-600 px-2.5 py-1 text-xs font-medium text-white" onClick={() => set({ products: f.products!.filter((x) => x !== id) })}>
              {options?.products.find((p) => p.id === id)?.name ?? "Produto"} ✕</button>))}</div>
        )}
        <div className="flex gap-2">
          <label className="block flex-1 text-xs text-zinc-600">Bairro de entrega
            <input className="input mt-1" list="crm-hoods" value={hood} onChange={(e) => setHood(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addHood(); } }} placeholder="Digite e tecle Enter" />
          </label>
          <button type="button" className="btn-ghost mt-5 px-2 text-xs" onClick={addHood}>Adicionar</button>
          <datalist id="crm-hoods">{options?.neighborhoods.map((h) => <option key={h} value={h} />)}</datalist>
        </div>
        {!!f.neighborhoods?.length && (
          <div className="flex flex-wrap gap-1.5">{f.neighborhoods.map((h) => (
            <button key={h} type="button" className="rounded-full bg-brand-600 px-2.5 py-1 text-xs font-medium text-white" onClick={() => set({ neighborhoods: f.neighborhoods!.filter((x) => x !== h) })}>{h} ✕</button>))}</div>
        )}
      </Group>

      <Group title="Período e loja">
        <Num label="Considerar pedidos dos últimos (dias)" value={f.period_days} onChange={(v) => set({ period_days: v })} placeholder="Todos" />
        <p className="text-[11px] text-zinc-500">Vale para canal, pagamento, produto, bairro e loja.</p>
        {(options?.units.length ?? 0) > 1 && (
          <label className="block text-xs text-zinc-600">Comprou na loja
            <select className="input mt-1" value={f.unit_id ?? ""} onChange={(e) => set({ unit_id: e.target.value || undefined })}>
              <option value="">Qualquer</option>
              {options!.units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </label>
        )}
      </Group>
    </div>
  );
}
