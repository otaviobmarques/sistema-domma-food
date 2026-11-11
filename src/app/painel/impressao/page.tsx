"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { canManage, usePanel } from "@/lib/panel/context";
import { Alert, Empty } from "@/components/ui";
import { errorMessage } from "@/lib/format";
import { Printers } from "./printers";
import { Agents } from "./agents";
import { Jobs } from "./jobs";
import type { Agent, Job, Printer } from "./shared";

export default function Impressao() {
  const { unit, role } = usePanel();
  const sb = supabaseBrowser();
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    const [p, a, j] = await Promise.all([
      sb.from("printers").select("id, name, connection, address, paper_width, stations, print_receipt, copies, on_event, active").eq("unit_id", unit.id).order("created_at"),
      sb.from("print_agents").select("id, name, last_seen_at, last_seen_info, active, created_at").eq("unit_id", unit.id).order("created_at"),
      sb.from("print_jobs").select("id, kind, station, status, error, created_at, printed_at, printer_id, orders(number)").eq("unit_id", unit.id).order("id", { ascending: false }).limit(50),
    ]);
    const e = p.error ?? a.error ?? j.error;
    if (e) { setErr(errorMessage(e)); return; }
    setPrinters((p.data ?? []) as Printer[]);
    setAgents((a.data ?? []) as Agent[]);
    setJobs((j.data ?? []) as unknown as Job[]);
    setErr("");
  }, [sb, unit.id]);

  useEffect(() => {
    if (!canManage(role)) return;
    void load();
    const poll = setInterval(() => void load(), 15000);
    const ch = sb.channel(`print-${unit.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "print_jobs", filter: `unit_id=eq.${unit.id}` }, () => void load())
      .subscribe();
    return () => { clearInterval(poll); void sb.removeChannel(ch); };
  }, [load, role, sb, unit.id]);

  if (!canManage(role)) return <Empty>A impressão automática é configurada pela gerência. Para imprimir pelo navegador, abra a <Link href="/painel/impressao/estacao" className="font-semibold text-brand-700 underline">Estação de impressão</Link>.</Empty>;

  const hasBrowser = printers.some((p) => p.connection === "browser" && p.active);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="h1">Impressão automática</h1>
          <p className="mt-1 text-sm text-zinc-500">Comandas por setor e via do pedido saem sozinhas na impressora térmica quando o pedido é aceito.</p>
        </div>
        <Link href="/painel/impressao/estacao" className="btn-secondary">Abrir estação de impressão</Link>
      </div>
      <Alert>{err}</Alert>
      {hasBrowser && <Alert kind="info">Há impressora no modo navegador: deixe a <Link href="/painel/impressao/estacao" className="font-semibold underline">Estação de impressão</Link> aberta no computador dela.</Alert>}
      <Printers printers={printers} onChanged={load} />
      <Agents agents={agents} onChanged={load} />
      <Jobs jobs={jobs} printers={printers} />
    </div>
  );
}
