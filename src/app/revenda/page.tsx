"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Alert, Logo } from "@/components/ui";
import { brl, errorMessage } from "@/lib/format";
import { CLIENT_STATUS, dateBR, monthLabel, referralUrl, type ResellerReport } from "@/lib/reseller";

type Mine = { id: string; name: string; code: string; role: "owner" | "staff"; active: boolean };

export default function ResellerPortal() {
  const sb = supabaseBrowser();
  const router = useRouter();
  const [mine, setMine] = useState<Mine[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [d, setD] = useState<ResellerReport | null>(null);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [copied, setCopied] = useState(false);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const { data, error } = await sb.rpc("reseller_my");
      if (error) { setErr(errorMessage(error)); setMine([]); return; }
      const list = data as Mine[];
      setMine(list);
      setSel((cur) => cur ?? list[0]?.id ?? null);
    })();
  }, [sb]);

  const load = useCallback(async () => {
    if (!sel) return;
    const { data, error } = await sb.rpc("reseller_overview", { p_reseller_id: sel });
    if (error) setErr(errorMessage(error)); else { setErr(""); setD(data as ResellerReport); }
  }, [sb, sel]);
  useEffect(() => { void load(); }, [load]);

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    if (!sel) return;
    setBusy(true); setErr(""); setMsg("");
    const { data, error } = await sb.rpc("reseller_invite", { p_reseller_id: sel, p_email: email, p_role: "staff" });
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return; }
    setMsg((data as { added?: boolean }).added ? `${email} entrou na equipe.` : `Convite registrado: quando ${email} criar a conta com este e-mail, o acesso é liberado.`);
    setEmail(""); void load();
  }
  async function remove(p: { user_id?: string; email?: string }) {
    if (!sel || !confirm("Remover o acesso desta pessoa ao portal?")) return;
    const { error } = await sb.rpc("reseller_remove", { p_reseller_id: sel, p_user_id: p.user_id ?? null, p_email: p.email ?? null });
    if (error) setErr(errorMessage(error)); else void load();
  }

  const header = (
    <header className="bg-wine-900 text-white">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3">
        <div className="flex items-center gap-3"><Logo dark /><span className="badge bg-white/15 text-white">Portal da revenda</span></div>
        <button className="text-sm text-white/80 hover:text-white" onClick={async () => { await sb.auth.signOut(); router.replace("/login"); }}>Sair</button>
      </div>
    </header>
  );

  if (mine && mine.length === 0) {
    return (
      <div>{header}
        <main className="mx-auto max-w-xl p-6">
          <div className="card space-y-2 text-center">
            <h1 className="h1">Nenhuma revenda ligada a esta conta</h1>
            <p className="text-sm text-zinc-600">O acesso ao portal é liberado pela equipe da plataforma para o e-mail do responsável pela revenda. Entre com esse e-mail ou peça um convite.</p>
            <Alert>{err}</Alert>
          </div>
        </main>
      </div>
    );
  }

  const url = d ? referralUrl(d.reseller.code) : "";
  const kpis = d ? [
    ["Clientes", String(d.totals.clients)], ["Ativos (pagantes)", String(d.totals.active)], ["Em teste", String(d.totals.trial)],
    ["Inadimplentes ou suspensos", String(d.totals.past_due + d.totals.suspended)],
    ["Mensalidades ativas", brl(d.totals.mrr_cents)], ["Comissão a receber", brl(d.balance_cents)],
  ] : [];

  return (
    <div>{header}
      <main className="mx-auto max-w-7xl space-y-6 p-4 lg:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h1 className="h1">{d?.reseller.name ?? "Carregando..."}</h1>
            {d && !d.reseller.active && <span className="badge bg-zinc-200 text-zinc-700">Revenda inativa</span>}
          </div>
          {mine && mine.length > 1 && (
            <select className="input w-auto" value={sel ?? ""} onChange={(e) => { setD(null); setSel(e.target.value); }} aria-label="Revenda">
              {mine.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          )}
        </div>
        <Alert>{err}</Alert>
        <Alert kind="success">{msg}</Alert>

        {d && (
          <>
            <section className="card space-y-2">
              <h2 className="font-semibold">Seu link de indicação</h2>
              {d.reseller.active ? (
                <>
                  <div className="flex flex-wrap gap-2">
                    <code className="flex-1 break-all rounded-lg bg-zinc-100 px-3 py-2 text-sm">{url}</code>
                    <button className="btn-primary" onClick={() => { void navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
                      {copied ? "Copiado!" : "Copiar link"}</button>
                  </div>
                  <p className="text-sm text-zinc-600">
                    A loja criada por este link fica ligada à sua revenda. Você recebe <b>{Number(d.reseller.commission_pct).toLocaleString("pt-BR")}%</b> do
                    valor líquido de cada mensalidade paga por ela, a partir da data da indicação. O cliente é o dono da loja e dos dados dela.
                  </p>
                </>
              ) : <p className="text-sm text-zinc-600">A revenda está inativa: o link não liga novas lojas. Fale com a equipe da plataforma.</p>}
            </section>

            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
              {kpis.map(([k, v]) => (
                <div key={k} className="card"><p className="text-xs font-medium text-zinc-500">{k}</p><p className="mt-1 text-xl font-bold tabular-nums">{v}</p></div>
              ))}
            </div>

            <section className="card">
              <h2 className="mb-3 font-semibold">Clientes</h2>
              {d.clients.length === 0 ? <p className="py-6 text-center text-sm text-zinc-500">Nenhuma loja ligada ainda. Envie seu link de indicação para os seus clientes.</p> : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs uppercase text-zinc-500">
                      <tr><th className="p-2">Cliente</th><th className="p-2">Plano</th><th className="p-2">Situação</th><th className="p-2 text-right">Pedidos 30d</th><th className="p-2">Último pagamento</th><th className="p-2">Cliente desde</th></tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-100">
                      {d.clients.map((c) => (
                        <tr key={c.id}>
                          <td className="p-2">
                            <p className="font-medium">{c.name}</p>
                            <p className="text-xs text-zinc-500">{c.owner_email ?? "—"}{c.units > 1 ? ` · ${c.units} lojas` : ""}</p>
                            {c.store_slug && <a className="text-xs text-brand-700 hover:underline" href={`/loja/${c.store_slug}`} target="_blank" rel="noopener noreferrer">Ver cardápio</a>}
                          </td>
                          <td className="p-2">{c.plan_name}<p className="text-xs text-zinc-500">{c.billing_exempt ? "Isenta de cobrança" : brl(c.price_cents) + "/mês"}</p></td>
                          <td className="p-2">
                            <span className={`badge ${CLIENT_STATUS[c.status]?.c ?? ""}`}>{CLIENT_STATUS[c.status]?.l ?? c.status}</span>
                            {c.status === "trial" && c.trial_ends_at && <p className="mt-1 text-xs text-zinc-500">até {dateBR(c.trial_ends_at)}</p>}
                            {c.cancel_at && <p className="mt-1 text-xs text-red-700">cancela em {dateBR(c.cancel_at)}</p>}
                          </td>
                          <td className="p-2 text-right tabular-nums">{c.orders_30d}</td>
                          <td className="p-2 text-xs">{dateBR(c.last_paid_at)}</td>
                          <td className="p-2 text-xs">{dateBR(c.reseller_since)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <div className="grid gap-4 lg:grid-cols-2">
              <section className="card">
                <h2 className="mb-1 font-semibold">Comissões por mês</h2>
                <p className="mb-3 text-xs text-zinc-500">Pelo mês em que a mensalidade foi paga. Valores líquidos (depois das tarifas de cobrança).</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs uppercase text-zinc-500">
                      <tr><th className="p-2">Mês</th><th className="p-2 text-right">Pago pelos clientes</th><th className="p-2 text-right">Comissão</th><th className="p-2 text-right">Repassado</th></tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-100">
                      {d.months.map((m) => (
                        <tr key={m.month} className={m.received_cents || m.paid_cents ? "" : "text-zinc-400"}>
                          <td className="p-2 capitalize">{monthLabel(m.month)}</td>
                          <td className="p-2 text-right tabular-nums">{brl(m.received_cents)}</td>
                          <td className="p-2 text-right font-semibold tabular-nums">{brl(m.commission_cents)}</td>
                          <td className="p-2 text-right tabular-nums">{brl(m.paid_cents)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-3 flex justify-between border-t border-zinc-200 pt-2 text-sm">
                  <span>Total de comissões {brl(d.commission_total_cents)} · repassado {brl(d.paid_total_cents)}</span>
                  <b>Saldo {brl(d.balance_cents)}</b>
                </p>
              </section>

              <section className="card">
                <h2 className="mb-3 font-semibold">Repasses recebidos</h2>
                {d.payouts.length === 0 ? <p className="py-6 text-center text-sm text-zinc-500">Nenhum repasse registrado ainda.</p> : (
                  <ul className="divide-y divide-zinc-100 text-sm">
                    {d.payouts.map((p) => (
                      <li key={p.id} className="flex justify-between gap-2 py-2">
                        <span><span className="capitalize">{monthLabel(p.month)}</span>{p.note ? <span className="text-zinc-500"> · {p.note}</span> : null}
                          <span className="block text-xs text-zinc-500">registrado em {dateBR(p.paid_at)}</span></span>
                        <b className="tabular-nums">{brl(p.amount_cents)}</b>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>

            {d.my_role === "owner" && d.members && (
              <section className="card space-y-3">
                <h2 className="font-semibold">Equipe da revenda</h2>
                <ul className="divide-y divide-zinc-100 text-sm">
                  {d.members.map((m) => (
                    <li key={m.user_id} className="flex items-center justify-between gap-2 py-2">
                      <span>{m.email} <span className="text-xs text-zinc-500">· {m.role === "owner" ? "responsável" : "equipe"}</span></span>
                      {m.role !== "owner" && <button className="btn-ghost px-2 py-1 text-xs text-red-700" onClick={() => remove({ user_id: m.user_id })}>Remover</button>}
                    </li>
                  ))}
                  {(d.invites ?? []).map((i) => (
                    <li key={i.email} className="flex items-center justify-between gap-2 py-2 text-zinc-500">
                      <span>{i.email} · convite pendente</span>
                      <button className="btn-ghost px-2 py-1 text-xs text-red-700" onClick={() => remove({ email: i.email })}>Cancelar</button>
                    </li>
                  ))}
                </ul>
                <form onSubmit={invite} className="flex flex-wrap gap-2">
                  <input className="input flex-1" type="email" required placeholder="E-mail de quem vai acompanhar os clientes" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="E-mail para convidar" />
                  <button className="btn-secondary" disabled={busy}>{busy ? "Convidando..." : "Convidar"}</button>
                </form>
                <p className="text-xs text-zinc-500">A equipe vê os clientes e as comissões. Só o responsável convida e remove pessoas.</p>
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}
