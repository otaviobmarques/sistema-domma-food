"use client";
import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { usePanel } from "@/lib/panel/context";
import { Alert, Empty, Field } from "@/components/ui";
import { brl, errorMessage, formatPhone } from "@/lib/format";

type Plan = { id: string; name: string; price_cents: number; max_units: number; max_users: number };
type Invoice = { id: string; value_cents: number; status: string; billing_type: string | null; due_date: string; paid_at: string | null; invoice_url: string | null; description: string | null };
type Overview = {
  enabled: boolean; grace_days: number;
  tenant: { name: string; cnpj: string | null; plan_id: string; status: string; trial_ends_at: string; past_due_since: string | null;
    paid_until: string | null; cancel_at: string | null; exempt: boolean; suspend_at: string | null };
  account: { plan_id: string | null; name: string | null; cpf_cnpj: string | null; email: string | null; phone: string | null; status: "none" | "active" | "canceled"; next_due_date: string | null } | null;
  plans: Plan[]; invoices: Invoice[];
};

const PLAN_INFO: Record<string, string[]> = {
  essencial: ["Cardápio digital e pedidos", "Pix com QR Code", "Cupons e dashboard"],
  delivery: ["Tudo do Essencial", "Áreas de entrega, entregadores e rotas", "Clientes, cashback e marketplaces"],
  salao: ["Tudo do Essencial", "Mesas, comandas e QR na mesa", "Caixa/PDV e KDS"],
  completo: ["Tudo dos outros planos", "Até 3 lojas", "Estoque, financeiro e marketing"],
};
const STATUS: Record<string, { label: string; cls: string }> = {
  trial: { label: "Teste grátis", cls: "bg-amber-100 text-amber-800" }, active: { label: "Ativa", cls: "bg-green-100 text-green-800" },
  past_due: { label: "Pagamento pendente", cls: "bg-red-100 text-red-800" }, suspended: { label: "Suspensa", cls: "bg-zinc-200 text-zinc-800" },
};
const INV: Record<string, { label: string; cls: string }> = {
  PENDING: { label: "Em aberto", cls: "bg-amber-100 text-amber-800" }, OVERDUE: { label: "Vencida", cls: "bg-red-100 text-red-800" },
  RECEIVED: { label: "Paga", cls: "bg-green-100 text-green-800" }, CONFIRMED: { label: "Paga", cls: "bg-green-100 text-green-800" },
  RECEIVED_IN_CASH: { label: "Paga", cls: "bg-green-100 text-green-800" }, REFUNDED: { label: "Estornada", cls: "bg-zinc-100 text-zinc-600" },
};
const PAY: Record<string, string> = { PIX: "Pix", BOLETO: "Boleto", CREDIT_CARD: "Cartão", UNDEFINED: "" };
const day = (d: string | null) => (d ? new Date(d.length === 10 ? d + "T12:00:00" : d).toLocaleDateString("pt-BR") : "—");
const fmtDoc = (v: string) => {
  const d = v.replace(/\D/g, "").slice(0, 14);
  return d.length <= 11 ? d.replace(/(\d{3})(\d{3})?(\d{3})?(\d{0,2})?/, (_, a, b, c, e) => [a, b, c].filter(Boolean).join(".") + (e ? "-" + e : ""))
    : d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{0,2})/, "$1.$2.$3/$4-$5");
};

export default function Assinatura() {
  const { tenantId, role, email } = usePanel();
  const sb = supabaseBrowser();
  const [ov, setOv] = useState<Overview | null>(null);
  const [plan, setPlan] = useState("");
  const [f, setF] = useState({ name: "", cpf_cnpj: "", email: "", phone: "" });
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    const { data, error } = await sb.rpc("billing_overview", { p_tenant_id: tenantId });
    if (error) { setErr(errorMessage(error)); return; }
    const o = data as Overview;
    setOv(o);
    setPlan((p) => p || o.account?.plan_id || o.tenant.plan_id);
    setF((x) => x.name ? x : {
      name: o.account?.name ?? o.tenant.name.replace(/\s*\(demonstração\)/, ""), cpf_cnpj: fmtDoc(o.account?.cpf_cnpj ?? o.tenant.cnpj ?? ""),
      email: o.account?.email ?? email, phone: o.account?.phone ? formatPhone(o.account.phone) : "",
    });
  }, [sb, tenantId, email]);
  useEffect(() => { if (role === "owner") void load(); }, [load, role]);

  async function call(path: string, body: Record<string, unknown>, ok: string) {
    setBusy(path); setErr(""); setMsg("");
    const { data, error } = await sb.functions.invoke(`billing/${path}`, { body: { tenant_id: tenantId, ...body } });
    setBusy("");
    if (error) {
      let m = errorMessage(error);
      try { const b = await (error as { context?: Response }).context?.json(); if (b?.error) m = b.error; } catch { /* sem corpo */ }
      setErr(m); return false;
    }
    if (data?.error) { setErr(data.error); return false; }
    setMsg(ok); await load(); return true;
  }

  if (role !== "owner") return <Empty>A assinatura é gerenciada pelo dono da conta.</Empty>;
  if (!ov) return err ? <Alert>{err}</Alert> : null;
  const t = ov.tenant, acc = ov.account;
  const subscribed = acc?.status === "active";
  const current = ov.plans.find((p) => p.id === (acc?.plan_id ?? t.plan_id));
  const chosen = ov.plans.find((p) => p.id === plan);
  const open = ov.invoices.find((i) => i.status === "OVERDUE") ?? ov.invoices.find((i) => i.status === "PENDING");
  const st = STATUS[t.status] ?? { label: t.status, cls: "bg-zinc-100" };
  const canSubmit = ov.enabled && !t.exempt && !!chosen && f.name.trim().length >= 3 && [11, 14].includes(f.cpf_cnpj.replace(/\D/g, "").length) && /\S+@\S+\.\S+/.test(f.email);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="h1">Assinatura</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-600">
          Plano mensal, sem fidelidade. A fatura é paga pelo Asaas, nosso parceiro de cobrança, por Pix, boleto ou cartão: os dados de pagamento não passam pelo Domma.
        </p>
      </div>
      <Alert>{err}</Alert>
      <Alert kind="success">{msg}</Alert>

      <section className="card flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <p className="flex flex-wrap items-center gap-2 text-lg font-bold">
            Plano {current?.name ?? t.plan_id} <span className={`badge ${st.cls}`}>{st.label}</span>
            {t.exempt && <span className="badge bg-blue-100 text-blue-800">Isenta</span>}
          </p>
          <p className="text-sm text-zinc-600">
            {t.status === "trial" && <>Teste grátis até <b>{day(t.trial_ends_at)}</b>.{subscribed ? " A primeira fatura vence no fim do teste." : " Assine para continuar depois disso."}</>}
            {t.status === "active" && !t.cancel_at && <>{acc?.next_due_date ? <>Próxima fatura em <b>{day(acc.next_due_date)}</b>.</> : t.paid_until ? <>Pago até <b>{day(t.paid_until)}</b>.</> : "Conta ativa."}</>}
            {t.cancel_at && <>Assinatura cancelada: a conta fica ativa até <b>{day(t.cancel_at)}</b>. Assine de novo para não perder o acesso.</>}
            {t.status === "past_due" && <>Fatura em aberto{t.suspend_at ? <> · a loja será suspensa em <b>{day(t.suspend_at)}</b> se não for paga</> : ""}.</>}
            {t.status === "suspended" && <>Cardápio e painel pausados. Pague a fatura em aberto para reativar na hora.</>}
          </p>
        </div>
        {open?.invoice_url && (
          <a className="btn-primary" href={open.invoice_url} target="_blank" rel="noopener noreferrer">
            Pagar fatura de {brl(open.value_cents)} ↗
          </a>
        )}
      </section>

      {!ov.enabled && !t.exempt && (
        <Alert kind="info">A cobrança online está sendo ativada. Enquanto isso, sua conta segue normalmente; fale com o suporte para assinar.</Alert>
      )}

      <section className="space-y-3">
        <h2 className="font-semibold">{subscribed ? "Trocar de plano" : "Escolha o plano"}</h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" role="radiogroup" aria-label="Planos">
          {ov.plans.map((p) => (
            <button key={p.id} type="button" role="radio" aria-checked={plan === p.id} onClick={() => setPlan(p.id)}
              className={`card text-left transition ${plan === p.id ? "ring-2 ring-brand-600" : "hover:ring-1 hover:ring-zinc-300"}`}>
              <p className="flex items-center justify-between font-semibold">{p.name}
                {p.id === (acc?.plan_id ?? t.plan_id) && <span className="badge bg-zinc-100 text-zinc-700">Atual</span>}</p>
              <p className="mt-1 text-2xl font-extrabold">{brl(p.price_cents)}<span className="text-sm font-medium text-zinc-500">/mês</span></p>
              <ul className="mt-2 space-y-1 text-xs text-zinc-600">
                {(PLAN_INFO[p.id] ?? []).map((x) => <li key={x}>✓ {x}</li>)}
                <li>✓ {p.max_units} loja{p.max_units > 1 ? "s" : ""} · até {p.max_users} usuários</li>
              </ul>
            </button>
          ))}
        </div>
      </section>

      <section className="card space-y-3">
        <h2 className="font-semibold">Dados para a cobrança</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Nome ou razão social"><input className="input" maxLength={120} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="CPF ou CNPJ"><input className="input" inputMode="numeric" value={f.cpf_cnpj} onChange={(e) => setF({ ...f, cpf_cnpj: fmtDoc(e.target.value) })} /></Field>
          <Field label="E-mail para receber as faturas"><input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label="Celular (opcional)"><input className="input" inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: formatPhone(e.target.value) })} /></Field>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <p className="text-xs text-zinc-500">
            {subscribed ? "A troca vale para a fatura em aberto e as próximas (sem cobrança proporcional)."
              : t.status === "trial" ? "Nada é cobrado agora: a primeira fatura vence no fim do teste grátis." : "A primeira fatura vence hoje."}
          </p>
          <div className="flex flex-wrap gap-2">
            {subscribed && (
              <button className="btn-secondary" disabled={!!busy}
                onClick={() => { if (confirm("Cancelar a assinatura? A conta fica ativa até o fim do período já pago.")) void call("cancel", {}, "Assinatura cancelada."); }}>
                {busy === "cancel" ? "Cancelando..." : "Cancelar assinatura"}
              </button>
            )}
            <button className="btn-primary" disabled={!canSubmit || !!busy || (subscribed && plan === acc?.plan_id && !!acc?.name)}
              onClick={() => void call("subscribe", { plan_id: plan, ...f }, subscribed ? "Plano atualizado." : "Assinatura criada. A fatura aparece abaixo.")}>
              {busy === "subscribe" ? "Enviando..." : subscribed ? (plan === acc?.plan_id ? "Atualizar dados" : `Trocar para ${chosen?.name ?? ""}`) : `Assinar ${chosen?.name ?? ""} · ${chosen ? brl(chosen.price_cents) : ""}/mês`}
            </button>
          </div>
        </div>
      </section>

      <section className="card">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="font-semibold">Faturas</h2>
          {subscribed && <button className="text-sm font-medium text-brand-700 hover:underline" disabled={!!busy} onClick={() => void call("sync", {}, "Faturas atualizadas.")}>
            {busy === "sync" ? "Atualizando..." : "Atualizar"}</button>}
        </div>
        {ov.invoices.length === 0 ? <p className="text-sm text-zinc-500">Nenhuma fatura ainda.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-zinc-500"><tr><th className="py-1.5">Vencimento</th><th>Valor</th><th>Situação</th><th /></tr></thead>
              <tbody className="divide-y divide-zinc-100">
                {ov.invoices.map((i) => {
                  const s = INV[i.status] ?? { label: i.status, cls: "bg-zinc-100 text-zinc-600" };
                  const paid = ["RECEIVED", "CONFIRMED", "RECEIVED_IN_CASH"].includes(i.status);
                  return (
                    <tr key={i.id}>
                      <td className="py-2 pr-3">{day(i.due_date)}</td>
                      <td className="pr-3">{brl(i.value_cents)}</td>
                      <td className="pr-3"><span className={`badge ${s.cls}`}>{s.label}</span>
                        {paid && i.paid_at && <span className="ml-2 text-xs text-zinc-500">em {day(i.paid_at)}{i.billing_type && PAY[i.billing_type] ? ` · ${PAY[i.billing_type]}` : ""}</span>}</td>
                      <td className="text-right">{i.invoice_url && <a className="font-medium text-brand-700 hover:underline" href={i.invoice_url} target="_blank" rel="noopener noreferrer">{paid ? "Recibo ↗" : "Pagar ↗"}</a>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
