"use client";
import { useEffect, useState } from "react";
import { disablePush, enablePush, isIOS, isStandalone, pushIsOn, pushSupported, registerSW } from "@/lib/pwa";

/** "Avisar neste aparelho": notificação a cada etapa do pedido, sem depender do WhatsApp. */
export function OrderNotify({ token, color }: { token: string; color: string }) {
  const [state, setState] = useState<"loading" | "off" | "on" | "ios" | "unsupported" | "denied">("loading");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    void registerSW();
    if (!pushSupported()) { setState(isIOS() && !isStandalone() ? "ios" : "unsupported"); return; }
    if (Notification.permission === "denied") { setState("denied"); return; }
    void pushIsOn(token).then((on) => setState(on ? "on" : "off"));
  }, [token]);

  async function toggle() {
    setBusy(true); setErr("");
    if (state === "on") { await disablePush(token); setState("off"); }
    else {
      const e = await enablePush(token);
      if (e) { setErr(e); if (Notification.permission === "denied") setState("denied"); } else setState("on");
    }
    setBusy(false);
  }

  if (state === "loading" || state === "unsupported") return null;
  return (
    <section className="card mt-4" aria-labelledby="avisos-h">
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-white" style={{ background: color }} aria-hidden="true">
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8M10 20a2 2 0 0 0 4 0" /></svg>
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="avisos-h" className="text-sm font-extrabold">{state === "on" ? "Avisos ligados neste aparelho" : "Receber avisos neste aparelho"}</h2>
          <p className="text-xs text-zinc-500">
            {state === "on" ? "Você vai ser avisado quando o pedido for aceito, sair para entrega ou ficar pronto."
              : state === "ios" ? "No iPhone, instale o app da loja: toque em Compartilhar › Adicionar à Tela de Início e abra o pedido pelo ícone."
              : state === "denied" ? "As notificações estão bloqueadas para este site. Libere nas configurações do navegador."
              : "Uma notificação a cada etapa, mesmo com a página fechada."}
          </p>
        </div>
        {(state === "on" || state === "off") && (
          <button className={state === "on" ? "btn-ghost shrink-0 rounded-full px-3 py-2 text-sm" : "btn shrink-0 rounded-full px-4 py-2 text-sm text-white"}
            style={state === "on" ? undefined : { background: color }} disabled={busy} onClick={() => void toggle()}>
            {busy ? "..." : state === "on" ? "Desligar" : "Ativar"}
          </button>
        )}
      </div>
      {err && <p className="mt-2 text-xs text-red-700" role="alert">{err}</p>}
    </section>
  );
}
