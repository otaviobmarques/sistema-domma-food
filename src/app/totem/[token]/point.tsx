"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { brl } from "@/lib/format";

type Phase = "sending" | "waiting" | "paid" | "failed";
async function call(route: string, body: Record<string, unknown>) {
  const { data, error } = await supabaseBrowser().functions.invoke(`payments/${route}`, { body });
  if (error) {
    let msg = "Não foi possível falar com a maquininha.";
    try { msg = (await (error as { context?: Response }).context?.json())?.error ?? msg; } catch { /* sem corpo */ }
    return { status: "error", message: msg };
  }
  return data as { status: string; message?: string; error?: string };
}

/** Totem: cobra o pedido na maquininha Mercado Pago Point e acompanha até aprovar. */
export function PointPayment({ orderToken, totalCents, cardType, color, canCounter, onPaid, onCounter }: {
  orderToken: string; totalCents: number; cardType: "credit_card" | "debit_card"; color: string; canCounter: boolean;
  onPaid: () => void; onCounter: () => Promise<string | null>;
}) {
  const [phase, setPhase] = useState<Phase>("sending");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  const apply = useCallback((r: { status: string; message?: string; error?: string }) => {
    if (r.status === "paid" || r.status === "approved") { setPhase("paid"); onPaid(); return; }
    if (["rejected", "cancelled", "error"].includes(r.status) || r.error) {
      setPhase("failed");
      setMsg(r.message ?? r.error ?? (r.status === "cancelled" ? "Pagamento cancelado na maquininha." : "Pagamento não aprovado."));
      return;
    }
    setPhase("waiting");
  }, [onPaid]);

  const send = useCallback(async () => {
    setPhase("sending"); setMsg("");
    apply(await call("point", { token: orderToken }));
  }, [orderToken, apply]);
  useEffect(() => { if (!started.current) { started.current = true; void send(); } }, [send]);

  // acompanha a maquininha (o webhook também atualiza; aqui é a confirmação rápida)
  useEffect(() => {
    if (phase !== "waiting") return;
    const t = setInterval(async () => apply(await call("sync", { token: orderToken })), 3500);
    return () => clearInterval(t);
  }, [phase, orderToken, apply]);

  async function giveUp() {
    setBusy(true);
    const r = await call("point/cancel", { token: orderToken });
    setBusy(false);
    if (r.status === "paid" || r.status === "approved") { setPhase("paid"); onPaid(); return; }
    setPhase("failed"); setMsg("Pagamento cancelado.");
  }
  async function counter() {
    setBusy(true);
    const e = await onCounter();
    setBusy(false);
    if (e) setMsg(e);
  }

  if (phase === "paid") return null;
  return (
    <div className="mt-4 rounded-3xl bg-white p-8 text-center shadow-sm">
      {phase !== "failed" ? (
        <>
          <p className="text-5xl" aria-hidden="true">💳</p>
          <p className="mt-4 text-3xl font-extrabold">{phase === "sending" ? "Enviando para a maquininha..." : "Pague na maquininha"}</p>
          <p className="mt-3 text-2xl text-zinc-700">
            {brl(totalCents)} no <b>{cardType === "credit_card" ? "crédito" : "débito"}</b>. Aproxime ou insira o cartão e siga as instruções na tela dela.
          </p>
          <div className="mx-auto mt-6 h-2 w-48 overflow-hidden rounded-full bg-zinc-100" aria-hidden="true">
            <div className="h-full w-1/3 animate-pulse rounded-full" style={{ background: color }} />
          </div>
          <p className="mt-6 text-sm text-zinc-500" role="status">Aguardando a confirmação do pagamento.</p>
          {phase === "waiting" && (
            <button className="mt-6 rounded-2xl border-2 border-zinc-300 px-6 py-3 text-lg font-semibold disabled:opacity-40" disabled={busy} onClick={() => void giveUp()}>
              Desistir do cartão</button>
          )}
        </>
      ) : (
        <>
          <p className="text-3xl font-extrabold text-red-700">Pagamento não concluído</p>
          <p className="mt-3 text-xl text-zinc-700" role="alert">{msg}</p>
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            <button className="rounded-2xl px-6 py-4 text-xl font-bold text-white disabled:opacity-40" style={{ background: color }} disabled={busy} onClick={() => void send()}>
              Tentar de novo</button>
            {canCounter && (
              <button className="rounded-2xl border-2 border-zinc-300 px-6 py-4 text-xl font-bold disabled:opacity-40" disabled={busy} onClick={() => void counter()}>
                Pagar no caixa</button>
            )}
          </div>
          {!canCounter && <p className="mt-4 text-sm text-zinc-500">Se preferir, chame um atendente.</p>}
        </>
      )}
    </div>
  );
}
