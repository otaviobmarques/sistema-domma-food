"use client";
import { useRef } from "react";
import { Field } from "@/components/ui";
import { centsToInput, parseBRL } from "@/lib/format";
import { PLACEHOLDERS, render, type Campaign } from "./shared";

export type MessageForm = {
  message: string; channel: Campaign["channel"]; template_name: string; template_lang: string; template_params: string[];
  coupon_mode: Campaign["coupon_mode"]; coupon_kind: Campaign["coupon_kind"]; coupon_value: string; coupon_min: string; coupon_valid_days: string;
};
export const fromCents = (c: number | null | undefined) => centsToInput(c ?? 0);
export function blankMessage(message = "Oi, {nome}! Sentimos sua falta na {loja}. Use o cupom {cupom} no seu próximo pedido: {link}"): MessageForm {
  return { message, channel: "manual_links", template_name: "", template_lang: "pt_BR", template_params: ["nome", "cupom"],
    coupon_mode: "unique", coupon_kind: "percent", coupon_value: "10", coupon_min: "", coupon_valid_days: "7" };
}
export function messagePayload(f: MessageForm) {
  return {
    message: f.message.trim(), channel: f.channel,
    template_name: f.channel === "whatsapp_api" ? f.template_name.trim() : "", template_lang: f.template_lang || "pt_BR",
    template_params: f.template_params.length ? f.template_params : ["nome"],
    coupon_mode: f.coupon_mode, coupon_kind: f.coupon_kind,
    coupon_value: f.coupon_kind === "fixed" ? parseBRL(f.coupon_value) : f.coupon_kind === "free_delivery" ? 0 : Math.round(Number(f.coupon_value.replace(",", ".")) || 0),
    coupon_min_order_cents: parseBRL(f.coupon_min), coupon_valid_days: Math.min(90, Math.max(1, Number(f.coupon_valid_days) || 7)),
  };
}

export function MessageEditor({ f, set, kind, store, slug, apiReady }: {
  f: MessageForm; set: (p: Partial<MessageForm>) => void; kind?: Campaign["kind"]; store: string; slug: string; apiReady: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  function insert(tag: string) {
    const el = ref.current;
    if (!el) { set({ message: f.message + tag }); return; }
    const a = el.selectionStart ?? f.message.length, b = el.selectionEnd ?? a;
    set({ message: f.message.slice(0, a) + tag + f.message.slice(b) });
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + tag.length, a + tag.length); });
  }
  const coupon = f.coupon_mode === "none" ? "" : kind === "birthday" ? "NIVER4H8T2M" : kind === "winback" ? "VOLTA7K2P9Q" : "DOMMA3F9X1Z";
  const preview = render(f.message, { store, slug, coupon });
  const toggleParam = (k: string) => set({ template_params: f.template_params.includes(k) ? f.template_params.filter((x) => x !== k) : [...f.template_params, k] });

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2">
          <Field label="Mensagem">
            <textarea ref={ref} className="input min-h-32" maxLength={1000} value={f.message} onChange={(e) => set({ message: e.target.value })} />
          </Field>
          <div className="flex flex-wrap gap-1.5">
            {PLACEHOLDERS.map((p) => (
              <button key={p.key} type="button" className="badge bg-zinc-100 text-zinc-700 hover:bg-zinc-200" onClick={() => insert(p.tag)}>+ {p.label}</button>
            ))}
          </div>
          {f.coupon_mode === "none" && f.message.includes("{cupom}") && <p className="text-xs text-amber-700">A mensagem usa {"{cupom}"}, mas nenhum cupom está configurado.</p>}
        </div>
        <div>
          <p className="label">Prévia</p>
          <div className="rounded-lg bg-[#e5ddd5] p-3">
            <div className="ml-auto max-w-[90%] whitespace-pre-wrap break-words rounded-lg rounded-tr-none bg-[#dcf8c6] px-3 py-2 text-sm text-zinc-900 shadow-sm">
              {preview || <span className="text-zinc-400">Escreva a mensagem…</span>}
            </div>
          </div>
          <p className="mt-1 text-xs text-zinc-500">Exemplo com dados fictícios. Cada cliente recebe o próprio nome e cupom.</p>
        </div>
      </div>

      <div className="rounded-lg border border-zinc-200 p-3">
        <p className="mb-2 text-sm font-medium">Cupom</p>
        <div className="flex flex-wrap gap-2 text-sm">
          {([["none", "Sem cupom"], ["unique", "Um código por cliente"], ["shared", "Um código para todos"]] as const).map(([v, l]) => (
            <label key={v} className={`cursor-pointer rounded-lg border px-3 py-1.5 ${f.coupon_mode === v ? "border-brand-500 bg-brand-50 text-brand-700" : "border-zinc-200"}`}>
              <input type="radio" className="sr-only" checked={f.coupon_mode === v} onChange={() => set({ coupon_mode: v })} />{l}
            </label>
          ))}
        </div>
        {f.coupon_mode !== "none" && (
          <div className="mt-3 grid gap-3 sm:grid-cols-4">
            <Field label="Tipo">
              <select className="input" value={f.coupon_kind} onChange={(e) => set({ coupon_kind: e.target.value as MessageForm["coupon_kind"] })}>
                <option value="percent">Desconto %</option><option value="fixed">Desconto em R$</option><option value="free_delivery">Entrega grátis</option>
              </select>
            </Field>
            {f.coupon_kind !== "free_delivery" && (
              <Field label={f.coupon_kind === "percent" ? "Percentual" : "Valor (R$)"}>
                <input className="input" inputMode="decimal" value={f.coupon_value} onChange={(e) => set({ coupon_value: e.target.value })} />
              </Field>
            )}
            <Field label="Pedido mínimo (R$)"><input className="input" inputMode="decimal" placeholder="0,00" value={f.coupon_min} onChange={(e) => set({ coupon_min: e.target.value })} /></Field>
            <Field label="Validade (dias)"><input className="input" type="number" min={1} max={90} value={f.coupon_valid_days} onChange={(e) => set({ coupon_valid_days: e.target.value })} /></Field>
          </div>
        )}
      </div>

      <div className="rounded-lg border border-zinc-200 p-3">
        <p className="mb-2 text-sm font-medium">Como enviar</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className={`cursor-pointer rounded-lg border p-3 text-sm ${f.channel === "manual_links" ? "border-brand-500 bg-brand-50" : "border-zinc-200"}`}>
            <input type="radio" className="sr-only" checked={f.channel === "manual_links"} onChange={() => set({ channel: "manual_links" })} />
            <b className="font-medium">Manual pelo WhatsApp</b>
            <span className="block text-xs text-zinc-500">Você envia uma por uma pelo WhatsApp da loja, com a mensagem já pronta. Funciona hoje.</span>
          </label>
          <label className={`rounded-lg border p-3 text-sm ${!apiReady ? "cursor-not-allowed opacity-60" : "cursor-pointer"} ${f.channel === "whatsapp_api" ? "border-brand-500 bg-brand-50" : "border-zinc-200"}`}>
            <input type="radio" className="sr-only" disabled={!apiReady} checked={f.channel === "whatsapp_api"} onChange={() => set({ channel: "whatsapp_api" })} />
            <b className="font-medium">API oficial do WhatsApp</b>
            <span className="block text-xs text-zinc-500">{apiReady ? "Envio automático com modelo aprovado pela Meta." : "Configure e ative na aba WhatsApp para usar."}</span>
          </label>
        </div>
        {f.channel === "whatsapp_api" && (
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <Field label="Nome do modelo aprovado" hint="Exatamente como aparece no WhatsApp Manager.">
              <input className="input font-mono" value={f.template_name} onChange={(e) => set({ template_name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "") })} placeholder="volta_cupom" />
            </Field>
            <Field label="Idioma"><input className="input" value={f.template_lang} onChange={(e) => set({ template_lang: e.target.value })} /></Field>
            <div>
              <p className="label">Variáveis do modelo, na ordem</p>
              <div className="flex flex-wrap gap-1.5">
                {PLACEHOLDERS.map((p) => {
                  const i = f.template_params.indexOf(p.key);
                  return (
                    <button key={p.key} type="button" onClick={() => toggleParam(p.key)}
                      className={`badge ${i >= 0 ? "bg-brand-600 text-white" : "bg-zinc-100 text-zinc-700"}`}>{i >= 0 ? `{{${i + 1}}} ` : ""}{p.label}</button>
                  );
                })}
              </div>
              <p className="mt-1 text-xs text-zinc-500">A mensagem acima vira só a prévia; a Meta envia o texto do modelo aprovado.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
