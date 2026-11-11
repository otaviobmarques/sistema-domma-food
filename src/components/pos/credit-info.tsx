"use client";
import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { brl, onlyDigits } from "@/lib/format";

export type CreditCustomer = { id: string; name: string; credit_limit_cents: number; credit_balance_cents: number };

/** Busca o cliente pelo telefone para mostrar o limite de fiado disponível. */
export function useCreditCustomer(tenantId: string, phone: string, enabled: boolean) {
  const [c, setC] = useState<CreditCustomer | null | undefined>(undefined);
  const digits = onlyDigits(phone);
  useEffect(() => {
    if (!enabled || digits.length < 10) { setC(undefined); return; }
    let alive = true;
    const t = setTimeout(async () => {
      const { data } = await supabaseBrowser().from("customers").select("id, name, credit_limit_cents, credit_balance_cents")
        .eq("tenant_id", tenantId).eq("phone", digits).maybeSingle();
      if (alive) setC((data as CreditCustomer | null) ?? null);
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [tenantId, digits, enabled]);
  return c;
}

export const creditAvailable = (c: CreditCustomer) => Math.max(0, c.credit_limit_cents - c.credit_balance_cents);

export function CreditInfo({ customer, phone, amount }: { customer: CreditCustomer | null | undefined; phone: string; amount: number }) {
  if (onlyDigits(phone).length < 10) return <p className="text-xs text-amber-800">Para vender fiado, informe o WhatsApp do cliente.</p>;
  if (customer === undefined) return <p className="text-xs text-zinc-500">Buscando cliente…</p>;
  if (customer === null || customer.credit_limit_cents === 0)
    return <p className="text-xs text-red-700">{customer ? customer.name : "Cliente"} sem fiado liberado. Um gerente define o limite na tela Fiado.</p>;
  const avail = creditAvailable(customer);
  return (
    <p className={`text-xs ${amount > avail ? "text-red-700" : "text-zinc-600"}`}>
      Fiado de <b>{customer.name}</b>: deve {brl(customer.credit_balance_cents)} · disponível {brl(avail)}
      {amount > avail ? " (valor acima do disponível)" : ""}
    </p>
  );
}
