"use client";
import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { usePanel } from "@/lib/panel/context";
import { Alert, Toggle } from "@/components/ui";
import { errorMessage } from "@/lib/format";
import { fmtDate, MESSAGE_STATUS } from "./shared";

type Ev = "received" | "accepted" | "ready" | "dispatched" | "completed" | "cancelled";
type Param = "nome" | "numero" | "loja" | "link" | "previsao" | "entregador" | "total" | "motivo";
type Tpl = { event: Ev; enabled: boolean; template_name: string; template_lang: string; params: Param[] };
type LogRow = { id: number; event: Ev; status: keyof typeof MESSAGE_STATUS; error: string | null; phone: string; created_at: string;
  sent_at: string | null; order_number: number | null; customer: string | null };
type Overview = { wa_enabled: boolean; status_enabled: boolean; templates: Tpl[];
  stats: { sent: number; read: number; failed: number; queued: number }; log: LogRow[] };

const PARAMS: Record<Param, string> = {
  nome: "Nome", numero: "Nº do pedido", loja: "Loja", link: "Link de acompanhamento", previsao: "Previsão",
  entregador: "Entregador", total: "Total", motivo: "Motivo do cancelamento",
};
const EVENTS: { ev: Ev; label: string; when: string; params: Param[]; text: string }[] = [
  { ev: "received", label: "Pedido recebido", when: "Assim que o pedido chega (Pix/cartão: quando o pagamento é confirmado).",
    params: ["nome", "numero", "link"], text: "Olá, {{1}}! Recebemos seu pedido #{{2}}. Acompanhe por aqui: {{3}}" },
  { ev: "accepted", label: "Em preparo", when: "Quando a loja aceita o pedido.",
    params: ["nome", "numero", "previsao"], text: "{{1}}, seu pedido #{{2}} foi aceito e já está em preparo. Previsão: {{3}}." },
  { ev: "ready", label: "Pronto para retirada", when: "Pedidos de retirada, quando ficam prontos.",
    params: ["nome", "numero", "loja"], text: "{{1}}, seu pedido #{{2}} está pronto para retirada na {{3}}." },
  { ev: "dispatched", label: "Saiu para entrega", when: "Quando o entregador sai com o pedido.",
    params: ["nome", "numero", "entregador", "link"], text: "{{1}}, seu pedido #{{2}} saiu para entrega com {{3}}. Acompanhe: {{4}}" },
  { ev: "completed", label: "Concluído", when: "Quando o pedido é entregue ou retirado.",
    params: ["nome", "numero"], text: "{{1}}, seu pedido #{{2}} foi concluído. Obrigado pela preferência!" },
  { ev: "cancelled", label: "Cancelado", when: "Quando o pedido é cancelado.",
    params: ["nome", "numero", "motivo"], text: "{{1}}, seu pedido #{{2}} foi cancelado. Motivo: {{3}}. Qualquer dúvida, fale com a gente por aqui." },
];
const EV_LABEL = Object.fromEntries(EVENTS.map((e) => [e.ev, e.label])) as Record<Ev, string>;

function suggestedName(ev: Ev) { return `pedido_${ev === "received" ? "recebido" : ev === "accepted" ? "em_preparo" : ev === "ready" ? "pronto"
  : ev === "dispatched" ? "saiu_entrega" : ev === "completed" ? "concluido" : "cancelado"}`; }

export function StatusNotices() {
  const { tenantId } = usePanel();
  const sb = supabaseBrowser();
  const [ov, setOv] = useState<Overview | null>(null);
  const [tpls, setTpls] = useState<Tpl[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [copied, setCopied] = useState("");

  const load = useCallback(async () => {
    const { data, error } = await sb.rpc("status_overview", { p_tenant_id: tenantId });
    if (error) { setErr(errorMessage(error)); return; }
    const o = data as Overview;
    setOv(o); setEnabled(o.status_enabled);
    setTpls(EVENTS.map((e) => {
      const t = o.templates.find((x) => x.event === e.ev);
      return t ? { ...t, template_name: t.template_name ?? "", params: t.params ?? [] }
        : { event: e.ev, enabled: false, template_name: "", template_lang: "pt_BR", params: e.params };
    }));
  }, [sb, tenantId]);
  useEffect(() => { void load(); }, [load]);

  const upd = (ev: Ev, p: Partial<Tpl>) => setTpls((xs) => xs.map((x) => (x.event === ev ? { ...x, ...p } : x)));
  async function save(nextEnabled = enabled) {
    setBusy(true); setErr(""); setMsg("");
    const { error } = await sb.rpc("status_save_settings", { p_tenant_id: tenantId, p_enabled: nextEnabled,
      p_templates: tpls.map((t) => ({ event: t.event, enabled: t.enabled, template_name: t.template_name.trim() || null, template_lang: t.template_lang, params: t.params })) });
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return; }
    setMsg(nextEnabled ? "Avisos salvos e ligados." : "Avisos salvos."); await load();
  }
  async function test(ev: Ev) {
    setErr(""); setMsg("");
    const { error } = await sb.rpc("status_test", { p_tenant_id: tenantId, p_event: ev, p_phone: phone });
    if (error) { setErr(errorMessage(error)); return; }
    setMsg("Teste na fila. Em alguns segundos ele aparece no histórico abaixo (enviado ou com o erro da Meta).");
    setTimeout(() => void load(), 6000);
  }
  function copy(v: string, k: string) { void navigator.clipboard.writeText(v); setCopied(k); setTimeout(() => setCopied(""), 1500); }

  if (!ov) return <Alert>{err}</Alert>;
  return (
    <div className="space-y-4">
      <section className="card space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-2xl">
            <h2 className="font-semibold">Avisos automáticos do pedido</h2>
            <p className="mt-1 text-sm text-zinc-600">
              O cliente recebe no WhatsApp cada mudança do pedido. Só para quem marcou “receber avisos deste pedido” no cardápio
              (pedidos de marketplace e de mesa não recebem). Avisos que ficarem mais de 30 minutos na fila são descartados.
            </p>
            {!ov.wa_enabled && <p className="mt-2 text-sm font-medium text-amber-800">Conecte e ative a API oficial na aba WhatsApp para ligar os avisos.</p>}
          </div>
          <label className="flex items-center gap-2 text-sm font-medium">Ligar avisos
            <Toggle checked={enabled} label="Ligar avisos de status" onChange={(v) => { setEnabled(v); void save(v); }} />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-2 text-center text-sm sm:grid-cols-4">
          {[["Enviados (30 dias)", ov.stats.sent], ["Lidos", ov.stats.read], ["Falharam", ov.stats.failed], ["Na fila", ov.stats.queued]].map(([l, v]) => (
            <div key={l as string} className="rounded-xl bg-zinc-50 p-2"><p className="text-lg font-semibold">{v as number}</p><p className="text-xs text-zinc-500">{l}</p></div>
          ))}
        </div>
        <Alert>{err}</Alert>
        <Alert kind="success">{msg}</Alert>
      </section>

      <section className="card space-y-1">
        <h2 className="font-semibold">Modelos de mensagem</h2>
        <p className="text-sm text-zinc-600">
          A Meta só deixa a loja iniciar conversa com modelos aprovados. Crie cada um no Gerenciador do WhatsApp na categoria <b>Utilidade</b>,
          com o texto sugerido (pode adaptar), e escreva aqui o nome exato. As variáveis {"{{1}}, {{2}}…"} são preenchidas na ordem abaixo.
        </p>
        <div className="flex flex-wrap items-center gap-2 pt-2 text-sm">
          <span className="text-zinc-600">Número para testes:</span>
          <input className="input w-48" inputMode="tel" placeholder="(31) 99999-9999" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
      </section>

      {EVENTS.map((e) => {
        const t = tpls.find((x) => x.event === e.ev)!;
        const avail = (Object.keys(PARAMS) as Param[]).filter((p) => !t.params.includes(p));
        return (
          <section key={e.ev} className="card space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div><h3 className="font-semibold">{e.label}</h3><p className="text-sm text-zinc-500">{e.when}</p></div>
              <Toggle checked={t.enabled} label={`Ativar aviso ${e.label}`} onChange={(v) => upd(e.ev, { enabled: v })} />
            </div>
            <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
              <label className="block"><span className="label">Nome do modelo aprovado</span>
                <input className="input font-mono" placeholder={suggestedName(e.ev)} value={t.template_name}
                  onChange={(x) => upd(e.ev, { template_name: x.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "") })} /></label>
              <label className="block"><span className="label">Idioma</span>
                <input className="input font-mono" value={t.template_lang} onChange={(x) => upd(e.ev, { template_lang: x.target.value })} /></label>
            </div>
            <div>
              <span className="label">Variáveis, na ordem</span>
              <div className="flex flex-wrap items-center gap-1.5">
                {t.params.map((p, i) => (
                  <span key={p} className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-800">
                    {`{{${i + 1}}}`} {PARAMS[p]}
                    <button type="button" aria-label={`Remover ${PARAMS[p]}`} className="text-brand-600 hover:text-brand-900"
                      onClick={() => upd(e.ev, { params: t.params.filter((x) => x !== p) })}>×</button>
                  </span>
                ))}
                {avail.length > 0 && (
                  <select className="input w-auto py-1 text-xs" value="" aria-label="Adicionar variável"
                    onChange={(x) => x.target.value && upd(e.ev, { params: [...t.params, x.target.value as Param] })}>
                    <option value="">+ variável</option>
                    {avail.map((p) => <option key={p} value={p}>{PARAMS[p]}</option>)}
                  </select>
                )}
              </div>
            </div>
            <div className="rounded-xl bg-zinc-50 p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">Texto sugerido para a Meta</span>
                <button type="button" className="text-xs font-medium text-brand-700 hover:underline" onClick={() => copy(e.text, e.ev)}>{copied === e.ev ? "Copiado!" : "Copiar"}</button>
              </div>
              <p className="mt-1 text-zinc-700">{e.text}</p>
              <p className="mt-1 text-xs text-zinc-500">Variáveis do texto sugerido: {e.params.map((p) => PARAMS[p]).join(", ")}.</p>
            </div>
            <div className="flex justify-end">
              <button className="btn-secondary" disabled={!ov.wa_enabled || !t.template_name || phone.replace(/\D/g, "").length < 10}
                title="Salve antes de testar" onClick={() => void test(e.ev)}>Enviar teste</button>
            </div>
          </section>
        );
      })}

      <div className="flex justify-end"><button className="btn-primary" disabled={busy} onClick={() => void save()}>{busy ? "Salvando..." : "Salvar modelos"}</button></div>

      <section className="card">
        <h2 className="mb-3 font-semibold">Últimos avisos</h2>
        {ov.log.length === 0 ? <p className="text-sm text-zinc-500">Nenhum aviso enviado ainda.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-zinc-500"><tr><th className="py-1.5">Quando</th><th>Pedido</th><th>Aviso</th><th>Situação</th></tr></thead>
              <tbody className="divide-y divide-zinc-100">
                {ov.log.map((r) => (
                  <tr key={r.id} className="align-top">
                    <td className="py-2 pr-3 whitespace-nowrap">{fmtDate(r.created_at)}</td>
                    <td className="pr-3">{r.order_number ? `#${r.order_number} · ${r.customer ?? ""}` : <span className="text-zinc-500">Teste · {r.phone}</span>}</td>
                    <td className="pr-3">{EV_LABEL[r.event] ?? r.event}</td>
                    <td>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${MESSAGE_STATUS[r.status]?.cls ?? ""}`}>{r.status === "skipped" ? "Descartado" : MESSAGE_STATUS[r.status]?.label ?? r.status}</span>
                      {r.error && <p className="mt-1 max-w-sm text-xs text-red-700">{r.error}</p>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
