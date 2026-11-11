"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { brl } from "@/lib/format";

export type GatewayConfig = { provider: string; pix: boolean; card: boolean; public_key: string; max_installments: number };
export type GatewayPayment = {
  kind: "pix" | "card"; status: string; status_detail: string | null; qr_code: string | null; qr_code_base64: string | null;
  ticket_url: string | null; expires_at: string | null; card_last4: string | null; card_brand: string | null;
  installments: number | null; refund_status: string;
};
export type OrderGateway = { config: GatewayConfig | null; attempts: number; payment: GatewayPayment | null };

type BrickController = { unmount: () => void };
type MPInstance = { bricks: () => { create: (kind: string, id: string, settings: unknown) => Promise<BrickController> } };
declare global {
  interface Window { MercadoPago?: new (key: string, opts?: { locale?: string }) => MPInstance }
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i;
const MAX_CARD_ATTEMPTS = 5;

/** Chama a Edge Function de pagamentos e devolve os dados ou a mensagem de erro. */
async function callPayments(route: string, body: unknown): Promise<{ data?: Record<string, unknown>; error?: string }> {
  const { data, error } = await supabaseBrowser().functions.invoke(`payments/${route}`, { body });
  if (!error) return { data: (data ?? {}) as Record<string, unknown> };
  let msg = "Não foi possível falar com o Mercado Pago. Tente de novo.";
  try {
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === "function") {
      const j = await ctx.json();
      if (j?.error) msg = String(j.error);
    }
  } catch { /* mantém a mensagem padrão */ }
  return { error: msg };
}

let sdkPromise: Promise<void> | null = null;
function loadSdk(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("sem janela"));
  if (window.MercadoPago) return Promise.resolve();
  if (!sdkPromise) {
    sdkPromise = new Promise<void>((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://sdk.mercadopago.com/js/v2";
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { sdkPromise = null; reject(new Error("Falha ao carregar o Mercado Pago")); };
      document.head.appendChild(s);
    });
  }
  return sdkPromise;
}

export function OnlinePayment({ token, method, totalCents, gateway, color, onChange }: {
  token: string; method: string; totalCents: number; gateway: OrderGateway; color: string; onChange: () => void | Promise<void>;
}) {
  if (!gateway.config) return null;
  if (method === "pix" && gateway.config.pix) return <GatewayPix token={token} totalCents={totalCents} payment={gateway.payment} color={color} onChange={onChange} />;
  if (method === "online_card" && gateway.config.card)
    return <GatewayCard token={token} totalCents={totalCents} gateway={gateway} color={color} onChange={onChange} />;
  return null;
}

function GatewayPix({ token, totalCents, payment, color, onChange }: {
  token: string; totalCents: number; payment: GatewayPayment | null; color: string; onChange: () => void | Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [needEmail, setNeedEmail] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const started = useRef(false);
  const pix = payment?.kind === "pix" ? payment : null;
  const valid = !!pix && pix.status === "pending" && !!pix.qr_code && (!pix.expires_at || new Date(pix.expires_at).getTime() > now);

  const create = useCallback(async (mail: string) => {
    setBusy(true); setErr("");
    const r = await callPayments("pix", { token, email: mail });
    setBusy(false);
    if (r.error) { setErr(r.error); if (/e-mail/i.test(r.error)) setNeedEmail(true); return; }
    try { sessionStorage.setItem(`df_pay_email_${token}`, mail); localStorage.setItem("df_payer_email", mail); } catch { /* ignora */ }
    setNeedEmail(false);
    await onChange();
  }, [token, onChange]);

  // gera a cobrança automaticamente quando ainda não existe uma válida
  useEffect(() => {
    if (valid || started.current) return;
    started.current = true;
    let stored = "";
    try { stored = sessionStorage.getItem(`df_pay_email_${token}`) ?? localStorage.getItem("df_payer_email") ?? ""; } catch { /* ignora */ }
    setEmail(stored);
    if (EMAIL_RE.test(stored)) void create(stored); else setNeedEmail(true);
  }, [valid, token, create]);

  // contagem regressiva e conferência do pagamento
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!valid) return;
    const s = setInterval(() => { void callPayments("sync", { token }).then(() => onChange()); }, 12000);
    return () => clearInterval(s);
  }, [valid, token, onChange]);

  const remaining = pix?.expires_at ? Math.max(0, new Date(pix.expires_at).getTime() - now) : 0;
  const mm = Math.floor(remaining / 60000), ss = Math.floor((remaining % 60000) / 1000);

  async function copy() {
    if (!pix?.qr_code) return;
    try { await navigator.clipboard.writeText(pix.qr_code); setCopied(true); setTimeout(() => setCopied(false), 2500); } catch { /* sem permissão */ }
  }

  return (
    <section className="card mt-4 text-center" aria-labelledby="gpix-h">
      <h2 id="gpix-h" className="font-extrabold">Pague com Pix para confirmar</h2>
      <p className="text-3xl font-black" style={{ color }}>{brl(totalCents)}</p>
      {valid && pix ? (
        <>
          {pix.qr_code_base64 && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={`data:image/png;base64,${pix.qr_code_base64}`} alt="QR Code Pix" width={240} height={240} className="mx-auto mt-4 rounded-2xl p-2 ring-1 ring-zinc-200" />
          )}
          <textarea readOnly aria-label="Pix copia e cola" className="input mt-3 h-20 resize-none font-mono text-xs" value={pix.qr_code ?? ""} />
          <button className="btn mt-3 w-full rounded-2xl py-3.5 text-white shadow-lift" style={{ background: color }} onClick={copy}>
            {copied ? "Código copiado ✓" : "Copiar código Pix"}
          </button>
          <p className="mt-2 text-xs text-zinc-500" aria-live="polite">
            {pix.expires_at ? (remaining > 0 ? `Expira em ${mm}:${ss.toString().padStart(2, "0")}` : "Prazo de pagamento encerrado.") : ""}
            {" "}· A confirmação é automática: assim que o Pix cair, seu pedido segue para a loja.
          </p>
          <p className="mt-2 flex items-center justify-center gap-2 text-xs font-medium text-zinc-600">
            <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" aria-hidden /> Aguardando pagamento
          </p>
        </>
      ) : needEmail ? (
        <form className="mt-3 space-y-2 text-left" onSubmit={(e) => { e.preventDefault(); if (EMAIL_RE.test(email.trim())) void create(email.trim().toLowerCase()); else setErr("Informe um e-mail válido."); }}>
          <label className="label" htmlFor="gpix-email">E-mail (para o comprovante do Mercado Pago)</label>
          <input id="gpix-email" className="input" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="voce@email.com" />
          <button className="btn w-full rounded-2xl py-3 text-white" style={{ background: color }} disabled={busy}>{busy ? "Gerando Pix..." : "Gerar Pix"}</button>
        </form>
      ) : (
        <p className="mt-3 text-sm text-zinc-600" aria-live="polite">{busy ? "Gerando o Pix..." : pix && !valid && pix.status !== "error" ? "Este Pix expirou." : "Preparando o pagamento..."}</p>
      )}
      {!busy && pix && !valid && !needEmail && (
        <button className="btn-secondary mt-3 w-full" onClick={() => { const m = email || (() => { try { return sessionStorage.getItem(`df_pay_email_${token}`) ?? ""; } catch { return ""; } })(); if (EMAIL_RE.test(m)) void create(m); else setNeedEmail(true); }}>
          Gerar novo Pix
        </button>
      )}
      {err && <p role="alert" className="mt-2 text-sm text-red-700">{err}</p>}
    </section>
  );
}

function GatewayCard({ token, totalCents, gateway, color, onChange }: {
  token: string; totalCents: number; gateway: OrderGateway; color: string; onChange: () => void | Promise<void>;
}) {
  const config = gateway.config!;
  const containerId = `card-brick-${token.slice(0, 8)}`;
  const [msg, setMsg] = useState<{ kind: "error" | "ok"; text: string } | null>(null);
  const [round, setRound] = useState(0);         // recria o formulário depois de uma recusa
  const [loadErr, setLoadErr] = useState("");
  const [ready, setReady] = useState(false);
  const attemptsLeft = Math.max(0, MAX_CARD_ATTEMPTS - gateway.attempts);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (attemptsLeft <= 0) return;
    let controller: BrickController | null = null;
    let cancelled = false;
    setReady(false);
    loadSdk().then(async () => {
      if (cancelled || !window.MercadoPago) return;
      const mp = new window.MercadoPago(config.public_key, { locale: "pt-BR" });
      controller = await mp.bricks().create("cardPayment", containerId, {
        initialization: { amount: totalCents / 100 },
        customization: { paymentMethods: { maxInstallments: config.max_installments }, visual: { style: { theme: "default" } } },
        callbacks: {
          onReady: () => { if (!cancelled) setReady(true); },
          onSubmit: (formData: unknown) => new Promise<void>((resolve) => {
            setMsg(null);
            void callPayments("card", { token, form: formData }).then(async (r) => {
              if (r.error) { setMsg({ kind: "error", text: r.error }); resolve(); await onChangeRef.current(); setRound((n) => n + 1); return; }
              const st = String(r.data?.status ?? "");
              const text = String(r.data?.message ?? "");
              if (st === "paid") { setMsg({ kind: "ok", text: text || "Pagamento aprovado!" }); resolve(); await onChangeRef.current(); return; }
              setMsg({ kind: "error", text: text || "Pagamento recusado. Tente outro cartão." });
              resolve();
              await onChangeRef.current();
              if (st === "rejected" || st === "error") setRound((n) => n + 1);
            });
          }),
          onError: (e: unknown) => { console.error("Mercado Pago:", e); },
        },
      });
      if (cancelled) controller?.unmount();
    }).catch((e: Error) => { if (!cancelled) setLoadErr(e.message || "Não foi possível carregar o pagamento com cartão."); });
    return () => { cancelled = true; try { controller?.unmount(); } catch { /* já desmontado */ } };
  }, [round, attemptsLeft, config.public_key, config.max_installments, totalCents, containerId, token]);

  return (
    <section className="card mt-4" aria-labelledby="gcard-h">
      <h2 id="gcard-h" className="text-center font-extrabold">Pague com cartão de crédito</h2>
      <p className="text-center text-3xl font-black" style={{ color }}>{brl(totalCents)}</p>
      {msg && (
        <p role={msg.kind === "error" ? "alert" : "status"}
          className={`mt-3 rounded-xl px-3 py-2 text-sm ${msg.kind === "error" ? "bg-red-50 text-red-800 ring-1 ring-red-200" : "bg-emerald-50 text-emerald-900 ring-1 ring-emerald-200"}`}>
          {msg.text}
        </p>
      )}
      {attemptsLeft <= 0 ? (
        <p className="mt-3 text-center text-sm text-zinc-600">Limite de tentativas atingido. Fale com a loja para concluir o pedido.</p>
      ) : (
        <>
          {loadErr && <p role="alert" className="mt-3 text-sm text-red-700">{loadErr}</p>}
          {!ready && !loadErr && <p className="mt-3 text-center text-sm text-zinc-500">Carregando formulário seguro...</p>}
          <div key={round} id={containerId} className="mt-3" />
          <p className="mt-2 text-center text-xs text-zinc-500">
            {attemptsLeft < MAX_CARD_ATTEMPTS ? `${attemptsLeft} tentativa(s) restante(s). ` : ""}
            Pagamento processado com segurança pelo Mercado Pago. A loja não vê os dados do seu cartão.
          </p>
        </>
      )}
    </section>
  );
}

/** Situação do pagamento online depois de pago ou cancelado. */
export function PaymentNote({ payment }: { payment: GatewayPayment | null }) {
  if (!payment) return null;
  const refund = payment.refund_status === "refunded" ? "Estorno realizado no Mercado Pago."
    : payment.refund_status === "requested" || payment.refund_status === "processing" ? "Estorno solicitado ao Mercado Pago."
    : payment.refund_status === "failed" ? "O estorno não foi concluído. A loja vai resolver com você." : "";
  const paid = payment.status === "approved"
    ? payment.kind === "card"
      ? `Pago com cartão${payment.card_last4 ? ` final ${payment.card_last4}` : ""}${payment.installments && payment.installments > 1 ? ` em ${payment.installments}x` : ""}.`
      : "Pix confirmado."
    : "";
  if (!refund && !paid) return null;
  return (
    <p className="mt-4 rounded-2xl bg-zinc-50 px-4 py-3 text-sm text-zinc-700 ring-1 ring-zinc-200" aria-live="polite">
      {paid} {refund}
    </p>
  );
}
