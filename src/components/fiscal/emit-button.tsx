"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { errorMessage, onlyDigits } from "@/lib/format";
import { canManage, usePanel } from "@/lib/panel/context";

export type FiscalDoc = {
  id: string; status: string; number: string | null; series: string | null; message: string | null;
  danfe_url: string | null; xml_url: string | null; authorized_at: string | null; created_at: string;
};

export const FISCAL_STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: "Emitindo", cls: "bg-amber-100 text-amber-800" },
  processing: { label: "Emitindo", cls: "bg-amber-100 text-amber-800" },
  authorized: { label: "Autorizada", cls: "bg-green-100 text-green-800" },
  rejected: { label: "Rejeitada", cls: "bg-red-100 text-red-800" },
  error: { label: "Erro", cls: "bg-red-100 text-red-800" },
  cancel_requested: { label: "Cancelando", cls: "bg-zinc-100 text-zinc-700" },
  cancelling: { label: "Cancelando", cls: "bg-zinc-100 text-zinc-700" },
  cancelled: { label: "Cancelada", cls: "bg-zinc-100 text-zinc-600" },
};

const PENDING = ["pending", "processing", "cancel_requested", "cancelling"];
const COLS = "id, status, number, series, message, danfe_url, xml_url, authorized_at, created_at";

/** Botão "Emitir NFC-e" para um pedido pago (orderId) ou uma conta de mesa fechada (tabId). */
export function EmitButton({ orderId, tabId, compact = false }: { orderId?: string; tabId?: string; compact?: boolean }) {
  const sb = supabaseBrowser();
  const { unit, role } = usePanel();
  const [disabled, setDisabled] = useState(false);
  const [doc, setDoc] = useState<FiscalDoc | null | undefined>(undefined);
  const [asking, setAsking] = useState(false);
  const [cpf, setCpf] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [waiting, setWaiting] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    if (!orderId && !tabId) { setDoc(null); return null; }
    let q = sb.from("fiscal_documents").select(COLS).order("created_at", { ascending: false }).limit(1);
    q = orderId ? q.eq("order_id", orderId) : q.eq("tab_id", tabId as string);
    const { data } = await q.maybeSingle();
    const d = (data as FiscalDoc | null) ?? null;
    setDoc(d);
    return d;
  }, [sb, orderId, tabId]);

  const stopPoll = () => { if (timer.current) { clearInterval(timer.current); timer.current = null; } setWaiting(false); };
  const poll = useCallback(() => {
    stopPoll();
    setWaiting(true);
    const started = Date.now();
    timer.current = setInterval(async () => {
      const d = await load();
      if ((d && !PENDING.includes(d.status)) || Date.now() - started > 40_000) stopPoll();
    }, 2000);
  }, [load]);

  useEffect(() => {
    // gerentes leem a configuração; se a NFC-e estiver desligada, o botão compacto some
    if (!compact || !canManage(role)) return;
    void (async () => {
      const { data } = await sb.from("fiscal_settings").select("enabled").eq("unit_id", unit.id).maybeSingle();
      setDisabled(!(data as { enabled?: boolean } | null)?.enabled);
    })();
  }, [sb, unit.id, role, compact]);

  useEffect(() => {
    load().then((d) => { if (d && PENDING.includes(d.status)) poll(); });
    return () => stopPoll();
  }, [load, poll]);

  async function emit(e?: React.FormEvent) {
    e?.preventDefault();
    const docNum = onlyDigits(cpf);
    if (docNum && docNum.length !== 11 && docNum.length !== 14) { setErr("CPF ou CNPJ inválido."); return; }
    setBusy(true); setErr("");
    const { error } = await sb.rpc("fiscal_request", { p_order_id: orderId ?? null, p_tab_id: tabId ?? null, p_consumer_doc: docNum || null });
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return; }
    setAsking(false); setCpf("");
    await load(); poll();
  }

  async function retry() {
    if (!doc) return;
    setBusy(true); setErr("");
    const { error } = await sb.rpc("fiscal_retry", { p_doc_id: doc.id });
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return; }
    await load(); poll();
  }

  if (doc === undefined) return null;

  // Sem nota ainda
  if (!doc || doc.status === "cancelled") {
    if (compact && (disabled || (err && /não está ativada|incompleta/i.test(err)))) return null;
    return (
      <div className="space-y-2 text-left">
        {doc?.status === "cancelled" && <p className="text-xs text-zinc-500">A NFC-e anterior desta venda foi cancelada.</p>}
        {asking ? (
          <form onSubmit={emit} className="space-y-2 rounded-lg border border-zinc-200 p-3">
            <label className="block">
              <span className="label">CPF ou CNPJ na nota (opcional)</span>
              <input className="input" inputMode="numeric" autoFocus maxLength={18} value={cpf} onChange={(e) => setCpf(e.target.value)} placeholder="Somente números" />
            </label>
            <div className="flex gap-2">
              <button type="button" className="btn-ghost" onClick={() => { setAsking(false); setErr(""); }}>Voltar</button>
              <button className="btn-primary flex-1" disabled={busy}>{busy ? "Enviando..." : "Emitir NFC-e"}</button>
            </div>
          </form>
        ) : (
          <button type="button" className={compact ? "btn-secondary w-full" : "btn-secondary"} onClick={() => { setErr(""); setAsking(true); }}>Emitir NFC-e</button>
        )}
        {err && <p role="alert" className="text-xs text-red-700">{err}{/ativad|incompleta|configur/i.test(err) && <> <Link href="/painel/fiscal" className="font-semibold underline">Configurar</Link></>}</p>}
      </div>
    );
  }

  const st = FISCAL_STATUS[doc.status] ?? { label: doc.status, cls: "bg-zinc-100 text-zinc-700" };
  return (
    <div className="space-y-1.5 rounded-lg border border-zinc-200 p-3 text-left text-sm" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">NFC-e</span>
        <span className={`badge ${st.cls}`}>{st.label}{waiting && PENDING.includes(doc.status) ? "…" : ""}</span>
        {doc.status === "authorized" && doc.number && <span className="text-zinc-600">nº {doc.number}{doc.series ? ` · série ${doc.series}` : ""}</span>}
      </div>
      {doc.status === "authorized" && (
        <div className="flex flex-wrap gap-3 text-sm">
          {doc.danfe_url && <a className="font-semibold text-brand-700 hover:underline" href={doc.danfe_url} target="_blank" rel="noopener noreferrer">Abrir DANFE</a>}
          {doc.xml_url && <a className="text-zinc-600 hover:underline" href={doc.xml_url} target="_blank" rel="noopener noreferrer">XML</a>}
        </div>
      )}
      {PENDING.includes(doc.status) && !waiting && (
        <button type="button" className="btn-ghost px-0 text-xs" onClick={poll}>Atualizar status</button>
      )}
      {(doc.status === "rejected" || doc.status === "error") && (
        <>
          {doc.message && <p className="text-xs text-red-700">{doc.message}</p>}
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className="btn-secondary" disabled={busy} onClick={retry}>{busy ? "Reenviando..." : "Reenviar"}</button>
            <Link href="/painel/fiscal" className="text-xs font-semibold text-zinc-600 underline">Ver notas fiscais</Link>
          </div>
        </>
      )}
      {err && <p role="alert" className="text-xs text-red-700">{err}</p>}
    </div>
  );
}
