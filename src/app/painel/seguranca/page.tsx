"use client";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { canManage, usePanel } from "@/lib/panel/context";
import { Alert, Field } from "@/components/ui";

type Factor = { id: string; status: string; friendly_name?: string; created_at: string };
type Log = { id: number; actor_id: string | null; action: string; entity: string; entity_id: string | null; before: Record<string, unknown> | null; after: Record<string, unknown> | null; ip: string | null; created_at: string };

const ACTION: Record<string, string> = { insert: "criou", update: "alterou", delete: "excluiu", cancel: "cancelou", lgpd_erase: "anonimizou (LGPD)" };
const ENTITY: Record<string, string> = {
  products: "produto", categories: "categoria", option_groups: "grupo de complementos", options: "complemento", coupons: "cupom",
  delivery_zones: "área de entrega", units: "loja", tenants: "empresa", memberships: "acesso de usuário", payments: "pagamento",
  orders: "pedido", customers: "cliente", product_unit_overrides: "preço por loja",
};

function changes(l: Log) {
  if (l.action !== "update" || !l.before || !l.after) return "";
  const skip = new Set(["updated_at", "order_counter"]);
  return Object.keys(l.after).filter((k) => !skip.has(k) && JSON.stringify(l.before![k]) !== JSON.stringify(l.after![k]))
    .slice(0, 4).map((k) => `${k}: ${JSON.stringify(l.before![k])} → ${JSON.stringify(l.after![k])}`).join(" · ");
}

function Security() {
  const { role, tenantId, email } = usePanel();
  const params = useSearchParams();
  const sb = supabaseBrowser();
  const [pwd, setPwd] = useState("");
  const [factors, setFactors] = useState<Factor[]>([]);
  const [enroll, setEnroll] = useState<{ id: string; qr: string; secret: string } | null>(null);
  const [code, setCode] = useState("");
  const [logs, setLogs] = useState<Log[]>([]);
  const [msg, setMsg] = useState(params.get("nova-senha") ? "Defina sua nova senha abaixo." : "");
  const [err, setErr] = useState("");

  const loadFactors = useCallback(async () => {
    const { data } = await sb.auth.mfa.listFactors();
    setFactors((data?.totp ?? []) as Factor[]);
  }, [sb]);

  useEffect(() => {
    loadFactors();
    if (canManage(role)) {
      sb.from("audit_logs").select("*").eq("tenant_id", tenantId).order("created_at", { ascending: false }).limit(100)
        .then(({ data }: { data: unknown[] | null }) => setLogs((data ?? []) as Log[]));
    }
  }, [sb, loadFactors, role, tenantId]);

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setErr(""); setMsg("");
    if (pwd.length < 10) { setErr("Use pelo menos 10 caracteres."); return; }
    const { error } = await sb.auth.updateUser({ password: pwd });
    if (error) setErr(error.message); else { setMsg("Senha alterada."); setPwd(""); }
  }

  async function startEnroll() {
    setErr("");
    // remove tentativas antigas não verificadas
    for (const f of factors.filter((x) => x.status !== "verified")) await sb.auth.mfa.unenroll({ factorId: f.id });
    const { data, error } = await sb.auth.mfa.enroll({ factorType: "totp", friendlyName: `Domma Food ${new Date().toLocaleDateString("pt-BR")}` });
    if (error || !data) { setErr(error?.message ?? "Não foi possível iniciar."); return; }
    setEnroll({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
  }

  async function confirmEnroll(e: React.FormEvent) {
    e.preventDefault();
    if (!enroll) return;
    const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: enroll.id, code: code.trim() });
    if (error) { setErr("Código inválido. Confira o horário do celular e tente de novo."); return; }
    setEnroll(null); setCode(""); setMsg("Verificação em duas etapas ativada."); loadFactors();
  }

  async function removeFactor(id: string) {
    if (!confirm("Desativar a verificação em duas etapas? Sua conta fica menos protegida.")) return;
    const { error } = await sb.auth.mfa.unenroll({ factorId: id });
    if (error) setErr(error.message); else { setMsg("Verificação em duas etapas desativada."); loadFactors(); }
  }

  const verified = factors.filter((f) => f.status === "verified");

  return (
    <div className="space-y-6">
      <h1 className="h1">Segurança</h1>
      <Alert>{err}</Alert>
      <Alert kind="success">{msg}</Alert>

      <section className="card space-y-3">
        <h2 className="font-semibold">Verificação em duas etapas (2FA)</h2>
        {(role === "owner" || role === "manager") && verified.length === 0 && (
          <Alert kind="info">Recomendado para administradores: proteja o acesso ao financeiro e aos dados dos clientes.</Alert>
        )}
        {verified.length > 0 ? (
          <div className="flex items-center justify-between rounded-lg border border-green-200 bg-green-50 p-3 text-sm">
            <span>✓ Ativada com app autenticador</span>
            <button className="btn-ghost text-red-600" onClick={() => removeFactor(verified[0].id)}>Desativar</button>
          </div>
        ) : enroll ? (
          <form onSubmit={confirmEnroll} className="space-y-3">
            <p className="text-sm">1. Escaneie o QR Code com Google Authenticator, Microsoft Authenticator ou 1Password.</p>
            <img src={enroll.qr} alt="QR Code para o app autenticador" className="h-44 w-44 rounded-lg border bg-white p-2" />
            <p className="text-xs text-zinc-500">Ou digite a chave: <code className="break-all">{enroll.secret}</code></p>
            <Field label="2. Digite o código de 6 dígitos">
              <input className="input max-w-40 text-center tracking-widest" inputMode="numeric" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
            </Field>
            <button className="btn-primary">Ativar</button>
          </form>
        ) : (
          <button className="btn-primary" onClick={startEnroll}>Ativar 2FA</button>
        )}
      </section>

      <section className="card">
        <h2 className="mb-3 font-semibold">Alterar senha</h2>
        <form onSubmit={changePassword} className="flex flex-wrap items-end gap-3">
          <input type="email" value={email} autoComplete="username" readOnly hidden />
          <div className="w-full max-w-xs">
            <Field label="Nova senha"><input className="input" type="password" autoComplete="new-password" minLength={10} required value={pwd} onChange={(e) => setPwd(e.target.value)} /></Field>
          </div>
          <button className="btn-secondary">Salvar senha</button>
        </form>
      </section>

      {canManage(role) && (
        <section className="card">
          <h2 className="mb-1 font-semibold">Auditoria</h2>
          <p className="mb-3 text-xs text-zinc-500">Últimas 100 alterações em preços, cardápio, cupons, cancelamentos, pagamentos e acessos. Não pode ser editada.</p>
          <ul className="divide-y divide-zinc-100 text-sm">
            {logs.map((l) => {
              const name = (l.after?.name ?? l.before?.name ?? l.after?.code ?? l.before?.code ?? "") as string;
              return (
                <li key={l.id} className="py-2">
                  <p>
                    <span className="text-zinc-500">{new Date(l.created_at).toLocaleString("pt-BR")}</span> ·{" "}
                    {l.actor_id ? "Usuário" : "Sistema/cliente"} {ACTION[l.action] ?? l.action} {ENTITY[l.entity] ?? l.entity}{" "}
                    {name && <b>{name}</b>}
                    {l.ip && <span className="text-xs text-zinc-400"> · IP {l.ip}</span>}
                  </p>
                  {changes(l) && <p className="mt-0.5 break-all font-mono text-xs text-zinc-500">{changes(l)}</p>}
                </li>
              );
            })}
            {logs.length === 0 && <li className="py-4 text-center text-zinc-500">Nenhum registro.</li>}
          </ul>
        </section>
      )}
    </div>
  );
}

export default function Page() {
  return <Suspense><Security /></Suspense>;
}
