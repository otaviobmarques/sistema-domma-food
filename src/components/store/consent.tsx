"use client";
import { useEffect, useState } from "react";
import { getConsent, hasTracking, loadTrackers, setConsent, type Tracking } from "@/lib/tracking";

/** Aviso de cookies do cardápio (LGPD). Só aparece se a loja usa Pixel/Analytics. */
export function ConsentBanner({ tracking, color }: { tracking: Tracking | null | undefined; color: string }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!hasTracking(tracking)) return;
    const c = getConsent();
    if (c === "granted") loadTrackers(tracking);
    else if (c === null) setShow(true);
  }, [tracking]);
  if (!show) return null;
  const answer = (v: "granted" | "denied") => {
    setConsent(v);
    if (v === "granted") loadTrackers(tracking);
    setShow(false);
  };
  return (
    <div role="dialog" aria-label="Aviso de cookies" className="fixed inset-x-3 bottom-3 z-50 mx-auto max-w-xl rounded-2xl bg-white p-4 text-sm shadow-lift ring-1 ring-zinc-200 sm:inset-x-auto sm:left-1/2 sm:-translate-x-1/2">
      <p className="text-zinc-700">
        Esta loja usa cookies de parceiros (Meta e Google) para medir visitas e anúncios. Você escolhe se aceita;
        o pedido funciona do mesmo jeito.
      </p>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={() => answer("denied")} className="btn rounded-xl px-4 py-2 text-zinc-700 ring-1 ring-zinc-300">Recusar</button>
        <button type="button" onClick={() => answer("granted")} className="btn rounded-xl px-4 py-2 text-white" style={{ background: color }}>Aceitar</button>
      </div>
    </div>
  );
}
