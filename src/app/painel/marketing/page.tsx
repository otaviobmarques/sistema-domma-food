"use client";
import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { canManage, usePanel } from "@/lib/panel/context";
import { Alert, Empty } from "@/components/ui";
import { errorMessage } from "@/lib/format";
import { Campaigns } from "./campaigns";
import { Automations } from "./automations";
import { WhatsAppSettings } from "./whatsapp";
import type { Settings } from "./shared";

type Tab = "campaigns" | "automations" | "whatsapp";
const TABS: [Tab, string][] = [["campaigns", "Campanhas"], ["automations", "Automações"], ["whatsapp", "WhatsApp"]];

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

  if (!canManage(role)) return <Empty>O marketing é feito pela gerência.</Empty>;
  const apiReady = !!s?.wa_enabled;
  const freq = s?.frequency_days ?? 7;
  return (
    <div className="space-y-5">
      <div>
        <h1 className="h1">Marketing e WhatsApp</h1>
        <p className="text-sm text-zinc-500">Campanhas e automações para trazer o cliente de volta, com cupom automático. Só recebe quem autorizou marketing no pedido (LGPD).</p>
      </div>
      <div className="flex gap-1 border-b border-zinc-200" role="tablist">
        {TABS.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === k ? "border-brand-600 text-brand-700" : "border-transparent text-zinc-500 hover:text-zinc-800"}`}>{l}</button>
        ))}
      </div>
      <Alert>{err}</Alert>
      {loaded && tab === "campaigns" && <Campaigns apiReady={apiReady} freqDays={freq} />}
      {loaded && tab === "automations" && <Automations apiReady={apiReady} freqDays={freq} />}
      {loaded && tab === "whatsapp" && <WhatsAppSettings s={s} onChanged={load} />}
    </div>
  );
}
