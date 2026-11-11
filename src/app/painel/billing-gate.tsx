"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

/** Faixa de cobrança e bloqueio do painel quando a conta está suspensa (a página de assinatura continua aberta para o dono pagar). */
export function BillingGate({ status, trialEndsAt, cancelAt, role, children }: {
  status: string; trialEndsAt: string | null; cancelAt: string | null; role: string; children: React.ReactNode;
}) {
  const path = usePathname();
  const owner = role === "owner";
  const onBilling = path.startsWith("/painel/assinatura");
  const date = (d: string | null) => (d ? new Date(d.length === 10 ? d + "T12:00:00" : d).toLocaleDateString("pt-BR") : "");

  if (status === "suspended" && !onBilling) {
    return (
      <main className="mx-auto grid min-h-[70vh] max-w-lg place-items-center p-6 text-center">
        <div className="card space-y-3">
          <p className="text-4xl" aria-hidden="true">⏸️</p>
          <h1 className="text-xl font-extrabold">Conta suspensa</h1>
          <p className="text-sm text-zinc-600">
            O cardápio online e o painel estão pausados por falta de pagamento ou fim da assinatura. Seus dados continuam guardados.
          </p>
          {owner ? <Link href="/painel/assinatura" className="btn-primary inline-flex">Ver assinatura e pagar</Link>
            : <p className="text-sm font-medium text-zinc-700">Fale com o responsável pela conta para reativar.</p>}
        </div>
      </main>
    );
  }
  return (
    <>
      {status === "trial" && (
        <div className="flex flex-wrap items-center justify-center gap-2 border-b border-amber-200/70 bg-amber-50 px-4 py-2 text-center text-xs text-amber-900">
          <span className="badge bg-amber-200/70 text-amber-900">Teste grátis</span>
          Aproveite todos os recursos até {date(trialEndsAt)}.
          {owner && !onBilling && <Link href="/painel/assinatura" className="font-semibold underline">Assinar</Link>}
        </div>
      )}
      {status === "past_due" && (
        <div role="alert" className="flex flex-wrap items-center justify-center gap-2 border-b border-red-200 bg-red-50 px-4 py-2 text-center text-xs text-red-900">
          <span className="badge bg-red-200/70 text-red-900">Pagamento pendente</span>
          Há uma fatura em aberto. Regularize para a loja não ser suspensa.
          {owner && !onBilling && <Link href="/painel/assinatura" className="font-semibold underline">Pagar agora</Link>}
        </div>
      )}
      {status === "active" && cancelAt && (
        <div className="flex flex-wrap items-center justify-center gap-2 border-b border-zinc-200 bg-zinc-100 px-4 py-2 text-center text-xs text-zinc-700">
          Assinatura cancelada: a conta fica ativa até {date(cancelAt)}.
          {owner && !onBilling && <Link href="/painel/assinatura" className="font-semibold underline">Reativar</Link>}
        </div>
      )}
      {children}
    </>
  );
}
