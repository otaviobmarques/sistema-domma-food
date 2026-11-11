"use client";
import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Alert } from "@/components/ui";

type S = { project_id: string; team_id: string | null; has_token: boolean; last_test_at: string | null; last_test_ok: boolean | null;
  last_test_message: string | null; active: number; pending: number };

/** Token da Vercel usado para cadastrar os domínios próprios das lojas no projeto. */
export function DomainsSettings() {
  const sb = supabaseBrowser();
  const [s, setS] = useState<S | null>(null);
  const [f, setF] = useState({ project_id: "", team_id: "" });
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const load = useCallback(async () => {
    const { data, error } = await sb.rpc("admin_domains_settings");
    if (error) { setErr(error.message); return; }
    const v = data as S; setS(v);
    setF((x) => x.project_id ? x : { project_id: v.project_id, team_id: v.team_id ?? "" });
  }, [sb]);
  useEffect(() => { void load(); }, [load]);
  async function save() {
    setBusy("save"); setErr(""); setMsg("");
    const { error } = await sb.rpc("admin_domains_save", { p_project_id: f.project_id, p_team_id: f.team_id || null, p_token: token || null });
    setBusy("");
    if (error) setErr(error.message); else { setToken(""); setMsg("Salvo. Teste a conexão."); await load(); }
  }
  async function test() {
    setBusy("test"); setErr(""); setMsg("");
    const { data, error } = await sb.functions.invoke("domains/test", { body: {} });
    setBusy("");
    if (error) setErr(error.message); else if (data?.ok) setMsg(data.message); else setErr(data?.message ?? data?.error ?? "Falhou.");
    await load();
  }
  if (!s) return err ? <Alert>{err}</Alert> : null;
  return (
    <section className="card space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">Domínios próprios das lojas (Vercel)</h2>
          <p className="text-sm text-zinc-500">{s.has_token ? `Liberado · ${s.active} ativo(s), ${s.pending} aguardando DNS` : "Sem token: as lojas ainda não podem usar domínio próprio."}</p>
          <p className={`mt-1 text-xs ${s.last_test_ok ? "text-green-700" : s.last_test_ok === false ? "text-red-700" : "text-zinc-500"}`}>
            Último teste: {s.last_test_at ? `${new Date(s.last_test_at).toLocaleString("pt-BR")} · ${s.last_test_message ?? ""}` : "não testado"}
          </p>
        </div>
        <button className="btn-secondary" disabled={!!busy || !s.has_token} onClick={() => void test()}>{busy === "test" ? "Testando..." : "Testar"}</button>
      </div>
      <Alert>{err}</Alert>
      <Alert kind="success">{msg}</Alert>
      <div className="grid gap-3 md:grid-cols-[1fr_1fr_1fr_auto] md:items-end">
        <label className="block"><span className="label">ID do projeto</span>
          <input className="input font-mono" value={f.project_id} onChange={(e) => setF({ ...f, project_id: e.target.value.trim() })} /></label>
        <label className="block"><span className="label">ID do time</span>
          <input className="input font-mono" value={f.team_id} onChange={(e) => setF({ ...f, team_id: e.target.value.trim() })} /></label>
        <label className="block"><span className="label">Token {s.has_token ? "(deixe vazio para manter)" : ""}</span>
          <input className="input font-mono" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} /></label>
        <button className="btn-primary" disabled={!!busy || !f.project_id} onClick={() => void save()}>Salvar</button>
      </div>
      <p className="text-xs text-zinc-500">Crie o token em vercel.com › Account Settings › Tokens, com acesso ao time do projeto. Ele fica guardado criptografado e só é usado para cadastrar e conferir domínios.</p>
    </section>
  );
}
