"use client";
import { useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Toggle } from "@/components/ui";

type Term = { id: string; operating_mode: string };

/** Cartão no totem: vincula uma maquininha Mercado Pago Point (modo integrado / PDV). */
export function PointSetup({ unitId, totemName, terminalId, allowCard, onSave }: {
  unitId: string; totemName: string; terminalId: string | null; allowCard: boolean;
  onSave: (p: { allow_card?: boolean; point_terminal_id?: string | null }, ok?: string) => Promise<void>;
}) {
  const sb = supabaseBrowser();
  const [terms, setTerms] = useState<Term[] | null>(null);
  const [manual, setManual] = useState(terminalId ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function list(setup?: string) {
    setBusy(true); setErr("");
    const { data, error } = await sb.functions.invoke("payments/terminals", { body: { unit_id: unitId, ...(setup ? { setup } : {}) } });
    setBusy(false);
    if (error) {
      let m = "Não foi possível consultar o Mercado Pago.";
      try { m = (await (error as { context?: Response }).context?.json())?.error ?? m; } catch { /* sem corpo */ }
      setErr(m); return;
    }
    setTerms((data as { terminals: Term[] }).terminals);
  }

  return (
    <div className="space-y-2 rounded-lg bg-zinc-50 px-3 py-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span>Cartão na maquininha (Mercado Pago Point)</span>
        <Toggle checked={allowCard} label="Cartão na maquininha" onChange={(v) => void onSave({ allow_card: v }, v ? `Cartão ligado no ${totemName}.` : undefined)} />
      </div>
      <p className="text-xs text-zinc-500">
        {terminalId ? <>Maquininha vinculada: <code>{terminalId}</code>. </> : "Nenhuma maquininha vinculada. "}
        O cliente escolhe crédito ou débito no totem e paga na maquininha ao lado.
      </p>
      <button type="button" className="btn-secondary px-3 py-1.5 text-xs" disabled={busy} onClick={() => void list()}>
        {busy ? "Consultando..." : "Buscar maquininhas da conta"}</button>
      {terms && (terms.length === 0
        ? <p className="text-xs text-amber-800">Nenhuma maquininha Point nesta conta Mercado Pago. Vincule a maquininha no app do Mercado Pago e busque de novo.</p>
        : (
          <ul className="space-y-1">
            {terms.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 rounded bg-white px-2 py-1.5 ring-1 ring-zinc-200">
                <span className="text-xs"><code>{t.id}</code> · {t.operating_mode === "PDV" ? "modo integrado" : "modo comum"}</span>
                <span className="flex gap-1">
                  {t.operating_mode !== "PDV" && (
                    <button type="button" className="btn-ghost px-2 py-1 text-xs" disabled={busy} onClick={() => void list(t.id)}>Ativar modo integrado</button>
                  )}
                  <button type="button" className="btn-primary px-2 py-1 text-xs" disabled={busy || t.operating_mode !== "PDV" || t.id === terminalId}
                    onClick={() => void onSave({ point_terminal_id: t.id }, `Maquininha vinculada ao ${totemName}.`)}>
                    {t.id === terminalId ? "Vinculada" : "Usar neste totem"}</button>
                </span>
              </li>
            ))}
          </ul>
        ))}
      <details className="text-xs text-zinc-500">
        <summary className="cursor-pointer">Informar o ID manualmente</summary>
        <div className="mt-2 flex gap-2">
          <input className="input py-1 text-xs" value={manual} placeholder="NEWLAND_N950__N950NCB801293324" onChange={(e) => setManual(e.target.value)} />
          <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => void onSave({ point_terminal_id: manual.trim() || null }, "Maquininha salva.")}>Salvar</button>
        </div>
        <p className="mt-1">Formato MODELO__NÚMERO DE SÉRIE. No modo integrado, a maquininha só cobra o que o totem manda.</p>
      </details>
      {err && <p className="text-xs text-red-700" role="alert">{err}</p>}
    </div>
  );
}
