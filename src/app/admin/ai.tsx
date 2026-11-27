"use client";
import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Alert, Toggle } from "@/components/ui";
import { errorMessage } from "@/lib/format";

type AiAdmin = {
  enabled: boolean; api_key_hint: string | null; monthly_limit: number;
  last_test: { at: string; ok: boolean; error: string | null } | null;
  tenants: { tenant_id: string; name: string; enabled: boolean; use_own_key: boolean; monthly_limit: number | null; effective_limit: number;
    used_platform: number; used_own: number; tokens_month: number }[];
};

/** Atendente IA: chave da plataforma, limite mensal por loja e uso do mês. */
export function AiSettings() {
  const sb = supabaseBrowser();
  const [s, setS] = useState<AiAdmin | null>(null);
  const [key, setKey] = useState("");
  const [limit, setLimit] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    const { data, error } = await sb.rpc("admin_ai_settings");
    if (error) { setErr(errorMessage(error)); return; }
    setS(data as AiAdmin); setLimit(String((data as AiAdmin).monthly_limit));
  }, [sb]);
  useEffect(() => { void load(); }, [load]);

  async function save(p: Record<string, unknown>, ok: string, withKey = false) {
    setBusy(true); setErr(""); setMsg("");
    const { data, error } = await sb.rpc("admin_ai_save", { p, p_api_key: withKey ? key : null });
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return; }
    if (withKey) setKey("");
    setS(data as AiAdmin); setMsg(ok);
  }
  async function test() {
    setBusy(true); setErr(""); setMsg("");
    const { data, error } = await sb.functions.invoke("atendente/test", { body: { scope: "platform" } });
    setBusy(false);
    if (error) setErr(errorMessage(error));
    else if ((data as { ok: boolean }).ok) setMsg("Chave funcionando.");
    else setErr((data as { error: string }).error ?? "A chave não funcionou.");
    void load();
  }
  async function tenantLimit(id: string, v: string) {
    const n = v.trim() === "" ? null : Number(v);
    if (n !== null && (!Number.isInteger(n) || n < 0)) { setErr("Limite inválido."); return; }
    const { error } = await sb.rpc("admin_ai_tenant_limit", { p_tenant_id: id, p_limit: n });
    if (error) setErr(errorMessage(error)); else { setMsg("Limite da loja atualizado."); void load(); }
  }

  if (!s) return <Alert>{err}</Alert>;
  return (
    <section className="card space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">Atendente IA no WhatsApp (Claude)</h2>
          <p className="text-sm text-zinc-500">
            {s.enabled ? "IA da plataforma ligada" : "IA da plataforma desligada: só lojas com chave própria usam o atendente."}
            {s.api_key_hint ? ` · chave ${s.api_key_hint}` : " · sem chave"} · limite padrão {s.monthly_limit.toLocaleString("pt-BR")} respostas/mês por loja
          </p>
          <p className={`mt-1 text-xs ${s.last_test?.ok ? "text-green-700" : s.last_test ? "text-red-700" : "text-zinc-500"}`}>
            Último teste: {s.last_test ? `${new Date(s.last_test.at).toLocaleString("pt-BR")} · ${s.last_test.ok ? "funcionando" : s.last_test.error ?? "falhou"}` : "não testado"}
          </p>
        </div>
        <Toggle checked={s.enabled} label="Ligar IA da plataforma" onChange={(v) => void save({ enabled: v }, v ? "IA da plataforma ligada." : "IA da plataforma desligada.")} />
      </div>
      <Alert>{err}</Alert>
      <Alert kind="success">{msg}</Alert>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex-1 text-sm">
          <span className="mb-1 block font-medium">Chave da API do Claude (Anthropic)</span>
          <input className="input" type="password" autoComplete="off" placeholder="sk-ant-..." value={key} onChange={(e) => setKey(e.target.value)} />
        </label>
        <button className="btn-secondary" disabled={busy || !key.trim()} onClick={() => void save({}, "Chave salva. Agora teste.", true)}>Salvar chave</button>
        <button className="btn-ghost" disabled={busy || !s.api_key_hint} onClick={() => void test()}>Testar</button>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-sm">
          <span className="mb-1 block font-medium">Limite padrão (respostas por mês, por loja)</span>
          <input className="input w-40" inputMode="numeric" value={limit} onChange={(e) => setLimit(e.target.value.replace(/\D/g, ""))} />
        </label>
        <button className="btn-secondary" disabled={busy || limit === String(s.monthly_limit) || !limit} onClick={() => void save({ monthly_limit: Number(limit) }, "Limite padrão atualizado.")}>Salvar limite</button>
      </div>
      <p className="text-xs text-zinc-500">
        O custo da IA da plataforma é seu: cada resposta é uma chamada ao modelo (Claude Opus 5.5, esforço baixo, com cache do cardápio). Lojas com chave própria não têm limite e pagam o uso direto na Anthropic.
        Ao passar do limite, a conversa vai para a equipe da loja.
      </p>
      {s.tenants.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-zinc-500">
              <tr><th className="p-2">Empresa</th><th className="p-2">Atendente</th><th className="p-2 text-right">Respostas no mês</th><th className="p-2 text-right">Tokens no mês</th><th className="p-2">Limite próprio</th></tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {s.tenants.map((t) => (
                <tr key={t.tenant_id}>
                  <td className="p-2 font-medium">{t.name}</td>
                  <td className="p-2 text-xs">{t.enabled ? "Ligado" : "Desligado"} · {t.use_own_key ? "chave própria" : "plataforma"}</td>
                  <td className="p-2 text-right tabular-nums">{t.use_own_key ? `${t.used_own} (própria)` : `${t.used_platform} / ${t.effective_limit}`}</td>
                  <td className="p-2 text-right tabular-nums">{t.tokens_month.toLocaleString("pt-BR")}</td>
                  <td className="p-2">
                    <input className="input w-28 py-1 text-xs" inputMode="numeric" placeholder="padrão" defaultValue={t.monthly_limit ?? ""}
                      aria-label={`Limite de ${t.name}`} onBlur={(e) => { if (e.target.value !== String(t.monthly_limit ?? "")) void tenantLimit(t.tenant_id, e.target.value); }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
