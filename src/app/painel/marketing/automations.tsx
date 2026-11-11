"use client";
import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { usePanel } from "@/lib/panel/context";
import { Alert, Field, Toggle } from "@/components/ui";
import { brl, errorMessage } from "@/lib/format";
import { MessageEditor, blankMessage, fromCents, messagePayload, type MessageForm } from "./editor";
import type { Campaign, Stats } from "./shared";
import { CampaignDetail } from "./campaigns";

type Kind = "birthday" | "winback";
const DEFAULTS: Record<Kind, { name: string; title: string; text: string; message: string }> = {
  birthday: { name: "Aniversário", title: "Aniversário",
    text: "Todo dia, por volta das 10h, quem faz aniversário recebe uma mensagem (uma vez por ano). Vale para quem informou a data de nascimento no pedido.",
    message: "Feliz aniversário, {nome}! 🎉 A {loja} preparou um presente: use o cupom {cupom} no seu pedido. {link}" },
  winback: { name: "Sentimos sua falta", title: "Sentimos sua falta",
    text: "Todo dia, por volta das 10h, quem não pede há X dias recebe uma mensagem (no máximo uma por mês).",
    message: "Oi, {nome}! Faz tempo que você não pede na {loja}. Que tal hoje? Use o cupom {cupom}: {link}" },
};

export function Automations({ apiReady, freqDays }: { apiReady: boolean; freqDays: number }) {
  const { tenantId } = usePanel();
  const sb = supabaseBrowser();
  const [rows, setRows] = useState<Campaign[]>([]);
  const [stats, setStats] = useState<Record<string, Stats>>({});
  const [loaded, setLoaded] = useState(false);
  const load = useCallback(async () => {
    const [a, b] = await Promise.all([
      sb.from("campaigns").select("*").eq("tenant_id", tenantId).in("kind", ["birthday", "winback"]),
      sb.rpc("campaign_stats", { p_tenant_id: tenantId }),
    ]);
    setRows((a.data ?? []) as Campaign[]); if (!b.error) setStats((b.data ?? {}) as Record<string, Stats>); setLoaded(true);
  }, [sb, tenantId]);
  useEffect(() => { void load(); }, [load]);
  if (!loaded) return null;
  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-600">As automações só falam com clientes que autorizaram marketing, e cada cliente recebe no máximo uma mensagem a cada {freqDays} dia(s), somando campanhas e automações.</p>
      <div className="grid gap-4 xl:grid-cols-2">
        {(["birthday", "winback"] as Kind[]).map((k) => (
          <AutomationCard key={k} kind={k} row={rows.find((r) => r.kind === k) ?? null} stats={stats[rows.find((r) => r.kind === k)?.id ?? ""]} apiReady={apiReady} onSaved={load} />
        ))}
      </div>
    </div>
  );
}

function AutomationCard({ kind, row, stats, apiReady, onSaved }: { kind: Kind; row: Campaign | null; stats?: Stats; apiReady: boolean; onSaved: () => Promise<void> }) {
  const { tenantId, unit } = usePanel();
  const sb = supabaseBrowser();
  const d = DEFAULTS[kind];
  const [active, setActive] = useState(row?.status === "active");
  const [days, setDays] = useState(String(row?.segment?.days ?? 30));
  const [f, setF] = useState<MessageForm>(() => row ? {
    message: row.message, channel: row.channel, template_name: row.template_name ?? "", template_lang: row.template_lang, template_params: row.template_params,
    coupon_mode: row.coupon_mode, coupon_kind: row.coupon_kind, coupon_value: row.coupon_kind === "fixed" ? fromCents(row.coupon_value) : String(row.coupon_value),
    coupon_min: row.coupon_min_order_cents ? fromCents(row.coupon_min_order_cents) : "", coupon_valid_days: String(row.coupon_valid_days),
  } : { ...blankMessage(d.message), coupon_mode: "unique", coupon_kind: kind === "birthday" ? "free_delivery" : "percent", coupon_value: "10" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [open, setOpen] = useState(false);

  async function save(nextActive = active) {
    setBusy(true); setErr(""); setMsg("");
    const segment = kind === "birthday" ? { type: "birthday_today" } : { type: "inactive", days: Math.max(7, Number(days) || 30) };
    const { error } = await sb.rpc("campaign_save", { p_id: row?.id ?? null, p_tenant_id: tenantId,
      p: { name: d.name, kind, segment, unit_id: unit.id, active: nextActive, ...messagePayload(f) } });
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return; }
    setActive(nextActive);
    setMsg(nextActive ? "Automação ativa. Roda todo dia por volta das 10h." : "Salvo. A automação está desligada.");
    await onSaved();
  }

  return (
    <section className="card space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">{d.title}</h2>
          <p className="mt-0.5 text-sm text-zinc-500">{d.text}</p>
          {row?.status === "paused" && row && !active && <p className="mt-1 text-xs text-amber-700">Pausada. Se você não desligou, confira a configuração (ex.: API do WhatsApp sem modelo).</p>}
        </div>
        <label className="flex shrink-0 items-center gap-2 text-sm font-medium">Ativa
          <Toggle checked={active} label={`Ativar ${d.title}`} onChange={(v) => { if (!busy) void save(v); }} />
        </label>
      </div>
      {stats && (
        <p className="rounded-lg bg-zinc-50 px-3 py-2 text-sm text-zinc-700">{stats.sent} enviada(s) · {stats.pending} pendente(s) · {stats.converted} pediram de novo
          {stats.revenue_cents > 0 && <> ({brl(stats.revenue_cents)})</>}</p>
      )}
      {kind === "winback" && (
        <Field label="Considerar sumido após (dias sem pedir)"><input className="input w-32" type="number" min={7} max={365} value={days} onChange={(e) => setDays(e.target.value)} /></Field>
      )}
      <MessageEditor f={f} set={(p) => setF((x) => ({ ...x, ...p }))} kind={kind} store={unit.name} slug={unit.slug} apiReady={apiReady} />
      {f.channel === "manual_links" && <p className="text-xs text-zinc-500">No modo manual, as mensagens do dia ficam prontas para você enviar pelo WhatsApp da loja em “Mensagens para enviar”.</p>}
      <Alert>{err}</Alert>
      <Alert kind="success">{msg}</Alert>
      <div className="flex flex-wrap gap-2">
        <button className="btn-primary" disabled={busy} onClick={() => void save()}>{busy ? "Salvando..." : "Salvar"}</button>
        {row && <button className="btn-secondary" onClick={() => setOpen(true)}>Mensagens para enviar{stats?.pending ? ` (${stats.pending})` : ""}</button>}
      </div>
      {open && row && <CampaignDetail campaign={row} stats={stats} onClose={() => setOpen(false)} onChanged={onSaved} />}
    </section>
  );
}
