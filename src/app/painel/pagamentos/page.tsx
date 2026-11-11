"use client";
import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { canManage, usePanel } from "@/lib/panel/context";
import { Alert, Empty, Toggle } from "@/components/ui";
import { errorMessage } from "@/lib/format";
import { SettingsForm } from "./settings";
import { PaymentsList } from "./payments-list";
import type { Gateway } from "./shared";

export default function Pagamentos() {
  const { unit, role } = usePanel();
  const sb = supabaseBrowser();
  const isOwner = role === "owner";
  const [g, setG] = useState<Gateway | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [testing, setTesting] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [copied, setCopied] = useState(false);
  const webhookUrl = `${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""}/functions/v1/payments/webhook?unit=${unit.id}`;

  const load = useCallback(async () => {
    const { data, error } = await sb.from("payment_gateways").select("*").eq("unit_id", unit.id).maybeSingle();
    if (error) setErr(errorMessage(error)); else setG((data as Gateway | null) ?? null);
    setLoaded(true);
  }, [sb, unit.id]);
  useEffect(() => { if (canManage(role)) void load(); }, [load, role]);

  async function test() {
    setTesting(true); setErr(""); setMsg("");
    const { data, error } = await sb.functions.invoke("payments/test", { body: { unit_id: unit.id } });
    setTesting(false);
    if (error) {
      let m = errorMessage(error);
      try { const b = await (error as { context?: Response }).context?.json(); if (b?.error) m = b.error; } catch { /* sem corpo */ }
      setErr(m);
    } else if (data?.ok) setMsg(data.message);
    else setErr(data?.message ?? "Não foi possível testar a conexão.");
    await load();
  }

  async function setEnabled(v: boolean) {
    setToggling(true); setErr(""); setMsg("");
    const { error } = await sb.rpc("gateway_save_settings", { p_unit_id: unit.id, p: { enabled: v }, p_access_token: null, p_webhook_secret: null });
    setToggling(false);
    if (error) setErr(errorMessage(error));
    else setMsg(v ? "Pagamento online ativado no cardápio." : "Pagamento online desativado. O cardápio volta a usar as formas de pagamento manuais.");
    await load();
  }

  async function copy() {
    try { await navigator.clipboard.writeText(webhookUrl); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* sem permissão */ }
  }

  if (!canManage(role)) return <Empty>O pagamento online é configurado pela gerência.</Empty>;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="h1">Pagamento online</h1>
        <p className="text-sm text-zinc-500">Pix com confirmação automática e cartão de crédito no cardápio, pelo Mercado Pago. O dinheiro cai na conta Mercado Pago da loja, e as tarifas são cobradas pelo Mercado Pago nessa mesma conta.</p>
      </div>
      <Alert>{err}</Alert>
      <Alert kind="success">{msg}</Alert>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_400px]">
        <section className="card space-y-4" aria-label="Situação">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-medium text-zinc-500">Situação</p>
              <p className={`mt-1 text-xl font-semibold ${g?.enabled ? "text-green-700" : "text-zinc-700"}`}>{g?.enabled ? "Ativo no cardápio" : "Inativo"}</p>
            </div>
            {isOwner && (
              <label className="flex items-center gap-3 text-sm font-medium">
                Ativar
                <Toggle checked={!!g?.enabled} onChange={(v) => { if (!toggling) void setEnabled(v); }} label="Ativar pagamento online" />
              </label>
            )}
          </div>
          <dl className="grid gap-3 text-sm sm:grid-cols-3">
            <div className="rounded-lg border border-zinc-200 p-3"><dt className="text-xs text-zinc-500">Ambiente</dt>
              <dd className="mt-0.5"><span className={`badge ${g?.live ? "bg-green-100 text-green-800" : g?.live === false ? "bg-amber-100 text-amber-800" : "bg-zinc-100 text-zinc-600"}`}>
                {g?.live ? "Produção" : g?.live === false ? "Teste" : "Sem credencial"}</span></dd>
              <dd className="mt-1 text-xs text-zinc-500">{g?.live ? "Cobranças reais" : g?.live === false ? "Cobranças de teste, sem dinheiro real" : "—"}</dd></div>
            <div className="rounded-lg border border-zinc-200 p-3"><dt className="text-xs text-zinc-500">Access Token</dt>
              <dd className="mt-0.5 font-medium">{g?.token_hint ? `••••${g.token_hint}` : "Não informado"}</dd>
              <dd className="text-xs text-zinc-500">{g?.webhook_secret_id ? "Webhook com assinatura" : "Webhook sem assinatura"}</dd></div>
            <div className="rounded-lg border border-zinc-200 p-3"><dt className="text-xs text-zinc-500">Último teste</dt>
              <dd className={`mt-0.5 font-medium ${g?.last_test_ok ? "text-green-700" : g?.last_test_ok === false ? "text-red-700" : ""}`}>
                {g?.last_test_at ? (g.last_test_ok ? "Conexão OK" : "Falhou") : "Não testado"}</dd>
              <dd className="text-xs text-zinc-500">{g?.last_test_at ? new Date(g.last_test_at).toLocaleString("pt-BR") : "—"}</dd></div>
          </dl>
          {g?.last_test_message && <p className="text-xs text-zinc-600">{g.last_test_message}</p>}
          {isOwner && (
            <button className="btn-secondary" disabled={testing || !g?.token_hint} onClick={() => void test()}>{testing ? "Testando..." : "Testar conexão"}</button>
          )}
          <p className="text-xs text-zinc-500">Ao salvar credenciais novas, teste a conexão de novo antes de ativar.</p>
        </section>

        <aside className="card space-y-3 text-sm" aria-label="Como conectar">
          <h2 className="font-semibold">Como conectar</h2>
          <ol className="list-decimal space-y-1.5 pl-5 text-zinc-700">
            <li>Entre em <a className="font-medium text-brand-700 underline" href="https://www.mercadopago.com.br/developers" target="_blank" rel="noopener noreferrer">mercadopago.com.br/developers</a> › Suas integrações › Criar aplicação (pagamentos online / Checkout Transparente).</li>
            <li>Em Credenciais de produção (ou de teste, para experimentar), copie a Public Key e o Access Token.</li>
            <li>Em Webhooks, cadastre a URL abaixo, marque o evento &quot;Pagamentos&quot; e copie a assinatura secreta.</li>
            <li>Cole tudo aqui, salve e clique em Testar conexão. Depois ative.</li>
          </ol>
          <div>
            <p className="mb-1 text-xs font-medium text-zinc-500">URL do webhook desta loja</p>
            <div className="flex gap-2">
              <input className="input font-mono text-xs" readOnly value={webhookUrl} onFocus={(e) => e.target.select()} aria-label="URL do webhook" />
              <button type="button" className="btn-secondary shrink-0" onClick={() => void copy()}>{copied ? "Copiado" : "Copiar"}</button>
            </div>
          </div>
          <p className="text-xs text-zinc-500">Pedido pago online e depois cancelado é estornado automaticamente no Mercado Pago.</p>
        </aside>
      </div>

      {loaded && <SettingsForm key={g?.token_hint ?? "novo"} g={g} isOwner={isOwner} onSaved={load} />}
      <PaymentsList />
    </div>
  );
}
