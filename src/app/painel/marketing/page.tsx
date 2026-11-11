"use client";
import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { canManage, usePanel } from "@/lib/panel/context";
import { Alert, Empty } from "@/components/ui";
import { errorMessage } from "@/lib/format";
import { Campaigns } from "./campaigns";
import { Automations } from "./automations";
import { WhatsAppSettings } from "./settings";
import { StatusNotices } from "./status";
import { TrackingSettings } from "./tracking";
import type { Settings } from "./shared";

type Tab = "campaigns" | "automations" | "status" | "tracking" | "whatsapp";
const TABS: [Tab, string][] = [["campaigns", "Campanhas"], ["automations", "Automações"], ["status", "Avisos de pedido"], ["tracking", "Anúncios e métricas"], ["whatsapp", "WhatsApp"]];

export default function Marketing() {
  const { tenantId, role } = usePanel();
  const sb = supabaseBrowser();
  const [tab, setTab] = useState<Tab>("campaigns");
  const [s, setS] = useState<Settings | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState("");
  const load = useCallback(async () => {
    const { data, error } = await sb.from("marketing_settings").select("*").eq("tenant_id", tenantId).maybeSingle();
    if (error) setErr(errorMessage(error)); else setS((data as Settings | null) ?? null);
    setLoaded(true);
  }, [sb, tenantId]);
  useEffect(() => { if (canManage(role)) void load(); }, [load, role]);

  if (!canManage(role)) return <Empty>O marketing é gerenciado pelo dono e pela gerência.</Empty>;
  const apiReady = !!s?.wa_enabled;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="h1">Marketing</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-600">
          Chame de volta quem sumiu, parabenize aniversariantes e mande cupons. Só recebem clientes que autorizaram ofertas no pedido.
          O envio manual pelo WhatsApp da loja funciona hoje; o envio automático usa a API oficial do WhatsApp, que depende da aprovação da Meta.
        </p>
      </div>
      <div className="flex gap-1 overflow-x-auto border-b border-zinc-200" role="tablist">
        {TABS.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
            className={`-mb-px shrink-0 border-b-2 px-3 py-2 text-sm font-medium ${tab === k ? "border-brand-600 text-brand-700" : "border-transparent text-zinc-500 hover:text-zinc-800"}`}>{l}</button>
        ))}
      </div>
      <Alert>{err}</Alert>
      {loaded && tab === "campaigns" && <Campaigns apiReady={apiReady} />}
      {loaded && tab === "automations" && <Automations apiReady={apiReady} freqDays={s?.frequency_days ?? 7} />}
      {loaded && tab === "status" && <StatusNotices />}
      {loaded && tab === "tracking" && <TrackingSettings />}
      {loaded && tab === "whatsapp" && <WhatsAppSettings settings={s} onChanged={load} />}
    </div>
  );
}
