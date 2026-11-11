"use client";
import { useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Alert, Toggle } from "@/components/ui";
import { brl } from "@/lib/format";

export type BillingAdmin = {
  env: "sandbox" | "production"; api_key_hint: string | null; webhook_token: string; enabled: boolean; grace_days: number;
  last_test_at: string | null; last_test_ok: boolean | null; last_test_message: string | null; mrr_cents: number;
  accounts: Record<string, { status: string; plan_id: string | null; next_due_date: string | null;
    last_invoice: { status: string; due_date: string; value_cents: number } | null }> | null;
  exempt: string[];
};

/** Configuração da cobrança do SaaS (Asaas): chave, ambiente, webhook, carência. */
export function BillingSettings({ s, onChanged }: { s: BillingAdmin; onChanged: () => Promise<void> }) {
  const sb = supabaseBrowser();
  const [env, setEnv] = useState(s.env);
  const [grace, setGrace] = useState(String(s.grace_days));
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [copied, setCopied] = useState("");
  const webhook = `${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""}/functions/v1/billing/webhook`;

  async function save(p: Record<string, unknown>, ok: string, withKey = false) {
    setBusy("save"); setErr(""); setMsg("");
    const { error } = await sb.rpc("admin_billing_save", { p, p_api_key: withKey ? key || null : null });
    setBusy("");
    if (error) { setErr(error.message); return; }
    setKey(""); setMsg(ok); await onChanged();
  }
  async function test() {
    setBusy("test"); setErr(""); setMsg("");
    const { data, error } = await sb.functions.invoke("billing/test", { body: {} });
    setBusy("");
    if (error) setErr(error.message); else if (data?.ok) setMsg(data.message); else setErr(data?.message ?? data?.error ?? "Falhou.");
    await onChanged();
  }
  async function rotate() {
    if (!confirm("Gerar um novo token? Atualize-o no webhook do Asaas logo em seguida.")) return;
    const { error } = await sb.rpc("admin_billing_rotate_webhook");
    if (error) setErr(error.message); else { setMsg("Novo token gerado."); await onChanged(); }
  }
  function copy(v: string, k: string) { void navigator.clipboard.writeText(v); setCopied(k); setTimeout(() => setCopied(""), 1500); }

  return (
    <section className="card space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">Cobrança das assinaturas (Asaas)</h2>
          <p className="text-sm text-zinc-500">
            {s.enabled ? `Ativa · ${s.env === "production" ? "produção" : "sandbox"}` : "Desativada: ninguém é cobrado nem suspenso automaticamente."}
            {s.api_key_hint ? ` · chave ••••${s.api_key_hint}` : " · sem chave"} · MRR assinado {brl(s.mrr_cents)}
          </p>
          <p className={`mt-1 text-xs ${s.last_test_ok ? "text-green-700" : s.last_test_ok === false ? "text-red-700" : "text-zinc-500"}`}>
            Último teste: {s.last_test_at ? `${new Date(s.last_test_at).toLocaleString("pt-BR")} · ${s.last_test_message ?? ""}` : "não testado"}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button className="btn-secondary" disabled={!!busy} onClick={() => void test()}>{busy === "test" ? "Testando..." : "Testar conexão"}</button>
          <label className="flex items-center gap-2 text-sm font-medium">Ativar
            <Toggle checked={s.enabled} label="Ativar cobrança automática" onChange={(v) => {
              if (v && !confirm("Ativar a cobrança? Contas com teste vencido entram em atraso e são suspensas após a carência (exceto as isentas).")) return;
              void save({ enabled: v }, v ? "Cobrança ativada." : "Cobrança desativada.");
            }} />
          </label>
        </div>
      </div>
      <Alert>{err}</Alert>
      <Alert kind="success">{msg}</Alert>
      <div className="grid gap-3 md:grid-cols-[10rem_1fr_9rem_auto] md:items-end">
        <label className="block"><span className="label">Ambiente</span>
          <select className="input" value={env} onChange={(e) => setEnv(e.target.value as typeof env)}>
            <option value="sandbox">Sandbox (testes)</option><option value="production">Produção</option>
          </select></label>
        <label className="block"><span className="label">Chave da API {s.api_key_hint ? "(deixe vazio para manter)" : ""}</span>
          <input className="input font-mono" type="password" autoComplete="off" placeholder="$aact_..." value={key} onChange={(e) => setKey(e.target.value)} /></label>
        <label className="block"><span className="label">Carência (dias)</span>
          <input className="input" type="number" min={1} max={30} value={grace} onChange={(e) => setGrace(e.target.value)} /></label>
        <button className="btn-primary" disabled={!!busy} onClick={() => void save({ env, grace_days: Number(grace) }, "Configuração salva. Teste a conexão.", true)}>Salvar</button>
      </div>
      <div className="rounded-xl bg-zinc-50 p-3 text-sm">
        <p className="font-medium">Webhook no Asaas (Integrações › Webhooks)</p>
        <p className="mt-1 text-xs text-zinc-600">Crie um webhook com os eventos de <b>Cobranças</b>, versão v3, envio sequencial, com esta URL e este token de autenticação:</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <code className="break-all rounded bg-white px-2 py-1 text-xs ring-1 ring-zinc-200">{webhook}</code>
          <button className="text-xs font-medium text-brand-700 hover:underline" onClick={() => copy(webhook, "url")}>{copied === "url" ? "Copiado!" : "Copiar"}</button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <code className="break-all rounded bg-white px-2 py-1 text-xs ring-1 ring-zinc-200">{s.webhook_token}</code>
          <button className="text-xs font-medium text-brand-700 hover:underline" onClick={() => copy(s.webhook_token, "tok")}>{copied === "tok" ? "Copiado!" : "Copiar"}</button>
          <button className="text-xs font-medium text-zinc-500 hover:underline" onClick={() => void rotate()}>Gerar novo</button>
        </div>
      </div>
    </section>
  );
}
