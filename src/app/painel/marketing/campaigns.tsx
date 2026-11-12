"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { usePanel } from "@/lib/panel/context";
import { Alert, Empty, Field, Modal } from "@/components/ui";
import { brl, errorMessage, formatPhone } from "@/lib/format";
import { MessageEditor, blankMessage, messagePayload, type MessageForm } from "./editor";
import { CAMPAIGN_STATUS, MESSAGE_STATUS, SEGMENT_LABEL, fmtDate, segmentText, type Campaign, type Message, type Segment, type Stats } from "./shared";

export function Campaigns({ apiReady, initialSeg }: { apiReady: boolean; initialSeg?: Segment | null }) {
  const { tenantId } = usePanel();
  const sb = supabaseBrowser();
  const [rows, setRows] = useState<Campaign[]>([]);
  const [stats, setStats] = useState<Record<string, Stats>>({});
  const [err, setErr] = useState("");
  const [creating, setCreating] = useState(!!initialSeg);
  const [detail, setDetail] = useState<Campaign | null>(null);
  const load = useCallback(async () => {
    const [a, b] = await Promise.all([
      sb.from("campaigns").select("*").eq("tenant_id", tenantId).eq("kind", "manual").order("created_at", { ascending: false }).limit(100),
      sb.rpc("campaign_stats", { p_tenant_id: tenantId }),
    ]);
    if (a.error) setErr(errorMessage(a.error)); else setRows(a.data as Campaign[]);
    if (!b.error) setStats((b.data ?? {}) as Record<string, Stats>);
  }, [sb, tenantId]);
  useEffect(() => { void load(); }, [load]);

  async function launch(c: Campaign) {
    if (!confirm(`Disparar "${c.name}"? As mensagens serão geradas para o público atual.`)) return;
    setErr("");
    const { data, error } = await sb.rpc("campaign_launch", { p_id: c.id });
    if (error) { setErr(errorMessage(error)); return; }
    await load();
    alert(`${(data as { messages: number }).messages} mensagem(ns) prontas.` + (c.channel === "manual_links" ? " Abra a campanha para enviar pelo WhatsApp." : " O envio começa em instantes."));
    setDetail({ ...c, status: c.channel === "manual_links" ? "done" : "sending" });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-zinc-600">Campanhas avulsas: escolha um público, escreva a mensagem e dispare.</p>
        <button className="btn-primary" onClick={() => setCreating(true)}>+ Nova campanha</button>
      </div>
      <Alert>{err}</Alert>
      {rows.length === 0 ? <Empty>Nenhuma campanha ainda. Que tal chamar de volta quem não pede há 30 dias?</Empty> : (
        <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              <tr><th className="p-3">Campanha</th><th className="p-3">Público</th><th className="p-3">Envio</th><th className="p-3">Status</th><th className="p-3 text-right">Enviadas</th><th className="p-3 text-right">Pediram de novo</th><th /></tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {rows.map((c) => {
                const s = stats[c.id];
                return (
                  <tr key={c.id}>
                    <td className="p-3 font-medium">{c.name}<span className="block text-xs text-zinc-500">{fmtDate(c.launched_at ?? c.created_at)}</span></td>
                    <td className="p-3">{segmentText(c.segment)}</td>
                    <td className="p-3">{c.channel === "whatsapp_api" ? "API do WhatsApp" : "Manual"}</td>
                    <td className="p-3"><span className={`badge ${CAMPAIGN_STATUS[c.status].cls}`}>{CAMPAIGN_STATUS[c.status].label}</span></td>
                    <td className="p-3 text-right tabular-nums">{s ? `${s.sent}/${s.total}` : "—"}{s && s.read > 0 ? <span className="block text-xs text-zinc-500">{s.read} lida(s)</span> : null}</td>
                    <td className="p-3 text-right tabular-nums">{s ? s.converted : "—"}{s && s.revenue_cents > 0 ? <span className="block text-xs text-green-700">{brl(s.revenue_cents)}</span> : null}</td>
                    <td className="whitespace-nowrap p-3 text-right">
                      {c.status === "draft" ? <button className="btn-primary" onClick={() => void launch(c)}>Disparar</button>
                        : <button className="btn-secondary" onClick={() => setDetail(c)}>Abrir</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {creating && <NewCampaign apiReady={apiReady} initialSeg={initialSeg} onClose={() => setCreating(false)} onSaved={async () => { setCreating(false); await load(); }} />}
      {detail && <CampaignDetail campaign={detail} stats={stats[detail.id]} onClose={() => setDetail(null)} onChanged={load} />}
    </div>
  );
}

function NewCampaign({ apiReady, onClose, onSaved, initialSeg }: { apiReady: boolean; onClose: () => void; onSaved: () => Promise<void>; initialSeg?: Segment | null }) {
  const { tenantId, unit } = usePanel();
  const sb = supabaseBrowser();
  const [name, setName] = useState("");
  const [seg, setSeg] = useState<Segment>(initialSeg ?? { type: "inactive", days: 30 });
  const [saved, setSaved] = useState<{ id: string; name: string; filter: Record<string, unknown> }[]>([]);
  useEffect(() => {
    sb.rpc("crm_options", { p_tenant_id: tenantId }).then(({ data }: { data: { segments?: { id: string; name: string; filter: Record<string, unknown> }[] } | null }) => setSaved(data?.segments ?? []));
  }, [sb, tenantId]);
  const [f, setF] = useState<MessageForm>(blankMessage());
  const [count, setCount] = useState<{ eligible: number; opted_in: number; total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const segKey = JSON.stringify(seg);
  useEffect(() => {
    let alive = true;
    const t = setTimeout(async () => {
      const { data } = await sb.rpc("campaign_audience_count", { p_tenant_id: tenantId, p_segment: seg });
      if (alive && data) setCount(data as { eligible: number; opted_in: number; total: number });
    }, 300);
    return () => { alive = false; clearTimeout(t); };
  }, [segKey]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr("");
    const { error } = await sb.rpc("campaign_save", { p_id: null, p_tenant_id: tenantId,
      p: { name: name.trim(), kind: "manual", segment: seg, unit_id: unit.id, ...messagePayload(f) } });
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return; }
    await onSaved();
  }
  const types = useMemo(() => (["inactive", "new", "top", "birthday_month", "all", ...(saved.length || seg.type === "crm" ? ["crm" as const] : [])] as const), [saved.length, seg.type]);

  return (
    <Modal open onClose={onClose} title="Nova campanha" wide>
      <form onSubmit={save} className="space-y-4">
        <Field label="Nome da campanha (só para você)"><input className="input" required minLength={2} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Volta logo — novembro" /></Field>
        <div className="rounded-lg border border-zinc-200 p-3">
          <p className="mb-2 text-sm font-medium">Público</p>
          <div className="flex flex-wrap gap-2 text-sm">
            {types.map((t) => (
              <label key={t} className={`cursor-pointer rounded-lg border px-3 py-1.5 ${seg.type === t ? "border-brand-500 bg-brand-50 text-brand-700" : "border-zinc-200"}`}>
                <input type="radio" className="sr-only" checked={seg.type === t}
                  onChange={() => setSeg(t === "inactive" ? { type: t, days: 30 } : t === "new" ? { type: t, days: 30 } : t === "top" ? { type: t, min_orders: 5 }
                    : t === "crm" ? (seg.type === "crm" ? seg : { type: t, name: saved[0]?.name, filter: saved[0]?.filter ?? {} }) : { type: t })} />
                {SEGMENT_LABEL[t]}
              </label>
            ))}
          </div>
          {(seg.type === "inactive" || seg.type === "new") && (
            <div className="mt-3 w-48"><Field label={seg.type === "inactive" ? "Sem pedir há (dias)" : "1º pedido nos últimos (dias)"}>
              <input className="input" type="number" min={1} max={365} value={seg.days ?? 30} onChange={(e) => setSeg({ ...seg, days: Number(e.target.value) || 30 })} />
            </Field></div>
          )}
          {seg.type === "crm" && (
            <div className="mt-3 max-w-sm"><Field label="Filtro salvo no CRM" hint="Crie e salve filtros em Clientes. Só recebe quem autorizou marketing.">
              <select className="input" value={saved.find((x) => x.name === seg.name)?.id ?? ""} onChange={(e) => {
                const x = saved.find((y) => y.id === e.target.value); if (x) setSeg({ type: "crm", name: x.name, filter: x.filter });
              }}>
                {!saved.some((x) => x.name === seg.name) && <option value="">{seg.name ?? "Filtro atual do CRM"}</option>}
                {saved.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </Field></div>
          )}
          {seg.type === "top" && (
            <div className="mt-3 w-48"><Field label="Mínimo de pedidos">
              <input className="input" type="number" min={2} max={500} value={seg.min_orders ?? 5} onChange={(e) => setSeg({ ...seg, min_orders: Number(e.target.value) || 5 })} />
            </Field></div>
          )}
          {count && (
            <p className="mt-3 text-sm"><b className="tabular-nums">{count.eligible}</b> cliente(s) vão receber · {count.opted_in} autorizaram marketing de {count.total} no total.
              <span className="block text-xs text-zinc-500">Ficam de fora quem não autorizou, quem pediu para sair e quem recebeu mensagem recentemente.</span></p>
          )}
        </div>
        <MessageEditor f={f} set={(p) => setF((x) => ({ ...x, ...p }))} kind="manual" store={unit.name} slug={unit.slug} apiReady={apiReady} />
        <Alert>{err}</Alert>
        <div className="flex gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancelar</button>
          <button className="btn-primary flex-1" disabled={busy}>{busy ? "Salvando..." : "Salvar rascunho"}</button>
        </div>
        <p className="text-xs text-zinc-500">Depois de salvar, clique em “Disparar” na lista. Os cupons são criados no disparo.</p>
      </form>
    </Modal>
  );
}

export function CampaignDetail({ campaign, stats, onClose, onChanged }: { campaign: Campaign; stats?: Stats; onClose: () => void; onChanged?: () => Promise<void> | void }) {
  const sb = supabaseBrowser();
  const [rows, setRows] = useState<Message[]>([]);
  const [filter, setFilter] = useState<"pending" | "all">("pending");
  const [err, setErr] = useState("");
  const load = useCallback(async () => {
    const { data, error } = await sb.from("campaign_messages").select("id, campaign_id, customer_id, phone, body, coupon_code, status, error, sent_at, converted_order_id, created_at, customers(name)")
      .eq("campaign_id", campaign.id).order("id").limit(2000);
    if (error) setErr(errorMessage(error)); else setRows(data as unknown as Message[]);
  }, [sb, campaign.id]);
  useEffect(() => { void load(); }, [load]);

  async function mark(m: Message, done: boolean) {
    const { error } = await sb.rpc("campaign_message_mark", { p_message_id: m.id, p_done: done });
    if (error) { setErr(errorMessage(error)); return; }
    setRows((rs) => rs.map((r) => (r.id === m.id ? { ...r, status: done ? "manual_done" : "skipped", sent_at: done ? new Date().toISOString() : null } : r)));
    void onChanged?.();
  }
  function openWa(m: Message) {
    window.open(`https://wa.me/${m.phone}?text=${encodeURIComponent(m.body)}`, "_blank", "noopener,noreferrer");
    void mark(m, true);
  }
  const pending = rows.filter((r) => r.status === "manual_pending");
  const done = rows.filter((r) => ["manual_done", "sent", "delivered", "read"].includes(r.status)).length;
  const shown = filter === "pending" ? (pending.length ? pending : rows) : rows;
  const converted = rows.filter((r) => r.converted_order_id).length;

  return (
    <Modal open onClose={onClose} title={campaign.name} wide>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="font-medium">{done} de {rows.length} enviada(s)</span>
          <span className="text-zinc-500">· {converted} pediram de novo{stats?.revenue_cents ? ` (${brl(stats.revenue_cents)})` : ""}</span>
          <div className="ml-auto flex rounded-lg bg-zinc-100 p-0.5 text-xs font-medium">
            {(["pending", "all"] as const).map((k) => (
              <button key={k} type="button" onClick={() => setFilter(k)} className={`rounded-md px-2.5 py-1 ${filter === k ? "bg-white shadow-sm" : "text-zinc-500"}`}>{k === "pending" ? "A enviar" : "Todas"}</button>
            ))}
          </div>
        </div>
        {rows.length > 0 && <div className="h-1.5 overflow-hidden rounded bg-zinc-100"><div className="h-full bg-green-500" style={{ width: `${(done / rows.length) * 100}%` }} /></div>}
        {campaign.channel === "manual_links" && pending.length > 0 && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">Clique em “Abrir no WhatsApp”, envie a mensagem e volte aqui para a próxima. Ela já fica marcada como enviada.</p>
        )}
        <Alert>{err}</Alert>
        {rows.length === 0 ? <Empty>Nenhuma mensagem ainda.</Empty> : (
          <ul className="max-h-[55vh] divide-y divide-zinc-100 overflow-y-auto rounded-lg border border-zinc-200">
            {shown.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-3 p-3 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{m.customers?.name ?? "Cliente"} <span className="font-normal text-zinc-500">· {formatPhone(m.phone.replace(/^55/, ""))}</span></p>
                  <p className="truncate text-xs text-zinc-500">{m.body}</p>
                  {m.coupon_code && <p className="text-xs">Cupom: <span className="font-mono">{m.coupon_code}</span></p>}
                  {m.error && <p className="text-xs text-red-700">{m.error}</p>}
                </div>
                <span className={`badge ${MESSAGE_STATUS[m.status].cls}`}>{MESSAGE_STATUS[m.status].label}</span>
                {m.converted_order_id && <span className="badge bg-green-100 text-green-800">Pediu</span>}
                {m.status === "manual_pending" && (
                  <span className="flex gap-1">
                    <button className="btn-success" onClick={() => openWa(m)}>Abrir no WhatsApp</button>
                    <button className="btn-ghost" onClick={() => void mark(m, false)}>Pular</button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
