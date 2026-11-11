"use client";
import { useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { usePanel } from "@/lib/panel/context";
import { Alert, Field, Toggle } from "@/components/ui";
import { errorMessage } from "@/lib/format";
import type { Gateway } from "./shared";

export function SettingsForm({ g, isOwner, onSaved }: { g: Gateway | null; isOwner: boolean; onSaved: () => Promise<void> | void }) {
  const { unit } = usePanel();
  const [f, setF] = useState({
    public_key: g?.public_key ?? "", pix_enabled: g?.pix_enabled ?? true, card_enabled: g?.card_enabled ?? false,
    max_installments: String(g?.max_installments ?? 1), statement_descriptor: g?.statement_descriptor ?? "",
  });
  const [token, setToken] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(""); setMsg("");
    const desc = f.statement_descriptor.trim();
    if (desc && !/^[A-Za-z0-9 ]{1,13}$/.test(desc)) { setBusy(false); setErr("Nome na fatura: até 13 letras, números ou espaços, sem acentos."); return; }
    const { error } = await supabaseBrowser().rpc("gateway_save_settings", {
      p_unit_id: unit.id,
      p: { public_key: f.public_key.trim(), pix_enabled: f.pix_enabled, card_enabled: f.card_enabled,
           max_installments: Number(f.max_installments), statement_descriptor: desc },
      p_access_token: token.trim() || null, p_webhook_secret: secret.trim() || null,
    });
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return; }
    setToken(""); setSecret("");
    setMsg(token.trim() ? "Configuração salva. Teste a conexão antes de ativar." : "Configuração salva.");
    await onSaved();
  }

  const ro = !isOwner;
  return (
    <form onSubmit={save} className="card space-y-4">
      <div>
        <h2 className="font-semibold">Credenciais e formas de pagamento</h2>
        {ro && <p className="text-xs text-zinc-500">Só o dono da conta altera esta configuração.</p>}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Public Key" hint="Começa com APP_USR- (produção) ou TEST- (teste).">
          <input className="input font-mono text-xs" disabled={ro} value={f.public_key} onChange={(e) => set("public_key", e.target.value)} placeholder="APP_USR-..." autoComplete="off" />
        </Field>
        <Field label="Access Token" hint={g?.token_hint ? `Atual termina em ${g.token_hint}.` : "Nunca compartilhe este token."}>
          <input className="input font-mono text-xs" type="password" disabled={ro} value={token} onChange={(e) => setToken(e.target.value)}
            placeholder={g?.access_token_secret_id ? "Deixe em branco para manter o atual" : "APP_USR-..."} autoComplete="new-password" />
        </Field>
        <Field label="Assinatura secreta do webhook" hint={g?.webhook_secret_id ? "Já cadastrada." : "Valida que as notificações vêm do Mercado Pago."}>
          <input className="input font-mono text-xs" type="password" disabled={ro} value={secret} onChange={(e) => setSecret(e.target.value)}
            placeholder={g?.webhook_secret_id ? "Deixe em branco para manter o atual" : ""} autoComplete="new-password" />
        </Field>
        <Field label="Nome na fatura do cartão" hint="Até 13 letras ou números, sem acentos. Ex.: BELLAMASSA">
          <input className="input uppercase" disabled={ro} maxLength={13} value={f.statement_descriptor} onChange={(e) => set("statement_descriptor", e.target.value.toUpperCase())} />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 p-3 text-sm">
          <span><span className="font-medium">Pix</span><span className="block text-xs text-zinc-500">Confirmação automática do pagamento</span></span>
          <Toggle checked={f.pix_enabled} onChange={(v) => { if (!ro) set("pix_enabled", v); }} label="Pix" />
        </label>
        <label className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 p-3 text-sm">
          <span><span className="font-medium">Cartão de crédito online</span><span className="block text-xs text-zinc-500">O cliente paga no cardápio</span></span>
          <Toggle checked={f.card_enabled} onChange={(v) => { if (!ro) set("card_enabled", v); }} label="Cartão de crédito online" />
        </label>
        <Field label="Parcelas no cartão" hint="Juros e parcelamento seguem a sua conta Mercado Pago.">
          <select className="input" disabled={ro || !f.card_enabled} value={f.max_installments} onChange={(e) => set("max_installments", e.target.value)}>
            {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n === 1 ? "Só à vista" : `Até ${n}x`}</option>)}
          </select>
        </Field>
      </div>
      <Alert>{err}</Alert>
      <Alert kind="success">{msg}</Alert>
      {isOwner && <button className="btn-primary" disabled={busy}>{busy ? "Salvando..." : "Salvar configuração"}</button>}
    </form>
  );
}
