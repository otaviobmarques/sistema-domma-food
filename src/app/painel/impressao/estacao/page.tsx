"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { usePanel } from "@/lib/panel/context";
import { Alert, Empty } from "@/components/ui";
import { errorMessage } from "@/lib/format";
import { ticketHtml } from "../shared";

type BJob = { id: number; content: string; paper_width: number; printer: string };
type Log = { id: number; printer: string; at: string; ok: boolean; error?: string; title: string };
const ROLES = ["owner", "manager", "cashier", "attendant", "kitchen"];
const KIOSK = `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --kiosk-printing https://domma-food.vercel.app/painel/impressao/estacao`;

/** Imprime o HTML num iframe oculto e espera o diálogo/fila do navegador terminar. */
function printHtml(frame: HTMLIFrameElement, html: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = frame.contentDocument;
    const win = frame.contentWindow;
    if (!doc || !win) { reject(new Error("Janela de impressão indisponível")); return; }
    doc.open(); doc.write(html); doc.close();
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    win.addEventListener("afterprint", finish, { once: true });
    setTimeout(() => {
      try { win.focus(); win.print(); } catch (e) { reject(e as Error); return; }
      setTimeout(finish, 1500);   // nem todo navegador dispara afterprint no modo kiosk
    }, 150);
  });
}

export default function Estacao() {
  const { unit, role } = usePanel();
  const sb = supabaseBrowser();
  const frame = useRef<HTMLIFrameElement>(null);
  const busy = useRef(false);
  const [paused, setPaused] = useState(false);
  const [log, setLog] = useState<Log[]>([]);
  const [err, setErr] = useState("");
  const [lastCheck, setLastCheck] = useState<Date | null>(null);
  const [copied, setCopied] = useState(false);
  const allowed = ROLES.includes(role);

  const cycle = useCallback(async () => {
    if (busy.current || paused || !frame.current) return;
    busy.current = true;
    try {
      const { data, error } = await sb.rpc("print_browser_claim", { p_unit_id: unit.id });
      setLastCheck(new Date());
      if (error) { setErr(errorMessage(error)); return; }
      setErr("");
      for (const j of (data ?? []) as BJob[]) {
        const title = j.content.split("\n")[0]?.replace(/^##/, "") ?? "Impressão";
        try {
          await printHtml(frame.current, ticketHtml(j.content, j.paper_width));
          await sb.rpc("print_browser_done", { p_job_id: j.id, p_ok: true, p_error: null });
          setLog((l) => [{ id: j.id, printer: j.printer, at: new Date().toISOString(), ok: true, title }, ...l].slice(0, 30));
        } catch (e) {
          const m = (e as Error).message ?? "Falha ao imprimir";
          await sb.rpc("print_browser_done", { p_job_id: j.id, p_ok: false, p_error: m });
          setLog((l) => [{ id: j.id, printer: j.printer, at: new Date().toISOString(), ok: false, error: m, title }, ...l].slice(0, 30));
        }
      }
    } finally { busy.current = false; }
  }, [paused, sb, unit.id]);

  useEffect(() => {
    if (!allowed) return;
    void cycle();
    const t = setInterval(() => void cycle(), 3000);
    return () => clearInterval(t);
  }, [allowed, cycle]);

  // mantém a tela acesa enquanto a estação está aberta
  useEffect(() => {
    if (!allowed) return;
    let lock: { release: () => Promise<void> } | null = null;
    const req = async () => {
      try {
        const wl = (navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } }).wakeLock;
        if (wl && document.visibilityState === "visible") lock = await wl.request("screen");
      } catch { /* não suportado */ }
    };
    void req();
    const onVis = () => { if (document.visibilityState === "visible") void req(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { document.removeEventListener("visibilitychange", onVis); void lock?.release().catch(() => {}); };
  }, [allowed]);

  if (!allowed) return <Empty>A estação de impressão é usada pela equipe do caixa, atendimento ou cozinha.</Empty>;
  const errors = log.filter((l) => !l.ok);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="h1">Estação de impressão</h1>
        <p className="mt-1 text-sm text-zinc-500">Deixe esta tela aberta no computador ligado à impressora. As impressoras no modo &quot;Navegador&quot; imprimem por aqui.</p>
      </div>

      <section className={`card flex flex-wrap items-center justify-between gap-4 ${paused ? "border-amber-300 bg-amber-50" : "border-green-300 bg-green-50"}`}>
        <div className="flex items-center gap-3">
          <span className={`h-4 w-4 rounded-full ${paused ? "bg-amber-500" : "animate-pulse bg-green-500"}`} />
          <div>
            <p className="text-lg font-semibold">{paused ? "Estação pausada" : "Estação ativa"}</p>
            <p className="text-sm text-zinc-600">
              {unit.name} · {lastCheck ? `última verificação às ${lastCheck.toLocaleTimeString("pt-BR")}` : "verificando a fila..."}
            </p>
          </div>
        </div>
        <button className={paused ? "btn-primary" : "btn-secondary"} onClick={() => setPaused((p) => !p)}>{paused ? "Retomar" : "Pausar"}</button>
      </section>
      <Alert>{err}</Alert>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card">
          <h2 className="mb-2 font-semibold">Impressos agora há pouco</h2>
          {log.filter((l) => l.ok).length === 0 ? <p className="text-sm text-zinc-500">Nada impresso desde que a tela foi aberta.</p> : (
            <ul className="divide-y divide-zinc-100 text-sm">
              {log.filter((l) => l.ok).map((l) => (
                <li key={`${l.id}-${l.at}`} className="flex justify-between gap-2 py-1.5">
                  <span>{l.title} <span className="text-zinc-500">· {l.printer}</span></span>
                  <span className="tabular-nums text-zinc-500">{new Date(l.at).toLocaleTimeString("pt-BR")}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="card">
          <h2 className="mb-2 font-semibold">Erros</h2>
          {errors.length === 0 ? <p className="text-sm text-zinc-500">Nenhum erro.</p> : (
            <ul className="divide-y divide-zinc-100 text-sm">
              {errors.map((l) => (
                <li key={`${l.id}-${l.at}`} className="py-1.5"><span className="font-medium">{l.title}</span> · {l.printer}<span className="block text-xs text-red-700">{l.error}</span></li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="card space-y-2 text-sm text-zinc-700">
        <h2 className="font-semibold text-zinc-900">Imprimir sem a janela de confirmação</h2>
        <p>Por padrão o navegador pede confirmação a cada impressão. Para imprimir direto, abra o Chrome com a opção <code className="font-mono">--kiosk-printing</code> e defina a térmica como impressora padrão do Windows. Crie um atalho com este destino:</p>
        <div className="flex gap-2">
          <code className="flex-1 overflow-x-auto whitespace-nowrap rounded-lg bg-zinc-900 px-3 py-2 font-mono text-xs text-zinc-100">{KIOSK}</code>
          <button className="btn-secondary" onClick={async () => { try { await navigator.clipboard.writeText(KIOSK); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* sem permissão */ } }}>{copied ? "Copiado" : "Copiar"}</button>
        </div>
        <p className="text-xs text-zinc-500">Feche todas as janelas do Chrome antes de abrir pelo atalho. A tela fica acesa enquanto esta página estiver aberta (quando o navegador permite).</p>
      </section>

      <iframe ref={frame} title="Impressão" aria-hidden="true" tabIndex={-1} className="pointer-events-none fixed -left-[9999px] top-0 h-[1px] w-[80mm] opacity-0" />
    </div>
  );
}
