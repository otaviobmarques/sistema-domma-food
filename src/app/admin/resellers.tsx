"use client";
import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Alert, Field } from "@/components/ui";
import { brl, errorMessage, parseBRL, slugify } from "@/lib/format";
import { CLIENT_STATUS, dateBR, monthLabel, referralUrl, type ResellerReport } from "@/lib/reseller";

type TenantLite = { id: string; name: string };
const EMPTY = { name: "", code: "", commission_pct: "20", contact_email: "", document: "", phone: "", owner_email: "" };

/** Admin da plataforma: revendas, vínculo de lojas, comissões e repasses. */
export function ResellersAdmin({ tenants, onChanged }: { tenants: TenantLite[]; onChanged?: () => void }) {
  const sb = supabaseBrowser();
  const [list, setList] = useState<ResellerReport[] | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await sb.rpc("admin_resellers");
    if (error) setErr(errorMessage(error)); else setList(data as ResellerReport[]);
  }, [sb]);
  useEffect(() => { void load(); }, [load]);

  async function run(fn: () => PromiseLike<{ error: unknown }>, ok: string) {
    setErr(""); setMsg(""); setBusy(true);
    const { error } = await fn();
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return false; }
    setMsg(ok); void load(); onChanged?.();
    return true;
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const p = { ...form, commission_pct: Number(form.commission_pct.replace(",", ".")) };
    if (await run(() => sb.rpc("admin_reseller_save", { p }), `Revenda ${form.name} criada.`)) { setForm(EMPTY); setCreating(false); }
  }

  const linked = new Set((list ?? []).flatMap((r) => r.clients.map((c) => c.id)));

  return (
    <section className="card space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-semibold">Revendas</h2>
          <p className="text-sm text-zinc-600">Parceiros que indicam lojas e recebem comissão sobre a mensalidade paga. Cada revenda acompanha os clientes em /revenda.</p>
        </div>
        <button className="btn-secondary" onClick={() => setCreating((v) => !v)}>{creating ? "Fechar" : "+ Nova revenda"}</button>
      </div>
      <Alert>{err}</Alert>
      <Alert kind="success">{msg}</Alert>

      {creating && (
        <form onSubmit={create} className="grid gap-3 rounded-xl bg-zinc-50 p-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Nome da revenda"><input className="input" required minLength={2} maxLength={120} value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value, code: f.code && f.code !== slugify(f.name).slice(0, 30) ? f.code : slugify(e.target.value).slice(0, 30) }))} /></Field>
          <Field label="Código do link" hint="Vira /r/código. Letras minúsculas, números e hífen.">
            <input className="input" required pattern="[a-z0-9][a-z0-9\-]{2,29}" value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: slugify(e.target.value).slice(0, 30) }))} /></Field>
          <Field label="Comissão (%)" hint="Sobre o valor líquido de cada mensalidade paga.">
            <input className="input" inputMode="decimal" required value={form.commission_pct} onChange={(e) => setForm((f) => ({ ...f, commission_pct: e.target.value }))} /></Field>
          <Field label="E-mail do responsável" hint="Recebe acesso ao portal. Se ainda não tiver conta, o acesso libera quando ele se cadastrar com este e-mail.">
            <input className="input" type="email" value={form.owner_email} onChange={(e) => setForm((f) => ({ ...f, owner_email: e.target.value }))} /></Field>
          <Field label="CNPJ/CPF (opcional)"><input className="input" maxLength={20} value={form.document} onChange={(e) => setForm((f) => ({ ...f, document: e.target.value }))} /></Field>
          <Field label="Telefone (opcional)"><input className="input" maxLength={20} value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} /></Field>
          <div className="sm:col-span-2 lg:col-span-3"><button className="btn-primary" disabled={busy}>{busy ? "Salvando..." : "Criar revenda"}</button></div>
        </form>
      )}

      {list && list.length === 0 && !creating && <p className="py-4 text-center text-sm text-zinc-500">Nenhuma revenda cadastrada.</p>}
      {list?.map((r) => (
        <Reseller key={r.reseller.id} r={r} tenants={tenants.filter((t) => !linked.has(t.id))} busy={busy} run={run} />
      ))}
    </section>
  );
}

function Reseller({ r, tenants, busy, run }: {
  r: ResellerReport; tenants: TenantLite[]; busy: boolean;
  run: (fn: () => PromiseLike<{ error: unknown }>, ok: string) => Promise<boolean>;
}) {
  const sb = supabaseBrowser();
  const id = r.reseller.id;
  const [pct, setPct] = useState(String(r.reseller.commission_pct));
  const [owner, setOwner] = useState("");
  const [link, setLink] = useState("");
  const thisMonth = new Date().toISOString().slice(0, 7);
  const [pay, setPay] = useState({ month: thisMonth, amount: "", note: "" });

  return (
    <details className="rounded-xl ring-1 ring-zinc-200">
      <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 px-4 py-3">
        <span className="font-semibold">{r.reseller.name} <span className="text-xs font-normal text-zinc-500">/r/{r.reseller.code} · {Number(r.reseller.commission_pct).toLocaleString("pt-BR")}%</span>
          {!r.reseller.active && <span className="badge ml-2 bg-zinc-200 text-zinc-700">Inativa</span>}</span>
        <span className="text-sm text-zinc-600">{r.totals.clients} clientes · {r.totals.active} ativos · saldo <b>{brl(r.balance_cents)}</b></span>
      </summary>
      <div className="space-y-4 border-t border-zinc-200 p-4 text-sm">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <p>Mensalidades ativas<br /><b>{brl(r.totals.mrr_cents)}</b></p>
          <p>Comissão total<br /><b>{brl(r.commission_total_cents)}</b></p>
          <p>Repassado<br /><b>{brl(r.paid_total_cents)}</b></p>
          <p>Link de indicação<br /><code className="break-all text-xs">{referralUrl(r.reseller.code)}</code></p>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <Field label="Comissão (%)"><input className="input w-24" inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value)} /></Field>
          <button className="btn-secondary" disabled={busy} onClick={() => void run(() => sb.rpc("admin_reseller_save", { p: { id, commission_pct: Number(pct.replace(",", ".")) } }), "Comissão atualizada.")}>Salvar comissão</button>
          <button className="btn-ghost" disabled={busy} onClick={() => void run(() => sb.rpc("admin_reseller_save", { p: { id, active: !r.reseller.active } }), r.reseller.active ? "Revenda desativada." : "Revenda reativada.")}>
            {r.reseller.active ? "Desativar revenda" : "Reativar revenda"}</button>
        </div>
        <p className="text-xs text-zinc-500">Mudar a porcentagem recalcula as comissões de todos os meses. Desativar impede novas indicações pelo link; o portal continua acessível.</p>

        <div>
          <p className="mb-1 font-medium">Acesso ao portal</p>
          <ul className="mb-2 text-zinc-600">
            {(r.members ?? []).map((m) => <li key={m.user_id}>{m.email} · {m.role === "owner" ? "responsável" : "equipe"}</li>)}
            {(r.invites ?? []).map((i) => <li key={i.email} className="text-zinc-400">{i.email} · convite pendente ({i.role === "owner" ? "responsável" : "equipe"})</li>)}
            {!r.members?.length && !r.invites?.length && <li className="text-zinc-400">Ninguém ainda.</li>}
          </ul>
          <div className="flex flex-wrap gap-2">
            <input className="input max-w-xs" type="email" placeholder="E-mail do responsável" value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="E-mail do responsável" />
            <button className="btn-secondary" disabled={busy || !owner.trim()} onClick={async () => { if (await run(() => sb.rpc("admin_reseller_save", { p: { id, owner_email: owner } }), `Acesso de responsável para ${owner}.`)) setOwner(""); }}>Dar acesso</button>
          </div>
        </div>

        <div>
          <p className="mb-1 font-medium">Lojas ligadas</p>
          {r.clients.length === 0 ? <p className="text-zinc-400">Nenhuma.</p> : (
            <ul className="divide-y divide-zinc-100">
              {r.clients.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                  <span>{c.name} <span className={`badge ${CLIENT_STATUS[c.status]?.c ?? ""}`}>{CLIENT_STATUS[c.status]?.l ?? c.status}</span>
                    <span className="text-xs text-zinc-500"> · desde {dateBR(c.reseller_since)}</span></span>
                  <button className="btn-ghost px-2 py-1 text-xs text-red-700" disabled={busy}
                    onClick={() => { if (confirm(`Desligar ${c.name} da revenda? Pagamentos futuros deixam de gerar comissão.`)) void run(() => sb.rpc("admin_reseller_link", { p_tenant_id: c.id, p_reseller_id: null }), `${c.name} desligada.`); }}>Desligar</button>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            <select className="input max-w-xs" value={link} onChange={(e) => setLink(e.target.value)} aria-label="Loja para ligar">
              <option value="">Ligar uma loja sem revenda…</option>
              {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <button className="btn-secondary" disabled={busy || !link} onClick={async () => { if (await run(() => sb.rpc("admin_reseller_link", { p_tenant_id: link, p_reseller_id: id }), "Loja ligada à revenda.")) setLink(""); }}>Ligar</button>
          </div>
          <p className="mt-1 text-xs text-zinc-500">A comissão conta a partir de agora. Para trocar a revenda de uma loja, desligue antes.</p>
        </div>

        <div>
          <p className="mb-1 font-medium">Comissões dos últimos meses</p>
          <ul className="grid gap-1 sm:grid-cols-3">
            {r.months.slice(0, 6).map((m) => (
              <li key={m.month} className="rounded-lg bg-zinc-50 px-2 py-1"><span className="capitalize">{monthLabel(m.month)}</span>: <b>{brl(m.commission_cents)}</b>
                {m.paid_cents ? <span className="text-xs text-green-700"> · repassado {brl(m.paid_cents)}</span> : null}</li>
            ))}
          </ul>
        </div>

        <div>
          <p className="mb-1 font-medium">Repasses</p>
          <form className="flex flex-wrap items-end gap-2" onSubmit={async (e) => {
            e.preventDefault();
            if (await run(() => sb.rpc("admin_reseller_payout", { p_reseller_id: id, p_month: pay.month + "-01", p_amount_cents: parseBRL(pay.amount), p_note: pay.note }), "Repasse registrado.")) setPay({ month: thisMonth, amount: "", note: "" });
          }}>
            <Field label="Mês de referência"><input className="input" type="month" required value={pay.month} onChange={(e) => setPay((p) => ({ ...p, month: e.target.value }))} /></Field>
            <Field label="Valor (R$)"><input className="input w-32" inputMode="decimal" required value={pay.amount} onChange={(e) => setPay((p) => ({ ...p, amount: e.target.value }))} /></Field>
            <Field label="Observação"><input className="input" maxLength={300} placeholder="Ex.: Pix em 05/12" value={pay.note} onChange={(e) => setPay((p) => ({ ...p, note: e.target.value }))} /></Field>
            <button className="btn-primary" disabled={busy}>Registrar repasse</button>
          </form>
          {r.payouts.length > 0 && (
            <ul className="mt-2 divide-y divide-zinc-100">
              {r.payouts.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-2 py-1.5">
                  <span><span className="capitalize">{monthLabel(p.month)}</span> · <b>{brl(p.amount_cents)}</b>{p.note ? ` · ${p.note}` : ""} <span className="text-xs text-zinc-500">({dateBR(p.paid_at)})</span></span>
                  <button className="btn-ghost px-2 py-1 text-xs text-red-700" disabled={busy}
                    onClick={() => { if (confirm("Apagar este repasse? Use só para corrigir um lançamento errado.")) void run(() => sb.rpc("admin_reseller_payout_delete", { p_id: p.id }), "Repasse apagado."); }}>Apagar</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </details>
  );
}
