"use client";
import { useRef } from "react";
import { Field } from "@/components/ui";
import { PLACEHOLDERS, couponExample, renderPreview, type Channel, type CouponKind, type CouponMode } from "./shared";

export type MessageForm = {
  message: string; channel: Channel; template_name: string; template_lang: string; template_params: string[];
  coupon_mode: CouponMode; coupon_kind: CouponKind; coupon_value: string; coupon_min: string; coupon_valid_days: string;
};

export const toCents = (s: string) => Math.round((Number(s.replace(/\./g, "").replace(",", ".")) || 0) * 100);
export const fromCents = (c: number) => (c / 100).toFixed(2).replace(".", ",");

export function messagePayload(f: MessageForm) {
  return {
    message: f.message.trim(), channel: f.channel,
    template_name: f.channel === "whatsapp_api" ? f.template_name.trim() : null,
    template_lang: f.template_lang.trim() || "pt_BR", template_params: f.template_params,
    coupon_mode: f.coupon_mode, coupon_kind: f.coupon_kind,
    coupon_value: f.coupon_kind === "percent" ? Math.round(Number(f.coupon_value) || 0) : f.coupon_kind === "fixed" ? toCents(f.coupon_value) : 0,
    coupon_min_order_cents: toCents(f.coupon_min), coupon_valid_days: Math.round(Number(f.coupon_valid_days) || 7),
  };
}

export function MessageEditor({ f, set, kind, store, slug, apiReady, disabled }: {
  f: MessageForm; set: (p: Partial<MessageForm>) => void; kind: "manual" | "birthday" | "winback";
  store: string; slug: string; apiReady: boolean; disabled?: boolean;
}) {
  const ta = useRef<HTMLTextAreaElement>(null);
  function insert(key: string) {
    const el = ta.current; const tag = `{${key}}`;
    if (!el) { set({ message: f.message + tag }); return; }
    const s = el.selectionStart ?? f.message.length, e = el.selectionEnd ?? s;
    set({ message: f.message.slice(0, s) + tag + f.message.slice(e) });
    requestAnimationFrame(() => { el.focus(); el.selectionStart = el.selectionEnd = s + tag.length; });
  }
  const preview = renderPreview(f.message, store, slug, couponExample(f.coupon_mode, kind));
  return (
    <fieldset disabled={disabled} className="space-y-4">
      <div>
        <span className="label">Mensagem</span>
        <div className="mb-2 flex flex-wrap gap-1.5">
          {PLACEHOLDERS.map((p) => (
            <button key={p.key} type="button" onClick={() => insert(p.key)}
              className="rounded-full border border-zinc-300 bg-white px-2.5 py-0.5 text-xs font-medium text-zinc-700 hover:border-brand-400 hover:text-brand-700">+ {p.label}</button>
          ))}
        </div>
        <textarea ref={ta} className="input min-h-28" maxLength={1000} value={f.message} onChange={(e) => set({ message: e.target.value })} />
        <div className="mt-2 rounded-lg bg-[#e7f7e1] p-3 text-sm text-zinc-800">
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-green-800">Prévia</p>
          <p className="whitespace-pre-wrap break-words">{preview || "…"}</p>
        </div>
      </div>

      <div>
        <span className="label">Cupom</span>
        <div className="flex flex-wrap gap-2">
          {([["none", "Sem cupom"], ["unique", "Único por cliente"], ["shared", "Um código para todos"]] as const).map(([k, l]) => (
            <button key={k} type="button" onClick={() => set({ coupon_mode: k })}
              className={`rounded-lg border px-3 py-1.5 text-sm ${f.coupon_mode === k ? "border-brand-500 bg-brand-50 text-brand-700" : "border-zinc-300 bg-white text-zinc-700"}`}>{l}</button>
          ))}
        </div>
        {f.coupon_mode !== "none" && (
          <div className="mt-3 grid gap-3 sm:grid-cols-4">
            <Field label="Tipo">
              <select className="input" value={f.coupon_kind} onChange={(e) => set({ coupon_kind: e.target.value as CouponKind })}>
                <option value="percent">Percentual</option><option value="fixed">Valor fixo</option><option value="free_delivery">Frete grátis</option>
              </select>
            </Field>
            {f.coupon_kind !== "free_delivery" && (
              <Field label={f.coupon_kind === "percent" ? "Desconto (%)" : "Desconto (R$)"}>
                <input className="input" inputMode="decimal" value={f.coupon_value} onChange={(e) => set({ coupon_value: e.target.value })} />
              </Field>
            )}
            <Field label="Pedido mínimo (R$)"><input className="input" inputMode="decimal" value={f.coupon_min} onChange={(e) => set({ coupon_min: e.target.value })} placeholder="0,00" /></Field>
            <Field label="Validade (dias)"><input className="input" type="number" min={1} max={90} value={f.coupon_valid_days} onChange={(e) => set({ coupon_valid_days: e.target.value })} /></Field>
          </div>
        )}
        {f.coupon_mode !== "none" && !f.message.includes("{cupom}") && (
          <p className="mt-2 text-xs text-amber-700">Dica: inclua {"{cupom}"} na mensagem para o cliente ver o código.</p>
        )}
      </div>

      <div>
        <span className="label">Como enviar</span>
        <div className="grid gap-2 sm:grid-cols-2">
          <button type="button" onClick={() => set({ channel: "manual_links" })}
            className={`rounded-lg border p-3 text-left text-sm ${f.channel === "manual_links" ? "border-brand-500 bg-brand-50" : "border-zinc-300 bg-white"}`}>
            <b className="font-medium">Manual pelo WhatsApp</b>
            <span className="block text-xs text-zinc-500">Você envia um por um, pelo WhatsApp da loja. Funciona já, sem configurar nada.</span>
          </button>
          <button type="button" disabled={!apiReady} onClick={() => set({ channel: "whatsapp_api" })}
            className={`rounded-lg border p-3 text-left text-sm disabled:cursor-not-allowed disabled:opacity-50 ${f.channel === "whatsapp_api" ? "border-brand-500 bg-brand-50" : "border-zinc-300 bg-white"}`}>
            <b className="font-medium">API oficial do WhatsApp</b>
            <span className="block text-xs text-zinc-500">{apiReady ? "Envio automático com modelo aprovado pela Meta." : "Configure e ative na aba WhatsApp para usar."}</span>
          </button>
        </div>
        {f.channel === "whatsapp_api" && (
          <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_120px]">
            <Field label="Nome do modelo aprovado" hint="Exatamente como aparece no Gerenciador do WhatsApp (letras minúsculas, números e _).">
              <input className="input font-mono" value={f.template_name} onChange={(e) => set({ template_name: e.target.value.toLowerCase() })} placeholder="volta_cupom" />
            </Field>
            <Field label="Idioma"><input className="input" value={f.template_lang} onChange={(e) => set({ template_lang: e.target.value })} /></Field>
            <div className="sm:col-span-2">
              <span className="label">Variáveis do modelo, na ordem ({"{{1}}"}, {"{{2}}"}…)</span>
              <div className="flex flex-wrap items-center gap-2">
                {f.template_params.map((p, i) => (
                  <span key={i} className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2.5 py-1 text-xs">
                    {`{{${i + 1}}}`} = {PLACEHOLDERS.find((x) => x.key === p)?.label ?? p}
                    <button type="button" className="text-zinc-500 hover:text-red-600" aria-label="Remover variável"
                      onClick={() => set({ template_params: f.template_params.filter((_, j) => j !== i) })}>✕</button>
                  </span>
                ))}
                <select className="input w-auto py-1 text-xs" value="" onChange={(e) => { if (e.target.value) set({ template_params: [...f.template_params, e.target.value] }); }}>
                  <option value="">+ adicionar</option>
                  {PLACEHOLDERS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
                </select>
              </div>
              <p className="mt-1 text-xs text-zinc-500">Na API, a Meta envia o texto do modelo aprovado; a mensagem acima serve de referência e de prévia.</p>
            </div>
          </div>
        )}
      </div>
    </fieldset>
  );
}

export const blankMessage = (message: string): MessageForm => ({
  message, channel: "manual_links", template_name: "", template_lang: "pt_BR", template_params: ["nome", "cupom"],
  coupon_mode: "none", coupon_kind: "percent", coupon_value: "10", coupon_min: "", coupon_valid_days: "7",
});
