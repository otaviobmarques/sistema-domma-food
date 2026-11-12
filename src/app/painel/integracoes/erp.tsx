"use client";
import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { usePanel } from "@/lib/panel/context";
import { Alert, Field, Modal, Toggle } from "@/components/ui";
import { channelLabel } from "@/components/channel-badge";
import { errorMessage } from "@/lib/format";

type Overview = {
  fiscal_cnpj: string | null;
  f360: { enabled: boolean; url_hint: string | null; cnpj: string | null; since: string | null; last_ok_at: string | null; last_error: string | null;
    queued: number; failed: number; sent_today: number; recent: { number: number; kind: string; status: string; error: string | null; at: string }[] };
  od: { enabled: boolean; app_name: string; client_id: string | null; has_secret: boolean; channels: string[]; since: string | null;
    last_poll_at: string | null; pending_events: number };
};
const CHANNELS = ["web", "whatsapp", "totem", "table", "phone", "counter", "ifood", "99food", "keeta", "aiqfome", "marketplace"];
const OD_BASE = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/od`;
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("pt-BR") : "nunca");
const Q_STATUS: Record<string, string> = { queued: "Na fila", sending: "Enviando", sent: "Enviado", failed: "Falhou" };

function Copy({ label, value }: { label: string; value: string }) {
  const [ok, setOk] = useState(false);
  return (
    <div className="text-xs">
      <p className="font-medium text-zinc-600">{label}</p>
      <div className="mt-0.5 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded bg-white px-2 py-1 ring-1 ring-zinc-200">{value}</code>
        <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={async () => { try { await navigator.clipboard.writeText(value); setOk(true); setTimeout(() => setOk(false), 1500); } catch { /* ignora */ } }}>
          {ok ? "Copiado ✓" : "Copiar"}</button>
      </div>
    </div>
  );
}

export function ErpCard() {
  const { unit } = usePanel();
  const sb = supabaseBrowser();
  const [ov, setOv] = useState<Overview | null>(null);
  const [url, setUrl] = useState("");
  const [cnpj, setCnpj] = useState("");
  const [app, setApp] = useState("Eclética");
  const [creds, setCreds] = useState<{ client_id: string; client_secret: string; merchant_id: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    const { data, error } = await sb.rpc("erp_overview", { p_unit_id: unit.id });
    if (error) { setErr(errorMessage(error)); return; }
    const o = data as Overview;
    setOv(o); setCnpj(o.f360.cnpj ?? o.fiscal_cnpj ?? ""); setApp(o.od.app_name);
  }, [sb, unit.id]);
  useEffect(() => { void load(); }, [load]);

  async function save(p: Record<string, unknown>, ok: string) {
    setBusy(true); setErr(""); setMsg("");
    const { error } = await sb.rpc("erp_save", { p_unit_id: unit.id, p });
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return; }
    setMsg(ok); setUrl(""); await load();
  }
  async function genCreds() {
    if (ov?.od.has_secret && !confirm("Gerar um novo segredo? O PDV vai precisar do novo para continuar recebendo os pedidos.")) return;
    setBusy(true); setErr("");
    const { data, error } = await sb.rpc("erp_od_credentials", { p_unit_id: unit.id });
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return; }
    setCreds(data as { client_id: string; client_secret: string; merchant_id: string }); await load();
  }
  async function retry() {
    const { data, error } = await sb.rpc("erp_f360_retry", { p_unit_id: unit.id });
    if (error) setErr(errorMessage(error)); else { setMsg(`${data} envio(s) voltaram para a fila.`); await load(); }
  }

  if (!ov) return null;
  const f = ov.f360, o = ov.od;
  return (
    <section className="card space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Gestão: F360 Finanças e PDV (Eclética)</h2>
        <p className="mt-1 text-sm text-zinc-600">Leve as vendas do Domma para o financeiro e para o PDV da loja sem digitar nada.</p>
      </div>

      <div className="rounded-xl border border-zinc-200 p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold">F360 Finanças</h3>
            <p className="text-xs text-zinc-500">Cada pedido concluído vira um cupom no F360 (formas de pagamento e frete), para o fluxo de caixa e a conciliação. Cancelamentos também vão.</p>
          </div>
          <Toggle checked={f.enabled} label="Ligado" onChange={(v) => void save({ f360_enabled: v }, v ? "F360 ligado: as próximas vendas concluídas serão enviadas." : "F360 desligado.")} />
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-[2fr_1fr]">
          <Field label="URL do Webhook F360 - PDV" hint={f.url_hint ? `Salva: ${f.url_hint}. Cole de novo só para trocar.` : "No F360: Webservices › Novo › Webhook F360 - PDV; a URL aparece na coluna Outros."}>
            <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://webhook.f360.com.br/..." autoComplete="off" />
          </Field>
          <Field label="CNPJ da loja no F360" hint={ov.fiscal_cnpj && !f.cnpj ? "Preenchido com o CNPJ da Nota fiscal." : undefined}>
            <input className="input" inputMode="numeric" value={cnpj} onChange={(e) => setCnpj(e.target.value)} placeholder="00.000.000/0000-00" />
          </Field>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button className="btn-primary" disabled={busy} onClick={() => void save({ ...(url ? { f360_url: url } : {}), f360_cnpj: cnpj }, "Dados do F360 salvos.")}>Salvar</button>
          {f.failed > 0 && <button className="btn-secondary" onClick={() => void retry()}>Reenviar {f.failed} com falha</button>}
          <span className="text-xs text-zinc-500">Enviados nas últimas 24 h: {f.sent_today} · Na fila: {f.queued}{f.last_ok_at ? ` · Último envio: ${fmt(f.last_ok_at)}` : ""}</span>
        </div>
        {f.last_error && <p className="mt-2 text-xs text-red-700">Último erro: {f.last_error}</p>}
        {f.recent.length > 0 && (
          <ul className="mt-2 space-y-0.5 text-xs text-zinc-600">
            {f.recent.slice(0, 5).map((r, i) => <li key={i}>#{r.number} · {r.kind === "cancel" ? "Cancelamento" : "Venda"} · {Q_STATUS[r.status] ?? r.status} · {fmt(r.at)}{r.error ? ` · ${r.error}` : ""}</li>)}
          </ul>
        )}
        <p className="mt-2 text-[11px] text-zinc-500">O F360 processa em até 1 hora; confira em Upload de Arquivos no F360. O CNPJ precisa estar cadastrado lá.</p>
      </div>

      <div className="rounded-xl border border-zinc-200 p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold">PDV pelo Open Delivery ({o.app_name})</h3>
            <p className="text-xs text-zinc-500">
              A Eclética (e outros PDVs aderentes ao Open Delivery) busca os pedidos do Domma e devolve confirmação, preparo, saída e entrega.
              Envie as credenciais abaixo ao time da Eclética para concluir o vínculo.
            </p>
          </div>
          <Toggle checked={o.enabled} label="Ligado" onChange={(v) => void save({ od_enabled: v }, v ? "Open Delivery ligado: os próximos pedidos vão para o PDV." : "Open Delivery desligado.")} />
        </div>
        <div className="mt-3 space-y-2 rounded-lg bg-zinc-50 p-3">
          <Copy label="Base URL (Ordering Application)" value={OD_BASE} />
          <Copy label="merchantId" value={unit.id} />
          {o.client_id && <Copy label="clientId" value={o.client_id} />}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button className="btn-secondary" disabled={busy} onClick={() => void genCreds()}>{o.has_secret ? "Gerar novo segredo" : "Gerar credenciais"}</button>
            <span className="text-xs text-zinc-500">
              {o.last_poll_at ? `Último acesso do PDV: ${fmt(o.last_poll_at)}` : "O PDV ainda não acessou."} · Eventos aguardando: {o.pending_events}
            </span>
          </div>
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-[1fr_2fr]">
          <Field label="Nome do PDV"><input className="input" value={app} maxLength={40} onChange={(e) => setApp(e.target.value)} onBlur={() => app !== o.app_name && void save({ od_app_name: app }, "Salvo.")} /></Field>
          <div>
            <p className="label">Canais enviados ao PDV</p>
            <div className="flex flex-wrap gap-1.5">
              {CHANNELS.map((c) => {
                const on = o.channels.includes(c);
                return (
                  <button key={c} type="button" aria-pressed={on} onClick={() => void save({ od_channels: on ? o.channels.filter((x) => x !== c) : [...o.channels, c] }, "Canais salvos.")}
                    className={`rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${on ? "bg-brand-600 text-white ring-brand-600" : "bg-white text-zinc-700 ring-zinc-200"}`}>{channelLabel(c)}</button>
                );
              })}
            </div>
            <p className="mt-1 text-[11px] text-zinc-500">Deixe marketplaces de fora se o PDV já recebe o iFood direto (evita pedido em dobro).</p>
          </div>
        </div>
        <p className="mt-2 text-[11px] text-zinc-500">Para o PDV reconhecer cada item, preencha o &quot;Código no PDV&quot; dos produtos no Cardápio (sem ele, vai o código interno do Domma).</p>
      </div>

      <Alert>{err}</Alert>
      <Alert kind="success">{msg}</Alert>
      {creds && (
        <Modal open onClose={() => setCreds(null)} title="Credenciais do Open Delivery">
          <p className="text-sm text-zinc-600">Copie agora e envie ao time do PDV por um canal seguro. O segredo não aparece de novo.</p>
          <div className="mt-3 space-y-2 rounded-lg bg-zinc-50 p-3">
            <Copy label="Base URL" value={OD_BASE} />
            <Copy label="merchantId" value={creds.merchant_id} />
            <Copy label="clientId" value={creds.client_id} />
            <Copy label="clientSecret" value={creds.client_secret} />
          </div>
          <p className="mt-2 text-xs text-zinc-500">Token: POST {"{baseUrl}"}/oauth/token com grant_type=client_credentials. Eventos por polling em /v1/events:polling.</p>
          <div className="mt-4 flex justify-end"><button className="btn-primary" onClick={() => setCreds(null)}>Pronto</button></div>
        </Modal>
      )}
    </section>
  );
}
