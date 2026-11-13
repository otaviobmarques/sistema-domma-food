"use client";
import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { usePanel } from "@/lib/panel/context";
import { Alert, Field, Toggle } from "@/components/ui";
import { brl, errorMessage } from "@/lib/format";
import { fmtDate } from "./shared";

type Param = "nome" | "loja" | "link" | "cupom" | "total";
type Cart = {
  id: string; created_at: string; reminded_at: string | null; status: string; channel: string | null; name: string | null; phone: string;
  verified: boolean; item_count: number; subtotal_cents: number; wa_status: string | null; wa_error: string | null; opened_at: string | null;
  unit_name: string; summary: string | null; order_number: number | null; manual_text: string | null;
};
type Overview = {
  settings: { enabled: boolean; delay_min: number; message: string; coupon_id: string | null; template_name: string | null; template_lang: string; template_params: Param[] };
  wa_ready: boolean;
  coupons: { id: string; code: string; kind: string; value: number }[];
  stats: { captured: number; converted: number; reminded: number; recovered: number; recovered_cents: number; manual_pending: number; opened: number };
  carts: Cart[];
};

const PARAMS: Record<Param, string> = { nome: "Primeiro nome", loja: "Nome da loja", link: "Link da sacola", cupom: "Cupom", total: "Valor da sacola" };
const STATUS: Record<string, { label: string; cls: string }> = {
  open: { label: "Aguardando", cls: "bg-zinc-100 text-zinc-600" },
  manual_pending: { label: "Enviar pelo WhatsApp", cls: "bg-amber-50 text-amber-800" },
  reminded: { label: "Lembrete enviado", cls: "bg-sky-50 text-sky-700" },
  recovered: { label: "Recuperado", cls: "bg-emerald-50 text-emerald-700" },
  converted: { label: "Pediu sem lembrete", cls: "bg-zinc-100 text-zinc-600" },
  expired: { label: "Encerrado", cls: "bg-zinc-100 text-zinc-500" },
  discarded: { label: "Descartado", cls: "bg-zinc-100 text-zinc-500" },
};
const CHANNEL: Record<string, string> = { whatsapp_api: "WhatsApp automático", push: "Notificação no aparelho", manual: "WhatsApp da loja" };
const DELAYS = [20, 30, 60, 120, 180, 360];
const couponText = (c: { code: string; kind: string; value: number }) =>
  `${c.code} · ${c.kind === "percent" ? `${c.value}%` : c.kind === "fixed" ? brl(c.value) : "frete grátis"}`;
const waLink = (phone: string, text: string) => `https://wa.me/${phone.length <= 11 ? "55" + phone : phone}?text=${encodeURIComponent(text)}`;

/** Recuperação de carrinho: lembrete para quem montou a sacola e não finalizou. */
export function CartRecovery() {
  const { tenantId } = usePanel();
  const sb = supabaseBrowser();
  const [ov, setOv] = useState<Overview | null>(null);
  const [form, setForm] = useState<Overview["settings"] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    const { data, error } = await sb.rpc("cart_overview", { p_tenant_id: tenantId, p_days: 30 });
    if (error) { setErr(errorMessage(error)); return; }
    const o = data as Overview;
    setOv(o); setForm((f) => f ?? o.settings);
  }, [sb, tenantId]);
  useEffect(() => { void load(); }, [load]);

  async function save(patch: Partial<Overview["settings"]>, ok: string) {
    setBusy(true); setErr(""); setMsg("");
    const { error } = await sb.rpc("cart_save_settings", { p_tenant_id: tenantId, p: patch });
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return; }
    setMsg(ok); await load();
  }
  async function mark(id: string, sent: boolean) {
    const { error } = await sb.rpc("cart_manual_mark", { p_cart_id: id, p_sent: sent });
    if (error) setErr(errorMessage(error)); else await load();
  }

  if (!ov || !form) return null;
  const st = ov.stats;
  const rate = st.reminded ? Math.round((st.recovered / st.reminded) * 100) : 0;
  const tile = (label: string, value: string, hint?: string) => (
    <div className="rounded-xl bg-zinc-50 p-3">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className="text-xl font-bold">{value}</p>
      {hint && <p className="text-[11px] text-zinc-500">{hint}</p>}
    </div>
  );
  const toggleParam = (k: Param) => setForm({ ...form, template_params: form.template_params.includes(k) ? form.template_params.filter((x) => x !== k) : [...form.template_params, k] });

  return (
    <div className="space-y-5">
      <section className="card space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Recuperação de carrinho</h2>
            <p className="mt-1 max-w-2xl text-sm text-zinc-600">
              Quem montou a sacola, autorizou ofertas e não finalizou recebe um lembrete com um link que refaz a sacola (e o cupom, se você escolher).
              Um lembrete por pessoa, no horário de envio da loja.
            </p>
          </div>
          <Toggle checked={ov.settings.enabled} label="Ligado" onChange={(v) => void save({ enabled: v }, v ? "Recuperação de carrinho ligada." : "Recuperação de carrinho desligada.")} />
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Enviar o lembrete depois de">
            <select className="input" value={form.delay_min} onChange={(e) => setForm({ ...form, delay_min: Number(e.target.value) })}>
              {DELAYS.map((m) => <option key={m} value={m}>{m < 60 ? `${m} minutos` : `${m / 60} hora${m > 60 ? "s" : ""}`} sem pedido</option>)}
            </select>
          </Field>
          <Field label="Cupom no lembrete (opcional)" hint={ov.coupons.length ? undefined : "Crie um cupom em Cupons para oferecer no lembrete."}>
            <select className="input" value={form.coupon_id ?? ""} onChange={(e) => setForm({ ...form, coupon_id: e.target.value || null })}>
              <option value="">Sem cupom</option>
              {ov.coupons.map((c) => <option key={c.id} value={c.id}>{couponText(c)}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Mensagem (WhatsApp da loja)" hint="Use {nome}, {loja}, {link}, {cupom} e {total}. O {link} é obrigatório: ele refaz a sacola do cliente.">
          <textarea className="input h-24" maxLength={600} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} />
        </Field>

        <div className="rounded-xl border border-zinc-200 p-3">
          <p className="text-sm font-semibold">WhatsApp automático (API oficial)</p>
          <p className="mt-0.5 text-xs text-zinc-500">
            {ov.wa_ready
              ? "Precisa de um modelo de mensagem de marketing aprovado pela Meta. Por segurança, o envio automático só vai para clientes que já compraram e estão no mesmo aparelho; os outros aparecem na lista abaixo para você enviar pelo WhatsApp da loja."
              : "O WhatsApp oficial não está ligado (aba WhatsApp). Sem ele, o lembrete vai por notificação no aparelho (quando o cliente ativou) ou fica na lista abaixo para você enviar pelo WhatsApp da loja."}
          </p>
          {ov.wa_ready && (
            <div className="mt-3 grid gap-3 md:grid-cols-[2fr_1fr]">
              <Field label="Nome do modelo aprovado"><input className="input" value={form.template_name ?? ""} placeholder="carrinho_lembrete" onChange={(e) => setForm({ ...form, template_name: e.target.value })} /></Field>
              <Field label="Idioma"><input className="input" value={form.template_lang} onChange={(e) => setForm({ ...form, template_lang: e.target.value })} /></Field>
              <div className="md:col-span-2">
                <p className="label">Variáveis do modelo, na ordem ({"{{1}}"}, {"{{2}}"}...)</p>
                <div className="flex flex-wrap gap-1.5">
                  {(Object.keys(PARAMS) as Param[]).map((k) => {
                    const i = form.template_params.indexOf(k);
                    return (
                      <button key={k} type="button" aria-pressed={i >= 0} onClick={() => toggleParam(k)}
                        className={`rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${i >= 0 ? "bg-brand-600 text-white ring-brand-600" : "bg-white text-zinc-700 ring-zinc-200"}`}>
                        {i >= 0 ? `{{${i + 1}}} ` : ""}{PARAMS[k]}</button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-primary" disabled={busy} onClick={() => void save({
            delay_min: form.delay_min, message: form.message, coupon_id: form.coupon_id,
            ...(ov.wa_ready ? { template_name: form.template_name ?? "", template_lang: form.template_lang, template_params: form.template_params } : {}),
          }, "Configuração salva.")}>Salvar</button>
          <Alert>{err}</Alert>
          <Alert kind="success">{msg}</Alert>
        </div>
      </section>

      <section className="card space-y-3">
        <h2 className="text-lg font-semibold">Resultado (últimos 30 dias)</h2>
        <div className="grid gap-2 sm:grid-cols-4">
          {tile("Sacolas guardadas", `${st.captured}`, `${st.converted} pediram sem precisar de lembrete`)}
          {tile("Lembretes enviados", `${st.reminded}`, `${st.opened} abriram o link`)}
          {tile("Recuperados", `${st.recovered}`, `${rate}% dos lembretes`)}
          {tile("Vendas recuperadas", brl(st.recovered_cents))}
        </div>
      </section>

      <section className="card">
        <h2 className="text-lg font-semibold">Sacolas</h2>
        {st.manual_pending > 0 && <p className="mt-1 text-sm text-amber-800">{st.manual_pending} aguardando você enviar pelo WhatsApp da loja.</p>}
        {ov.carts.length === 0 ? <p className="mt-2 text-sm text-zinc-500">Nenhuma sacola ainda. Elas aparecem quando um cliente que autorizou ofertas sai do checkout sem pedir.</p> : (
          <ul className="mt-3 divide-y divide-zinc-100">
            {ov.carts.map((c) => {
              const s = STATUS[c.status] ?? { label: c.status, cls: "bg-zinc-100 text-zinc-600" };
              return (
                <li key={c.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">
                      {c.name || "Cliente"} · {c.phone}
                      {c.verified && <span className="ml-1.5 badge bg-emerald-50 text-emerald-700" title="Já comprou e está no mesmo aparelho">cliente conhecido</span>}
                    </p>
                    <p className="line-clamp-1 text-xs text-zinc-500">{c.summary} · {brl(c.subtotal_cents)} · {c.unit_name}</p>
                    <p className="text-[11px] text-zinc-500">
                      {fmtDate(c.created_at)}{c.channel ? ` · ${CHANNEL[c.channel]}` : ""}{c.reminded_at ? ` em ${fmtDate(c.reminded_at)}` : ""}
                      {c.opened_at && c.reminded_at ? " · abriu o link" : ""}{c.order_number ? ` · pedido #${c.order_number}` : ""}
                      {c.wa_status === "failed" ? ` · falhou: ${c.wa_error ?? ""}` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className={`badge ${s.cls}`}>{s.label}</span>
                    {c.status === "manual_pending" && c.manual_text && (
                      <>
                        <a className="btn-primary px-3 py-1.5 text-xs" href={waLink(c.phone, c.manual_text)} target="_blank" rel="noreferrer"
                          onClick={() => void mark(c.id, true)}>Enviar pelo WhatsApp</a>
                        <button className="btn-ghost px-2 py-1.5 text-xs" onClick={() => void mark(c.id, false)}>Descartar</button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
