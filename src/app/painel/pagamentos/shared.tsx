"use client";
import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { brl } from "@/lib/format";

export type Gateway = {
  unit_id: string; enabled: boolean; pix_enabled: boolean; card_enabled: boolean; max_installments: number;
  statement_descriptor: string | null; public_key: string | null; live: boolean | null; token_hint: string | null;
  access_token_secret_id: string | null; webhook_secret_id: string | null;
  last_test_at: string | null; last_test_ok: boolean | null; last_test_message: string | null;
};
export type GatewayPayment = {
  id: string; kind: "pix" | "card"; status: string; status_detail: string | null; amount_cents: number;
  installments: number | null; card_last4: string | null; card_brand: string | null;
  refund_status: "none" | "requested" | "processing" | "refunded" | "failed"; refund_message: string | null; created_at: string;
  orders?: { number: number; customer_name: string } | null;
};

export const GP_STATUS: Record<string, { label: string; cls: string }> = {
  approved: { label: "Aprovado", cls: "bg-green-100 text-green-800" },
  pending: { label: "Aguardando", cls: "bg-amber-100 text-amber-800" },
  in_process: { label: "Em análise", cls: "bg-amber-100 text-amber-800" },
  rejected: { label: "Recusado", cls: "bg-red-100 text-red-800" },
  cancelled: { label: "Cancelado", cls: "bg-zinc-100 text-zinc-700" },
  refunded: { label: "Estornado", cls: "bg-sky-100 text-sky-800" },
  charged_back: { label: "Contestado", cls: "bg-red-100 text-red-800" },
  error: { label: "Erro", cls: "bg-red-100 text-red-800" },
  creating: { label: "Criando", cls: "bg-zinc-100 text-zinc-700" },
};
export const REFUND_LABEL: Record<string, { label: string; cls: string }> = {
  requested: { label: "Estornando", cls: "text-amber-700" },
  processing: { label: "Estornando", cls: "text-amber-700" },
  refunded: { label: "Estornado", cls: "text-sky-700" },
  failed: { label: "Falhou", cls: "text-red-700" },
};

export function methodText(p: Pick<GatewayPayment, "kind" | "card_brand" | "card_last4" | "installments">) {
  if (p.kind === "pix") return "Pix";
  const brand = p.card_brand ? p.card_brand.charAt(0).toUpperCase() + p.card_brand.slice(1) : "Cartão";
  return `${brand}${p.card_last4 ? ` final ${p.card_last4}` : ""}${p.installments && p.installments > 1 ? ` · ${p.installments}x` : ""}`;
}

export function StatusBadge({ status }: { status: string }) {
  const s = GP_STATUS[status] ?? { label: status, cls: "bg-zinc-100 text-zinc-700" };
  return <span className={`badge ${s.cls}`}>{s.label}</span>;
}

/** Último pagamento online de um pedido (usado no detalhe do pedido). */
export function useOrderGateway(orderId: string | undefined, key?: string) {
  const [gp, setGp] = useState<GatewayPayment | null>(null);
  useEffect(() => {
    if (!orderId) { setGp(null); return; }
    let alive = true;
    (async () => {
      const { data } = await supabaseBrowser().from("gateway_payments")
        .select("id, kind, status, status_detail, amount_cents, installments, card_last4, card_brand, refund_status, refund_message, created_at")
        .eq("order_id", orderId).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (alive) setGp((data as GatewayPayment | null) ?? null);
    })();
    return () => { alive = false; };
  }, [orderId, key]);
  return gp;
}

export function GatewayBlock({ gp }: { gp: GatewayPayment | null }) {
  if (!gp) return null;
  const r = REFUND_LABEL[gp.refund_status];
  return (
    <div className="mt-1 rounded-lg border border-zinc-200 p-2 text-xs">
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-zinc-700">Mercado Pago</span>
        <StatusBadge status={gp.status} />
        <span className="text-zinc-600">{methodText(gp)} · {brl(gp.amount_cents)}</span>
      </p>
      {r && <p className={`mt-1 font-medium ${r.cls}`}>Estorno: {r.label}{gp.refund_message && gp.refund_status === "failed" ? ` — ${gp.refund_message}` : ""}</p>}
    </div>
  );
}
