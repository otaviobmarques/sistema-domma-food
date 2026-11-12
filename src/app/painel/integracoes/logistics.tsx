"use client";
import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { usePanel } from "@/lib/panel/context";
import { Alert, Field, Toggle } from "@/components/ui";
import { errorMessage } from "@/lib/format";

export type LogisticsOverview = {
  can_manage: boolean; unit_has_address: boolean; unit_has_location: boolean; return_to_merchant: boolean;
  foody: { enabled: boolean; base_url: string | null; client_id: string | null; has_secret: boolean; hook_token: string | null;
    last_test_at: string | null; last_test_ok: boolean | null; last_test_message: string | null };
  ifood: { enabled: boolean; connected: boolean; merchant_name: string | null };
};

export function LogisticsCard() {
  const { unit } = usePanel();
  const sb = supabaseBrowser();
  const [ov, setOv] = useState<LogisticsOverview | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await sb.rpc("logistics_overview", { p_unit_id: unit.id });
    if (error) { setErr(errorMessage(error)); return; }
    const o = data as LogisticsOverview;
    setOv(o); setBaseUrl(o.foody.base_url ?? ""); setClientId(o.foody.client_id ?? "");
  }, [sb, unit.id]);
  useEffect(() => { void load(); }, [load]);

  async function save(p: Record<string, unknown>, ok: string) {
    setBusy("save"); setErr(""); setMsg("");
    const { error } = await sb.rpc("logistics_save", { p_unit_id: unit.id, p });
    setBusy("");
    if (error) { setErr(errorMessage(error)); return false; }
    setMsg(ok); setSecret(""); await load(); return true;
  }
  async function test() {
    setBusy("test"); setErr(""); setMsg("");
    const { data, error } = await sb.functions.invoke("logistics/test", { body: { unit_id: unit.id } });
    setBusy("");
    if (error) {
      let m = errorMessage(error);
      try { const b = await (error as { context?: Response }).context?.json(); if (b?.error) m = b.error; } catch { /* sem corpo */ }
      setErr(m); return;
    }
    if (data?.ok) setMsg(data.message); else setErr(data?.message ?? "Falhou.");
    await load();
  }

  if (!ov || !ov.can_manage) return null;
  const hook = ov.foody.hook_token ? `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/logistics/webhook?h=${ov.foody.hook_token}` : "";
  return (
    <section className="card space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Logística: chamar entregador</h2>
        <p className="mt-1 text-sm text-zinc-600">
          Para pedidos de entrega de qualquer canal (cardápio, WhatsApp, balcão), chame um entregador da Foody Delivery ou da Entrega iFood
          direto na tela de Pedidos, com preço e prazo antes de confirmar. O pedido muda para &quot;saiu para entrega&quot; e &quot;concluído&quot; sozinho.
        </p>
        {!ov.unit_has_address && <Alert>Cadastre o endereço completo da loja em Configurações: ele é o ponto de coleta.</Alert>}
      </div>

      <div className="rounded-xl border border-zinc-200 p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold">Foody Delivery</h3>
            <p className="text-xs text-zinc-500">Padrão Open Delivery. Na Foody: Menu › Minha conta › APIs e Hooks › Criar credencial (tipo Open Delivery).</p>
          </div>
          <Toggle checked={ov.foody.enabled} label="Ligada" onChange={(v) => void save({ foody_enabled: v }, v ? "Foody ligada." : "Foody desligada.")} />
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <Field label="baseUrl"><input className="input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://..." /></Field>
          <Field label="clientId"><input className="input" value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" /></Field>
          <Field label="clientSecret" hint={ov.foody.has_secret ? "Já salvo. Preencha só para trocar." : undefined}>
            <input className="input" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="new-password" placeholder={ov.foody.has_secret ? "••••••••" : ""} />
          </Field>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button className="btn-primary" disabled={busy !== ""} onClick={() => void save({ foody_base_url: baseUrl, foody_client_id: clientId, ...(secret ? { foody_client_secret: secret } : {}) }, "Credencial salva.")}>
            {busy === "save" ? "Salvando..." : "Salvar"}</button>
          <button className="btn-secondary" disabled={busy !== "" || !ov.foody.has_secret} onClick={() => void test()}>{busy === "test" ? "Testando..." : "Testar credencial"}</button>
        </div>
        {ov.foody.last_test_at && (
          <p className={`mt-2 text-xs ${ov.foody.last_test_ok ? "text-green-700" : "text-red-700"}`}>
            Último teste: {ov.foody.last_test_message} ({new Date(ov.foody.last_test_at).toLocaleString("pt-BR")})</p>
        )}
        {hook && (
          <div className="mt-3 rounded-lg bg-zinc-50 p-3 text-xs">
            <p className="font-medium text-zinc-700">Gatilho (webhook) para cadastrar na Foody: Minha conta › APIs e Hooks › Criar gatilho</p>
            <div className="mt-1 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-white px-2 py-1 ring-1 ring-zinc-200">{hook}</code>
              <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={async () => { try { await navigator.clipboard.writeText(hook); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignora */ } }}>
                {copied ? "Copiado ✓" : "Copiar"}</button>
            </div>
            <p className="mt-1 text-zinc-500">É ele que avisa o Domma quando o entregador aceita, coleta e entrega. Não compartilhe este endereço.</p>
          </div>
        )}
      </div>

      <div className="rounded-xl border border-zinc-200 p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold">Entrega iFood</h3>
            <p className="text-xs text-zinc-500">
              {ov.ifood.connected
                ? `Usa a conexão com o iFood (${ov.ifood.merchant_name ?? "loja conectada"}). Contrate o serviço no Portal do Parceiro do iFood.`
                : "Conecte a loja ao iFood acima para usar a Entrega iFood."}
            </p>
          </div>
          <Toggle checked={ov.ifood.enabled} label="Ligada" onChange={(v) => void save({ ifood_enabled: v }, v ? "Entrega iFood ligada." : "Entrega iFood desligada.")} />
        </div>
        <p className="mt-2 text-xs text-zinc-500">
          Exige a localização (latitude e longitude) e o CEP do cliente e aceita pedido já pago ou pago na entrega em dinheiro ou cartão.
          O entregador pede ao cliente os 4 últimos dígitos do telefone na entrega.
        </p>
      </div>

      <label className="flex items-center gap-2 text-sm text-zinc-700">
        <input type="checkbox" checked={ov.return_to_merchant} onChange={(e) => void save({ return_to_merchant: e.target.checked }, "Salvo.")} />
        O entregador volta à loja depois da entrega (ex.: trazer a maquininha). Pode ter taxa de retorno.
      </label>
      <Alert>{err}</Alert>
      <Alert kind="success">{msg}</Alert>
    </section>
  );
}
