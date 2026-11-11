"use client";
import { useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { usePanel } from "@/lib/panel/context";
import { Alert, Field, Toggle } from "@/components/ui";
import { errorMessage } from "@/lib/format";
import { fmtDate, type Settings } from "./shared";

export function WhatsAppSettings({ settings, onChanged }: { settings: Settings | null; onChanged: () => Promise<void> }) {
  const { tenantId, role } = usePanel();
  const sb = supabaseBrowser();
  const isOwner = role === "owner";
  const s = settings;
  const [f, setF] = useState({
    wa_phone_number_id: s?.wa_phone_number_id ?? "", wa_business_account_id: s?.wa_business_account_id ?? "",
    graph_version: s?.graph_version ?? "v23.0", frequency_days: String(s?.frequency_days ?? 7),
    send_from_hour: String(s?.send_from_hour ?? 9), send_to_hour: String(s?.send_to_hour ?? 21),
  });
  const [token, setToken] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [copied, setCopied] = useState("");
  const webhook = `${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""}/functions/v1/marketing/webhook?tenant=${tenantId}`;

  async function call(p: Record<string, unknown>, ok: string, withSecrets = false) {
    setBusy(true); setErr(""); setMsg("");
    const { error } = await sb.rpc("marketing_save_settings", { p_tenant_id: tenantId, p,
      p_token: withSecrets ? token || null : null, p_app_secret: withSecrets ? appSecret || null : null });
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return false; }
    setMsg(ok); setToken(""); setAppSecret(""); await onChanged(); return true;
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    await call({ ...f, frequency_days: Number(f.frequency_days), send_from_hour: Number(f.send_from_hour), send_to_hour: Number(f.send_to_hour) },
      "Configuração salva. Teste a conexão antes de ativar.", true);
  }
  async function test() {
    setTesting(true); setErr(""); setMsg("");
    const { data, error } = await sb.functions.invoke("marketing/test", { body: { tenant_id: tenantId } });
    setTesting(false);
    if (error) {
      let m = errorMessage(error);
      try { const b = await (error as { context?: Response }).context?.json(); if (b?.error) m = b.error; } catch { /* sem corpo */ }
      setErr(m);
    } else if (data?.ok) setMsg(data.message); else setErr(data?.message ?? "Não foi possível testar.");
    await onChanged();
  }
  function copy(v: string, k: string) { void navigator.clipboard.writeText(v); setCopied(k); setTimeout(() => setCopied(""), 1500); }
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));

  return (
    <div className="space-y-4">
      <section className="card space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold">API oficial do WhatsApp</h2>
            <p className="text-sm text-zinc-500">
              {s?.wa_enabled ? "Ativa: campanhas podem ser enviadas automaticamente." : "Desativada. O envio manual continua funcionando."}
              {s?.wa_token_hint ? ` · token ••••${s.wa_token_hint}` : " · sem token"}
            </p>
            <p className={`mt-1 text-xs ${s?.last_test_ok ? "text-green-700" : s?.last_test_ok === false ? "text-red-700" : "text-zinc-500"}`}>
              Último teste: {s?.last_test_at ? `${fmtDate(s.last_test_at)} · ${s.last_test_message ?? ""}` : "não testado"}
            </p>
          </div>
          {isOwner && (
            <div className="flex items-center gap-3">
              <button className="btn-secondary" disabled={testing || !s} onClick={() => void test()}>{testing ? "Testando..." : "Testar conexão"}</button>
              <label className="flex items-center gap-2 text-sm font-medium">Ativar
                <Toggle checked={!!s?.wa_enabled} label="Ativar API do WhatsApp" onChange={(v) => void call({ wa_enabled: v }, v ? "API do WhatsApp ativada." : "API do WhatsApp desativada.")} />
              </label>
            </div>
          )}
        </div>
        <Alert>{err}</Alert>
        <Alert kind="success">{msg}</Alert>
      </section>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <form onSubmit={save} className="card space-y-3">
          <h3 className="font-semibold">Dados da conta</h3>
          {!isOwner && <p className="text-sm text-amber-700">Só o dono da conta altera estes dados.</p>}
          <fieldset disabled={!isOwner || busy} className="grid gap-3 sm:grid-cols-2">
            <Field label="ID do número de telefone"><input className="input font-mono" inputMode="numeric" value={f.wa_phone_number_id} onChange={(e) => set("wa_phone_number_id", e.target.value.replace(/\D/g, ""))} /></Field>
            <Field label="ID da conta do WhatsApp Business"><input className="input font-mono" inputMode="numeric" value={f.wa_business_account_id} onChange={(e) => set("wa_business_account_id", e.target.value.replace(/\D/g, ""))} /></Field>
            <Field label="Token permanente"><input className="input" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder={s?.wa_token_hint ? "Deixe em branco para manter o atual" : "Token do usuário do sistema"} /></Field>
            <Field label="Chave secreta do app" hint="Usada para validar as notificações da Meta."><input className="input" type="password" autoComplete="off" value={appSecret} onChange={(e) => setAppSecret(e.target.value)} placeholder="Deixe em branco para manter a atual" /></Field>
            <Field label="Versão da API"><input className="input font-mono" value={f.graph_version} onChange={(e) => set("graph_version", e.target.value)} /></Field>
            <Field label="No máximo 1 mensagem por cliente a cada (dias)"><input className="input" type="number" min={1} max={60} value={f.frequency_days} onChange={(e) => set("frequency_days", e.target.value)} /></Field>
            <Field label="Enviar a partir de (hora)"><input className="input" type="number" min={0} max={23} value={f.send_from_hour} onChange={(e) => set("send_from_hour", e.target.value)} /></Field>
            <Field label="Enviar até (hora)"><input className="input" type="number" min={1} max={24} value={f.send_to_hour} onChange={(e) => set("send_to_hour", e.target.value)} /></Field>
          </fieldset>
          {isOwner && <button className="btn-primary" disabled={busy}>{busy ? "Salvando..." : "Salvar"}</button>}
        </form>

        <aside className="card space-y-3 text-sm">
          <h3 className="font-semibold">Webhook (notificações da Meta)</h3>
          <Field label="URL de retorno">
            <div className="flex gap-2"><input className="input font-mono text-xs" readOnly value={webhook} /><button type="button" className="btn-secondary" onClick={() => copy(webhook, "url")}>{copied === "url" ? "Copiado" : "Copiar"}</button></div>
          </Field>
          <Field label="Token de verificação">
            <div className="flex gap-2"><input className="input font-mono text-xs" readOnly value={s?.wa_verify_token ?? "Salve a configuração primeiro"} />
              {s && <button type="button" className="btn-secondary" onClick={() => copy(s.wa_verify_token, "vt")}>{copied === "vt" ? "Copiado" : "Copiar"}</button>}</div>
          </Field>
          <p className="text-xs text-zinc-500">Assine o campo “messages”. Assim o sistema sabe quando a mensagem foi entregue e lida, e descadastra quem responder SAIR.</p>
        </aside>
      </div>

      <section className="card text-sm">
        <h3 className="mb-2 font-semibold">Como conectar a API oficial</h3>
        <ol className="list-decimal space-y-1.5 pl-5 text-zinc-700">
          <li>Crie um app em developers.facebook.com (tipo Empresa) e adicione o produto WhatsApp.</li>
          <li>Verifique a empresa no Gerenciador de Negócios da Meta.</li>
          <li>Adicione e verifique o número de telefone da loja. Copie o ID do número e o ID da conta do WhatsApp Business.</li>
          <li>Gere um token permanente de usuário do sistema com as permissões whatsapp_business_messaging e whatsapp_business_management.</li>
          <li>Crie modelos de mensagem da categoria Marketing (ex.: com {"{{1}}"} para o nome e {"{{2}}"} para o cupom) e aguarde a aprovação.</li>
          <li>Cadastre o webhook com a URL e o token de verificação acima, e cole aqui a chave secreta do app.</li>
          <li>Salve, teste a conexão e ative.</li>
        </ol>
        <p className="mt-3 text-xs text-zinc-500">A Meta cobra as mensagens de marketing por conversa, direto na conta da loja. Os clientes podem responder SAIR (ou PARAR) para não receber mais; o descadastro é automático.</p>
      </section>
    </div>
  );
}
