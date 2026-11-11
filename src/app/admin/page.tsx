"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Alert, Logo } from "@/components/ui";
import { brl } from "@/lib/format";
import { BillingSettings, type BillingAdmin } from "./billing";

type Tenant = {
  id: string; name: string; cnpj: string | null; plan_id: string; status: string; trial_ends_at: string; created_at: string;
  owner_email: string | null; units: { name: string; slug: string }[]; orders_30d: number; gmv_30d_cents: number; last_order_at: string | null;
};
type Overview = {
  totals: { tenants: number; active: number; trial: number; units: number; orders_30d: number; gmv_30d_cents: number; mrr_cents: number; marketplace_connections: number };
  plans: { id: string; name: string; price_cents: number }[];
  tenants: Tenant[];
};
const STATUS: Record<string, { l: string; c: string }> = {
  trial: { l: "Teste", c: "bg-amber-100 text-amber-800" }, active: { l: "Ativa", c: "bg-green-100 text-green-800" },
  past_due: { l: "Inadimplente", c: "bg-orange-100 text-orange-800" }, suspended: { l: "Suspensa", c: "bg-red-100 text-red-800" },
};

export default function AdminPage() {
  const sb = supabaseBrowser();
  const router = useRouter();
  const [d, setD] = useState<Overview | null>(null);
  const [bill, setBill] = useState<BillingAdmin | null>(null);
  const [q, setQ] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    const [{ data, error }, b] = await Promise.all([sb.rpc("admin_overview"), sb.rpc("admin_billing_settings")]);
    if (error) setErr(error.message); else setD(data as Overview);
    if (!b.error) setBill(b.data as BillingAdmin);
  }, [sb]);
  useEffect(() => { load(); }, [load]);

  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (d?.tenants ?? []).filter((x) => !t || x.name.toLowerCase().includes(t) || (x.owner_email ?? "").includes(t)
      || x.units.some((u) => u.slug.includes(t)));
  }, [d, q]);

  async function update(t: Tenant, plan: string, status: string, trialDays?: number) {
    setErr(""); setMsg("");
    const { error } = await sb.rpc("admin_set_tenant", { p_tenant_id: t.id, p_plan_id: plan, p_status: status, p_trial_days: trialDays ?? null });
    if (error) setErr(error.message); else { setMsg(`${t.name} atualizada.`); load(); }
  }

  async function setExempt(t: Tenant, v: boolean) {
    setErr(""); setMsg("");
    const { error } = await sb.rpc("admin_set_exempt", { p_tenant_id: t.id, p_exempt: v });
    if (error) setErr(error.message); else { setMsg(`${t.name}: ${v ? "isenta de cobrança" : "cobrança normal"}.`); load(); }
  }
  const INV: Record<string, string> = { PENDING: "em aberto", OVERDUE: "vencida", RECEIVED: "paga", CONFIRMED: "paga", RECEIVED_IN_CASH: "paga", REFUNDED: "estornada" };

  const kpis = d ? [
    ["Empresas", d.totals.tenants], ["Ativas (pagantes)", d.totals.active], ["Em teste", d.totals.trial], ["Lojas", d.totals.units],
    ["MRR", brl(d.totals.mrr_cents)], ["Pedidos 30d", d.totals.orders_30d], ["GMV 30d", brl(d.totals.gmv_30d_cents)],
    ["Integrações ativas", d.totals.marketplace_connections],
  ] : [];

  return (
    <div>
      <header className="bg-wine-900 text-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-3"><Logo dark /><span className="badge bg-white/15 text-white">Super Admin</span></div>
          <button className="text-sm text-white/80 hover:text-white" onClick={async () => { await sb.auth.signOut(); router.replace("/login"); }}>Sair</button>
        </div>
      </header>
      <main className="mx-auto max-w-7xl space-y-6 p-4 lg:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="h1">Plataforma Domma Food</h1>
          <div className="flex gap-2">
            <Link href="/admin/seguranca" className="btn-secondary">Minha segurança (2FA e senha)</Link>
          </div>
        </div>
        <Alert>{err}</Alert>
        <Alert kind="success">{msg}</Alert>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {kpis.map(([k, v]) => (
            <div key={String(k)} className="card"><p className="text-xs font-medium text-zinc-500">{k}</p><p className="mt-1 text-xl font-bold tabular-nums">{v}</p></div>
          ))}
        </div>
        {bill && <BillingSettings s={bill} onChanged={load} />}
        <section className="card">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold">Empresas</h2>
            <input className="input max-w-xs" placeholder="Buscar por nome, e-mail ou loja" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {list.length === 0 ? <p className="py-6 text-center text-sm text-zinc-500">Nenhuma empresa cadastrada ainda.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase text-zinc-500">
                  <tr><th className="p-2">Empresa</th><th className="p-2">Lojas</th><th className="p-2">Plano</th><th className="p-2">Situação</th><th className="p-2">Cobrança</th><th className="p-2">Pedidos 30d</th><th className="p-2">GMV 30d</th><th className="p-2">Criada</th></tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {list.map((t) => (
                    <tr key={t.id}>
                      <td className="p-2"><p className="font-medium">{t.name}</p><p className="text-xs text-zinc-500">{t.owner_email}</p></td>
                      <td className="p-2 text-xs">{t.units.map((u) => <a key={u.slug} className="block text-brand-700 hover:underline" href={`/loja/${u.slug}`} target="_blank" rel="noopener">{u.name}</a>)}</td>
                      <td className="p-2">
                        <select className="input py-1" value={t.plan_id} onChange={(e) => update(t, e.target.value, t.status)} aria-label="Plano">
                          {d!.plans.map((p) => <option key={p.id} value={p.id}>{p.name} · {brl(p.price_cents)}</option>)}
                        </select>
                      </td>
                      <td className="p-2">
                        <div className="flex items-center gap-2">
                          <span className={`badge ${STATUS[t.status]?.c}`}>{STATUS[t.status]?.l ?? t.status}</span>
                          <select className="input w-auto py-1 text-xs" value="" onChange={(e) => {
                            const v = e.target.value; if (!v) return;
                            if (v === "extend") update(t, t.plan_id, "trial", 14); else update(t, t.plan_id, v);
                          }} aria-label="Alterar situação">
                            <option value="">Alterar…</option>
                            <option value="active">Ativar</option>
                            <option value="extend">+14 dias de teste</option>
                            <option value="past_due">Marcar inadimplente</option>
                            <option value="suspended">Suspender</option>
                          </select>
                        </div>
                        {t.status === "trial" && <p className="mt-1 text-xs text-zinc-500">até {new Date(t.trial_ends_at).toLocaleDateString("pt-BR")}</p>}
                      </td>
                      <td className="p-2 text-xs">
                        {(() => { const a = bill?.accounts?.[t.id]; const li = a?.last_invoice;
                          return a?.status === "active" ? <p>Assinante{li ? ` · ${INV[li.status] ?? li.status} ${new Date(li.due_date + "T12:00:00").toLocaleDateString("pt-BR")}` : ""}</p>
                            : a?.status === "canceled" ? <p className="text-zinc-500">Cancelou</p> : <p className="text-zinc-500">Sem assinatura</p>; })()}
                        <label className="mt-1 flex items-center gap-1.5 text-zinc-600">
                          <input type="checkbox" className="h-3.5 w-3.5 accent-brand-600" checked={!!bill?.exempt.includes(t.id)} onChange={(e) => setExempt(t, e.target.checked)} />
                          Isenta
                        </label>
                      </td>
                      <td className="p-2 tabular-nums">{t.orders_30d}</td>
                      <td className="p-2 tabular-nums">{brl(t.gmv_30d_cents)}</td>
                      <td className="p-2 text-xs">{new Date(t.created_at).toLocaleDateString("pt-BR")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <p className="text-xs text-zinc-500">Suspender uma empresa tira o cardápio do ar imediatamente; os dados são mantidos. Suspensão feita aqui não é desfeita por pagamento. Empresas isentas (demonstração, parceiros) nunca são cobradas nem suspensas automaticamente. Toda alteração fica registrada na auditoria.</p>
      </main>
    </div>
  );
}
