"use client";
import { useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { usePanel } from "@/lib/panel/context";
import { Alert, Field, Toggle } from "@/components/ui";
import { errorMessage } from "@/lib/format";
import type { Settings } from "./shared";

export function WhatsAppSettings({ s, onChanged }: { s: Settings | null; onChanged: () => Promise<void> }) {
  const { tenantId, role } = usePanel();
  const sb = supabaseBrowser();
  const isOwner = role === "owner";
  const [form, setForm] = useState({
    phone: s?.wa_phone_number_id ?? "", waba: s?.wa_business_account_id ?? "", token: "", secret: "",
    version: s?.graph_version ?? "v23.0", from: String(s?.send_from_hour ?? 9), to: String(s?.send_to_hour ?? 21), freq: String(s?.frequency_days ?? 7),
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [copied, setCopied] = useState("");
  const webhook = `${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""}/functions/v1/marketing/webhook?tenant=${tenantId}`;
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(""); setMsg("");
    const { error } = await sb.rpc("marketing_save_settings", { p_tenant_id: tenantId, p: {
      wa_phone_number_id: form.phone.trim(), wa_business_account_id: form.waba.trim(), graph_version: form.version.trim(),
      send_from_hour: Number(form.from), send_to_hour: Number(form.to), frequency_days: Number(form.freq),
    }, p_token: form.token.trim() || null, p_app_secret: form.secret.trim() || null });
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return; }
    setForm((f) => ({ ...f, token: "", secret: "" }));
    setMsg("Configuração salva." + (form.token ? " Teste a conexão antes de ativar." : ""));
    await onChanged();
  }
  async function test() {
    setBusy(true); setErr(""); setMsg("");
    const { data, error } = await sb.functions.invoke("marketing/test", { body: { tenant_id: tenantId } });
    setBusy(false);
    if (error) {
      let m = errorMessage(error);
      try { const b = await (error as { context?: Response }).context?.json(); if (b?.error) m = b.error; } catch { /* sem corpo */ }
      setErr(m);
    } else if (data?.ok) setMsg(data.message); else setErr(data?.message ?? "Não foi possível testar.");
    await onChanged();
  }
  async function enable(v: boolean) {
    setBusy(true); setErr(""); setMsg("");
    const { error } = await sb.rpc("marketing_save_settings", { p_tenant_id: tenantId, p: { wa_enabled: v }, p_token: null, p_app_secret: null });
    setBusy(false);
    if (error) setErr(errorMessage(error)); else setMsg(v ? "Envio pela API do WhatsApp ativado." : "Envio pela API desativado. As campanhas manuais continuam funcionando.");
    await onChanged();
  }
  async function copy(t: string, k: string) { try { await navigator.clipboard.writeText(t); setCopied(k); setTimeout(() => setCopied(""), 2000); } catch { /* sem permissão */ } }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_420px]">
      <div className="space-y-4">
        <section className="card space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-medium text-zinc-500">API oficial do WhatsApp</p>
              <p className={`mt-1 text-xl font-semibold ${s?.wa_enabled ? "text-green-700" : "text-zinc-700"}`}>{s?.wa_enabled ? "Ativa" : "Inativa"}</p>
              <p className="mt-1 text-sm text-zinc-500">Token {s?.wa_token_hint ? `••••${s.wa_token_hint}` : "não informado"} · versão {s?.graph_version ?? "v23.0"}</p>
              {s?.last_test_at && <p className={`mt-1 text-sm ${s.last_test_ok ? "text-green-700" : "text-red-700"}`}>Último teste: {s.last_test_message}</p>}
            </div>
            {isOwner && (
              <div className="flex items-center gap-3">
                <button className="btn-secondary" disabled={busy || !s?.wa_token_hint} onClick={test}>Testar conexão</button>
                <label className="flex items-center gap-2 text-sm font-medium">Ativar
                  <Toggle checked={!!s?.wa_enabled} label="Ativar API do WhatsApp" onChange={(v) => { if (!busy) void enable(v); }} />
                </label>
              </div>
            )}
          </div>
          <Alert>{err}</Alert>
          <Alert kind="success">{msg}</Alert>
          <p className="text-xs text-zinc-500">Sem a API você já pode usar campanhas e automações no modo manual, enviando pelo WhatsApp da loja.</p>
        </section>

        <form onSubmit={save} className="card space-y-3">
          <h2 className="font-semibold">Dados da conta</h2>
          {!isOwner && <Alert kind="info">Só o dono da conta altera estes dados.</Alert>}
          <fieldset disabled={!isOwner || busy} className="grid gap-3 sm:grid-cols-2">
            <Field label="ID do número de telefone"><input className="input font-mono" inputMode="numeric" value={form.phone} onChange={(e) => set("phone", e.target.value.replace(/\D/g, ""))} /></Field>
            <Field label="ID da conta do WhatsApp Business"><input className="input font-mono" inputMode="numeric" value={form.waba} onChange={(e) => set("waba", e.target.value.replace(/\D/g, ""))} /></Field>
            <Field label="Token permanente" hint="Token de usuário do sistema. Fica guardado criptografado.">
              <input className="input" type="password" autoComplete="off" value={form.token} onChange={(e) => set("token", e.target.value)} placeholder={s?.wa_token_hint ? "Deixe em branco para manter o atual" : ""} />
            </Field>
            <Field label="Chave secreta do app" hint="Em Configurações do app › Básico. Valida as notificações da Meta.">
              <input className="input" type="password" autoComplete="off" value={form.secret} onChange={(e) => set("secret", e.target.value)} placeholder="Deixe em branco para manter a atual" />
            </Field>
            <Field label="Versão da API"><input className="input font-mono" value={form.version} onChange={(e) => set("version", e.target.value)} placeholder="v23.0" /></Field>
            <Field label="Frequência máxima (dias)" hint="Cada cliente recebe no máximo uma mensagem nesse intervalo.">
              <input className="input" type="number" min={1} max={60} value={form.freq} onChange={(e) => set("freq", e.target.value)} />
            </Field>
            <Field label="Enviar a partir de (hora)"><input className="input" type="number" min={0} max={23} value={form.from} onChange={(e) => set("from", e.target.value)} /></Field>
            <Field label="Até (hora)"><input className="input" type="number" min={1} max={24} value={form.to} onChange={(e) => set("to", e.target.value)} /></Field>
          </fieldset>
          {isOwner && <button className="btn-primary" disabled={busy}>{busy ? "Salvando..." : "Salvar"}</button>}
        </form>
      </div>

      <aside className="card space-y-3 self-start text-sm">
        <h2 className="font-semibold">Como conectar a API oficial</h2>
        <ol className="list-decimal space-y-1.5 pl-5 text-zinc-700">
          <li>Em <a className="text-brand-700 underline" href="https://developers.facebook.com" target="_blank" rel="noopener noreferrer">developers.facebook.com</a>, crie um app do tipo Empresa e adicione o produto WhatsApp.</li>
          <li>Verifique a empresa no Gerenciador de Negócios da Meta.</li>
          <li>Adicione e verifique o número de telefone da loja.</li>
          <li>Gere um token permanente de usuário do sistema com as permissões <code className="text-xs">whatsapp_business_messaging</code> e <code className="text-xs">whatsapp_business_management</code>.</li>
          <li>Crie modelos de mensagem da categoria Marketing (ex.: variáveis {"{{1}}"} nome e {"{{2}}"} cupom) e aguarde a aprovação.</li>
          <li>Cadastre o webhook com a URL e o token de verificação abaixo e assine o campo <b>messages</b>.</li>
        </ol>
        <div className="space-y-2">
          <div>
            <span className="label">URL do webhook</span>
            <div className="flex gap-2"><input readOnly className="input font-mono text-xs" value={webhook} /><button type="button" className="btn-secondary" onClick={() => copy(webhook, "u")}>{copied === "u" ? "Copiado" : "Copiar"}</button></div>
          </div>
          <div>
            <span className="label">Token de verificação</span>
            <div className="flex gap-2"><input readOnly className="input font-mono text-xs" value={s?.wa_verify_token ?? "salve a configuração primeiro"} />
              {s && <button type="button" className="btn-secondary" onClick={() => copy(s.wa_verify_token, "t")}>{copied === "t" ? "Copiado" : "Copiar"}</button>}</div>
          </div>
        </div>
        <p className="text-xs text-zinc-500">Os clientes podem responder SAIR para não receber mais mensagens; o sistema descadastra na hora. As mensagens de marketing são cobradas pela Meta por conversa, na conta da loja.</p>
      </aside>
    </div>
  );
}
