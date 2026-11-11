"use client";
import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { usePanel } from "@/lib/panel/context";
import { Alert, Empty, Field, Modal } from "@/components/ui";
import { brl, errorMessage, formatPhone } from "@/lib/format";
import { MessageEditor, blankMessage, fromCents, messagePayload, type MessageForm } from "./editor";
import { MSG_STATUS, SEGMENTS, STATUS, couponLabel, segmentLabel, type Campaign, type Segment, type Stats } from "./shared";

type Msg = { id: number; phone: string; body: string; coupon_code: string | null; status: string; error: string | null;
  sent_at: string | null; converted_order_id: string | null; customers: { name: string } | null };

export function Campaigns({ apiReady, freqDays }: { apiReady: boolean; freqDays: number }) {
  const { tenantId } = usePanel();
  const sb = supabaseBrowser();
  const [list, setList] = useState<Campaign[]>([]);
  const [stats, setStats] = useState<Record<string, Stats>>({});
  const [err, setErr] = useState("");
  const [editing, setEditing] = useState<Campaign | "new" | null>(null);
  const [detail, setDetail] = useState<Campaign | null>(null);

  const load = useCallback(async () => {
    const [a, b] = await Promise.all([
      sb.from("campaigns").select("*").eq("tenant_id", tenantId).eq("kind", "manual").order("created_at", { ascending: false }).limit(100),
      sb.rpc("campaign_stats", { p_tenant_id: tenantId }),
    ]);
    if (a.error) setErr(errorMessage(a.error)); else setList(a.data as Campaign[]);
    if (!b.error) setStats((b.data ?? {}) as Record<string, Stats>);
  }, [sb, tenantId]);
  useEffect(() => { void load(); }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-zinc-600">Só recebem clientes que autorizaram marketing no pedido, no máximo uma mensagem a cada {freqDays} dia(s).</p>
        <button className="btn-primary" onClick={() => setEditing("new")}>+ Nova campanha</button>
      </div>
      <Alert>{err}</Alert>
      {list.length === 0 ? <Empty>Nenhuma campanha ainda. Comece com uma para quem não pede há 30 dias, com um cupom de volta.</Empty> : (
        <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              <tr><th className="p-3">Campanha</th><th className="p-3">Público</th><th className="p-3">Canal</th><th className="p-3">Situação</th>
                <th className="p-3 text-right">Enviadas</th><th className="p-3 text-right">Entregues / lidas</th><th className="p-3 text-right">Pediram de novo</th><th /></tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {list.map((c) => {
                const s = stats[c.id]; const st = STATUS[c.status] ?? STATUS.draft;
                return (
                  <tr key={c.id}>
                    <td className="p-3"><p className="font-medium">{c.name}</p><p className="text-xs text-zinc-500">{couponLabel(c)}</p></td>
                    <td className="p-3 text-zinc-600">{segmentLabel(c.segment)}</td>
                    <td className="p-3 text-zinc-600">{c.channel === "whatsapp_api" ? "API do WhatsApp" : "Manual"}</td>
                    <td className="p-3"><span className={`badge ${st.cls}`}>{st.label}</span></td>
                    <td className="p-3 text-right tabular-nums">{s ? `${s.sent} de ${s.total}` : "—"}</td>
                    <td className="p-3 text-right tabular-nums">{s && c.channel === "whatsapp_api" ? `${s.delivered} / ${s.read}` : "—"}</td>
                    <td className="p-3 text-right tabular-nums">{s ? <>{s.converted}{s.revenue_cents > 0 && <span className="block text-xs text-green-700">{brl(s.revenue_cents)}</span>}</> : "—"}</td>
                    <td className="whitespace-nowrap p-3 text-right">
                      {c.status === "draft" && <button className="btn-ghost" onClick={() => setEditing(c)}>Editar</button>}
                      <button className="btn-secondary" onClick={() => setDetail(c)}>{c.status === "draft" ? "Disparar" : "Abrir"}</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {editing && <CampaignEditor campaign={editing === "new" ? null : editing} apiReady={apiReady}
        onClose={() => setEditing(null)} onSaved={async (c) => { setEditing(null); await load(); setDetail(c); }} />}
      {detail && <CampaignDetail campaign={detail} stats={stats[detail.id]} onClose={() => { setDetail(null); void load(); }} onChanged={load} />}
    </div>
  );
}

function CampaignEditor({ campaign, apiReady, onClose, onSaved }: {
  campaign: Campaign | null; apiReady: boolean; onClose: () => void; onSaved: (c: Campaign) => void;
}) {
  const { tenantId, unit } = usePanel();
  const sb = supabaseBrowser();
  const [name, setName] = useState(campaign?.name ?? "");
  const [segment, setSegment] = useState<Segment>(campaign?.segment ?? { type: "inactive", days: 30 });
  const [f, setF] = useState<MessageForm>(() => campaign ? {
    message: campaign.message, channel: campaign.channel, template_name: campaign.template_name ?? "", template_lang: campaign.template_lang,
    template_params: campaign.template_params, coupon_mode: campaign.coupon_mode, coupon_kind: campaign.coupon_kind,
    coupon_value: campaign.coupon_kind === "fixed" ? fromCents(campaign.coupon_value) : String(campaign.coupon_value),
    coupon_min: campaign.coupon_min_order_cents ? fromCents(campaign.coupon_min_order_cents) : "", coupon_valid_days: String(campaign.coupon_valid_days),
  } : { ...blankMessage("Oi, {nome}! Sentimos sua falta aqui na {loja}. Use o cupom {cupom} no seu próximo pedido: {link}"), coupon_mode: "unique" });
  const [count, setCount] = useState<{ eligible: number; opted_in: number; total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const segKey = JSON.stringify(segment);
  useEffect(() => {
    let alive = true;
    const t = setTimeout(async () => {
      const { data } = await sb.rpc("campaign_audience_count", { p_tenant_id: tenantId, p_segment: segment });
      if (alive && data) setCount(data);
    }, 300);
    return () => { alive = false; clearTimeout(t); };
  }, [segKey]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr("");
    const { data, error } = await sb.rpc("campaign_save", { p_id: campaign?.id ?? null, p_tenant_id: tenantId,
      p: { name: name.trim(), kind: "manual", segment, unit_id: unit.id, ...messagePayload(f) } });
    if (error) { setBusy(false); setErr(errorMessage(error)); return; }
    const { data: row } = await sb.from("campaigns").select("*").eq("id", data as string).single();
    setBusy(false);
    onSaved(row as Campaign);
  }

  const seg = SEGMENTS.find((s) => s.type === segment.type);
  return (
    <Modal open onClose={onClose} title={campaign ? "Editar campanha" : "Nova campanha"} wide>
      <form onSubmit={save} className="space-y-4">
        <Field label="Nome da campanha (só você vê)"><input className="input" required minLength={2} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Volta logo — março" /></Field>
        <div>
          <span className="label">Público</span>
          <div className="flex flex-wrap gap-2">
            {SEGMENTS.map((s) => (
              <button key={s.type} type="button" onClick={() => setSegment({ type: s.type, days: s.type === "inactive" || s.type === "new" ? 30 : undefined, min_orders: s.type === "top" ? 5 : undefined })}
                className={`rounded-lg border px-3 py-1.5 text-sm ${segment.type === s.type ? "border-brand-500 bg-brand-50 text-brand-700" : "border-zinc-300 bg-white text-zinc-700"}`}>{s.label}</button>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-zinc-600">
            <span>{seg?.hint}</span>
            {(segment.type === "inactive" || segment.type === "new") && (
              <label className="flex items-center gap-2">dias: <input className="input w-20 py-1" type="number" min={1} max={365} value={segment.days ?? 30}
                onChange={(e) => setSegment({ ...segment, days: Math.max(1, Number(e.target.value) || 1) })} /></label>
            )}
            {segment.type === "top" && (
              <label className="flex items-center gap-2">pedidos: <input className="input w-20 py-1" type="number" min={1} max={500} value={segment.min_orders ?? 5}
                onChange={(e) => setSegment({ ...segment, min_orders: Math.max(1, Number(e.target.value) || 1) })} /></label>
            )}
          </div>
          {count && (
            <p className="mt-2 rounded-lg bg-zinc-50 px-3 py-2 text-sm">
              <b className="tabular-nums">{count.eligible}</b> cliente(s) vão receber · {count.opted_in} autorizaram marketing de {count.total} no total
            </p>
          )}
        </div>
        <MessageEditor f={f} set={(p) => setF((x) => ({ ...x, ...p }))} kind="manual" store={unit.name} slug={unit.slug} apiReady={apiReady} />
        <Alert>{err}</Alert>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancelar</button>
          <button className="btn-primary" disabled={busy}>{busy ? "Salvando..." : "Salvar rascunho"}</button>
        </div>
      </form>
    </Modal>
  );
}

export function CampaignDetail({ campaign, stats, onClose, onChanged }: { campaign: Campaign; stats?: Stats; onClose: () => void; onChanged: () => Promise<void> }) {
  const { tenantId } = usePanel();
  const sb = supabaseBrowser();
  const [c, setC] = useState(campaign);
  const [rows, setRows] = useState<Msg[]>([]);
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    const [a, b] = await Promise.all([
      sb.from("campaign_messages").select("id, phone, body, coupon_code, status, error, sent_at, converted_order_id, customers(name)")
        .eq("campaign_id", campaign.id).order("id").limit(2000),
      sb.from("campaigns").select("*").eq("id", campaign.id).single(),
    ]);
    if (a.error) setErr(errorMessage(a.error)); else setRows(a.data as unknown as Msg[]);
    if (b.data) setC(b.data as Campaign);
  }, [sb, campaign.id]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (campaign.status !== "draft") return;
    (async () => {
      const { data } = await sb.rpc("campaign_audience_count", { p_tenant_id: tenantId, p_segment: campaign.segment });
      setCount((data as { eligible?: number } | null)?.eligible ?? null);
    })();
  }, [sb, tenantId, campaign.status, campaign.segment]);

  async function launch() {
    if (!confirm(`Disparar "${c.name}" agora?${count != null ? ` ${count} cliente(s) vão receber.` : ""}`)) return;
    setBusy(true); setErr(""); setMsg("");
    const { data, error } = await sb.rpc("campaign_launch", { p_id: c.id });
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return; }
    setMsg(c.channel === "whatsapp_api" ? `${data.messages} mensagem(ns) na fila de envio. A Meta envia dentro da janela de horário configurada.`
      : `${data.messages} mensagem(ns) prontas. Envie uma por uma abaixo.`);
    await load(); await onChanged();
  }

  async function mark(m: Msg, done: boolean) {
    const { error } = await sb.rpc("campaign_message_mark", { p_message_id: m.id, p_done: done });
    if (error) setErr(errorMessage(error)); else setRows((rs) => rs.map((r) => r.id === m.id ? { ...r, status: done ? "manual_done" : "skipped", sent_at: done ? new Date().toISOString() : null } : r));
  }
  function openWa(m: Msg) {
    window.open(`https://wa.me/${m.phone}?text=${encodeURIComponent(m.body)}`, "_blank", "noopener,noreferrer");
    void mark(m, true);
  }

  const total = rows.length;
  const done = rows.filter((r) => ["manual_done", "sent", "delivered", "read"].includes(r.status)).length;
  const st = STATUS[c.status] ?? STATUS.draft;
  return (
    <Modal open onClose={onClose} title={c.name} wide>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-600">
          <span className={`badge ${st.cls}`}>{st.label}</span>
          <span>{segmentLabel(c.segment)}</span><span>·</span><span>{couponLabel(c)}</span><span>·</span>
          <span>{c.channel === "whatsapp_api" ? `API do WhatsApp (${c.template_name})` : "Manual pelo WhatsApp"}</span>
        </div>
        <Alert>{err}</Alert>
        <Alert kind="success">{msg}</Alert>
        {c.status === "draft" ? (
          <div className="rounded-lg border border-zinc-200 p-4">
            <p className="text-sm text-zinc-700">{count == null ? "Calculando o público..." : `${count} cliente(s) vão receber esta campanha agora.`}
              {c.coupon_mode === "unique" && " Um cupom de uso único será criado para cada cliente."}</p>
            <p className="mt-2 whitespace-pre-wrap rounded-lg bg-zinc-50 p-3 text-sm">{c.message}</p>
            <button className="btn-primary mt-3" disabled={busy || count === 0} onClick={launch}>{busy ? "Disparando..." : "Disparar campanha"}</button>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium">{done} de {total} enviadas{stats?.converted ? ` · ${stats.converted} pediram de novo (${brl(stats.revenue_cents)})` : ""}</p>
              <button className="btn-ghost text-sm" onClick={() => void load()}>Atualizar</button>
            </div>
            <div className="h-1.5 overflow-hidden rounded bg-zinc-100"><div className="h-full bg-green-500" style={{ width: `${total ? (done / total) * 100 : 0}%` }} /></div>
            {c.channel === "manual_links" && rows.some((r) => r.status === "manual_pending") && (
              <p className="text-xs text-zinc-500">Toque em “Abrir no WhatsApp”: a conversa abre com a mensagem pronta; é só enviar. A linha já fica marcada como enviada.</p>
            )}
            <div className="max-h-[50vh] overflow-y-auto rounded-lg border border-zinc-200">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-zinc-50 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                  <tr><th className="p-2.5">Cliente</th><th className="p-2.5">Cupom</th><th className="p-2.5">Situação</th><th /></tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {rows.map((m) => {
                    const ms = MSG_STATUS[m.status] ?? MSG_STATUS.queued;
                    return (
                      <tr key={m.id}>
                        <td className="p-2.5"><p className="font-medium">{m.customers?.name ?? "Cliente"}</p>
                          <p className="text-xs tabular-nums text-zinc-500">{formatPhone(m.phone.replace(/^55/, ""))}</p></td>
                        <td className="p-2.5 font-mono text-xs">{m.coupon_code ?? "—"}</td>
                        <td className="p-2.5"><span className={`badge ${ms.cls}`}>{ms.label}</span>
                          {m.converted_order_id && <span className="badge ml-1 bg-brand-50 text-brand-700">Pediu de novo</span>}
                          {m.error && <span className="block text-xs text-red-700">{m.error}</span>}</td>
                        <td className="whitespace-nowrap p-2.5 text-right">
                          {m.status === "manual_pending" && <>
                            <button className="btn-ghost text-xs" onClick={() => void mark(m, false)}>Pular</button>
                            <button className="btn-success text-xs" onClick={() => openWa(m)}>Abrir no WhatsApp</button>
                          </>}
                          {m.status === "skipped" && <button className="btn-ghost text-xs" onClick={() => openWa(m)}>Enviar mesmo assim</button>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
