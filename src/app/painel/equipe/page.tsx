"use client";
import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { canManage, usePanel } from "@/lib/panel/context";
import { Alert, Empty, Field } from "@/components/ui";
import { errorMessage, ROLE_LABEL } from "@/lib/format";

type Member = {
  id: string; user_id: string; role: string; unit_ids: string[] | null; email: string; name: string | null;
  created_at: string; has_2fa: boolean; is_me: boolean; max_discount_pct?: number;
};
type Invite = { id: string; email: string; role: string; unit_ids: string[] | null; created_at: string };

const ROLES = ["manager", "cashier", "attendant", "kitchen", "waiter", "courier"] as const;
const ROLE_HELP: Record<string, string> = {
  owner: "Acesso total, inclusive equipe, plano e dados da empresa.",
  manager: "Opera tudo: pedidos, cardápio, cupons, clientes, relatórios e configurações. Não gerencia a equipe.",
  cashier: "Pedidos, caixa/PDV e fechamento de contas. Desconto limitado ao percentual definido.",
  attendant: "Pedidos, confirmação de Pix, clientes e lançamento em mesas.",
  kitchen: "Vê os pedidos e marca itens como prontos no KDS.",
  waiter: "Abre mesas e comandas e lança itens. Não fecha a conta.",
  courier: "Vê os pedidos de entrega e marca saída e entrega.",
};

export default function Equipe() {
  const { tenantId, role, units } = usePanel();
  const sb = supabaseBrowser();
  const isOwner = role === "owner";
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [email, setEmail] = useState("");
  const [newRole, setNewRole] = useState<string>("cashier");
  const [unitIds, setUnitIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [copied, setCopied] = useState(false);
  const [signupUrl, setSignupUrl] = useState("/login?modo=cadastro");

  useEffect(() => { setSignupUrl(`${window.location.origin}/login?modo=cadastro`); }, []);

  const load = useCallback(async () => {
    const { data, error } = await sb.rpc("list_members", { p_tenant_id: tenantId });
    if (error) { setErr(error.message); return; }
    let list = (data ?? []) as Member[];
    if (isOwner) {
      const [{ data: ms }, { data: inv }] = await Promise.all([
        sb.from("memberships").select("id, max_discount_pct").eq("tenant_id", tenantId),
        sb.from("invitations").select("id, email, role, unit_ids, created_at").eq("tenant_id", tenantId).order("created_at"),
      ]);
      const pct = new Map(((ms ?? []) as { id: string; max_discount_pct: number }[]).map((m) => [m.id, Number(m.max_discount_pct)]));
      list = list.map((m) => ({ ...m, max_discount_pct: pct.get(m.id) ?? 0 }));
      setInvites((inv ?? []) as Invite[]);
    }
    setMembers(list);
  }, [sb, tenantId, isOwner]);
  useEffect(() => { load(); }, [load]);

  if (!canManage(role)) return <p className="card">Apenas o dono ou o gerente veem a equipe.</p>;

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(""); setMsg("");
    const { data, error } = await sb.rpc("invite_member", {
      p_tenant_id: tenantId, p_email: email.trim(), p_role: newRole, p_unit_ids: unitIds.length ? unitIds : null,
    });
    setBusy(false);
    if (error) { setErr(error.message.includes("check constraint") ? "E-mail inválido." : errorMessage(error)); return; }
    setMsg(data === "added"
      ? `${email.trim()} já tinha conta: acesso liberado.`
      : `Convite registrado para ${email.trim()}: quando a pessoa criar a conta com este e-mail em /login, o acesso é liberado automaticamente. O sistema não envia e-mail de convite; mande o link abaixo para ela.`);
    setEmail(""); setUnitIds([]); load();
  }

  async function update(m: Member, patch: Record<string, unknown>) {
    setErr(""); setMsg("");
    const { error } = await sb.from("memberships").update(patch).eq("id", m.id);
    if (error) setErr(errorMessage(error)); else load();
  }
  async function remove(m: Member) {
    if (!confirm(`Remover ${m.name || m.email} da equipe? A pessoa perde o acesso imediatamente.`)) return;
    const { error } = await sb.from("memberships").delete().eq("id", m.id);
    if (error) setErr(errorMessage(error)); else load();
  }
  async function cancelInvite(i: Invite) {
    const { error } = await sb.from("invitations").delete().eq("id", i.id);
    if (error) setErr(errorMessage(error)); else load();
  }
  const unitNames = (ids: string[] | null) => !ids || !ids.length ? "Todas as lojas" : ids.map((id) => units.find((u) => u.id === id)?.name ?? "?").join(", ");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="h1">Equipe</h1>
        <p className="mt-1 text-sm text-zinc-600">Cada pessoa entra com o próprio login e só vê o que o perfil dela permite.</p>
      </div>
      <Alert>{err}</Alert>
      <Alert kind="success">{msg}</Alert>

      {isOwner && (
        <form onSubmit={invite} className="card space-y-3">
          <h2 className="font-semibold">Adicionar pessoa</h2>
          <div className="grid gap-3 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
            <Field label="E-mail"><input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" /></Field>
            <Field label="Perfil">
              <select className="input" value={newRole} onChange={(e) => setNewRole(e.target.value)}>
                {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
              </select>
            </Field>
            <button className="btn-primary" disabled={busy}>{busy ? "Adicionando…" : "Adicionar"}</button>
          </div>
          <p className="text-xs text-zinc-500">{ROLE_HELP[newRole]}</p>
          {units.length > 1 && (
            <fieldset>
              <legend className="label">Lojas (deixe todas desmarcadas para liberar todas)</legend>
              <div className="flex flex-wrap gap-3 text-sm">
                {units.map((u) => (
                  <label key={u.id} className="flex items-center gap-1.5">
                    <input type="checkbox" checked={unitIds.includes(u.id)}
                      onChange={(e) => setUnitIds(e.target.checked ? [...unitIds, u.id] : unitIds.filter((x) => x !== u.id))} />
                    {u.name}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <div className="flex flex-wrap items-center gap-2 rounded-lg bg-zinc-50 p-2 text-xs text-zinc-600">
            <span>Link para quem ainda não tem conta:</span>
            <code className="break-all rounded bg-white px-1.5 py-0.5">{signupUrl}</code>
            <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={async () => {
              await navigator.clipboard.writeText(signupUrl); setCopied(true); setTimeout(() => setCopied(false), 1500);
            }}>{copied ? "Copiado" : "Copiar"}</button>
          </div>
        </form>
      )}

      <section className="space-y-2">
        <h2 className="font-semibold">Pessoas com acesso <span className="font-normal text-zinc-500">({members.length})</span></h2>
        {members.length === 0 ? <Empty>Carregando…</Empty> : (
          <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 text-left text-xs uppercase text-zinc-500">
                <tr><th className="p-3">Nome</th><th className="p-3">E-mail</th><th className="p-3">Perfil</th>
                  {units.length > 1 && <th className="p-3">Lojas</th>}<th className="p-3">2FA</th><th className="p-3">Desde</th>{isOwner && <th className="p-3" />}</tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {members.map((m) => {
                  const editable = isOwner && !m.is_me && m.role !== "owner";
                  return (
                    <tr key={m.id}>
                      <td className="p-3 font-medium">{m.name || "—"}{m.is_me && <span className="ml-1 text-xs font-normal text-zinc-500">(você)</span>}</td>
                      <td className="p-3 text-zinc-600">{m.email}</td>
                      <td className="p-3">
                        {editable ? (
                          <div className="flex flex-wrap items-center gap-2">
                            <select className="input w-auto py-1" value={m.role} onChange={(e) => update(m, { role: e.target.value })} aria-label={`Perfil de ${m.email}`}>
                              {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                            </select>
                            {(m.role === "cashier" || m.role === "attendant") && (
                              <label className="flex items-center gap-1 text-xs text-zinc-600">Desconto máx.
                                <input className="input w-16 py-1 text-right" type="number" min={0} max={100} step={1} defaultValue={m.max_discount_pct ?? 0}
                                  onBlur={(e) => { const v = Math.max(0, Math.min(100, Number(e.target.value) || 0)); if (v !== (m.max_discount_pct ?? 0)) update(m, { max_discount_pct: v }); }}
                                  aria-label={`Desconto máximo de ${m.email} em %`} />%
                              </label>
                            )}
                          </div>
                        ) : <span className="badge bg-zinc-100 text-zinc-700">{ROLE_LABEL[m.role] ?? m.role}</span>}
                      </td>
                      {units.length > 1 && <td className="p-3 text-xs text-zinc-600">{unitNames(m.unit_ids)}</td>}
                      <td className="p-3"><span className={`badge ${m.has_2fa ? "bg-green-100 text-green-800" : "bg-zinc-100 text-zinc-600"}`}>{m.has_2fa ? "Sim" : "Não"}</span></td>
                      <td className="p-3 text-xs text-zinc-600">{new Date(m.created_at).toLocaleDateString("pt-BR")}</td>
                      {isOwner && <td className="p-3 text-right">{editable && <button className="btn-ghost text-xs text-red-600" onClick={() => remove(m)}>Remover</button>}</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {isOwner && invites.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-semibold">Convites pendentes</h2>
          <ul className="divide-y divide-zinc-100 rounded-xl border border-zinc-200 bg-white text-sm">
            {invites.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                <span><b>{i.email}</b> · {ROLE_LABEL[i.role] ?? i.role}{units.length > 1 ? ` · ${unitNames(i.unit_ids)}` : ""}
                  <span className="ml-2 text-xs text-zinc-500">aguardando a pessoa criar a conta</span></span>
                <button className="btn-ghost text-xs text-red-600" onClick={() => cancelInvite(i)}>Cancelar convite</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <h2 className="mb-2 font-semibold">O que cada perfil pode fazer</h2>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          {Object.entries(ROLE_HELP).map(([r, h]) => (
            <div key={r}><dt className="font-medium">{ROLE_LABEL[r]}</dt><dd className="text-zinc-600">{h}</dd></div>
          ))}
        </dl>
        <p className="mt-3 text-xs text-zinc-500">Recomende a verificação em duas etapas (2FA) para donos e gerentes, em Segurança.</p>
      </section>
    </div>
  );
}
