"use client";
import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Alert } from "@/components/ui";

type S = { client_id: string | null; has_secret: boolean; last_test_at: string | null; last_test_ok: boolean | null; last_test_message: string | null; connections: number };

/** Credenciais do aplicativo do Domma no iFood (aplicativo distribuído, um para toda a plataforma). */
export function IfoodAppSettings() {
  const sb = supabaseBrowser();
  const [s, setS] = useState<S | null>(null);
  const [cid, setCid] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const load = useCallback(async () => {
    const { data, error } = await sb.rpc("admin_ifood_settings");
    if (error) { setErr(error.message); return; }
    setS(data as S); setCid((x) => x || (data as S).client_id || "");
  }, [sb]);
  useEffect(() => { void load(); }, [load]);

  async function save() {
    setBusy("save"); setErr(""); setMsg("");
    const { error } = await sb.rpc("admin_ifood_save", { p_client_id: cid, p_client_secret: secret || null });
    setBusy("");
    if (error) setErr(error.message); else { setSecret(""); setMsg("Credenciais salvas. Teste a conexão."); await load(); }
  }
  async function test() {
    setBusy("test"); setErr(""); setMsg("");
    const { data, error } = await sb.functions.invoke("ifood/test", { body: {} });
    setBusy("");
    if (error) setErr(error.message); else if (data?.ok) setMsg(data.message); else setErr(data?.message ?? data?.error ?? "Falhou.");
    await load();
  }
  if (!s) return err ? <Alert>{err}</Alert> : null;
  return (
    <section className="card space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">App do Domma no iFood</h2>
          <p className="text-sm text-zinc-500">
            {s.client_id && s.has_secret ? `Configurado · ${s.connections} loja(s) conectada(s)` : "Não configurado: as lojas ainda não veem o botão Conectar iFood."}
          </p>
          <p className={`mt-1 text-xs ${s.last_test_ok ? "text-green-700" : s.last_test_ok === false ? "text-red-700" : "text-zinc-500"}`}>
            Último teste: {s.last_test_at ? `${new Date(s.last_test_at).toLocaleString("pt-BR")} · ${s.last_test_message ?? ""}` : "não testado"}
          </p>
        </div>
        <button className="btn-secondary" disabled={!!busy || !s.client_id} onClick={() => void test()}>{busy === "test" ? "Testando..." : "Testar"}</button>
      </div>
      <Alert>{err}</Alert>
      <Alert kind="success">{msg}</Alert>
      <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end">
        <label className="block"><span className="label">Client ID</span>
          <input className="input font-mono" value={cid} onChange={(e) => setCid(e.target.value.trim())} /></label>
        <label className="block"><span className="label">Client secret {s.has_secret ? "(deixe vazio para manter)" : ""}</span>
          <input className="input font-mono" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} /></label>
        <button className="btn-primary" disabled={!!busy || !cid} onClick={() => void save()}>Salvar</button>
      </div>
      <p className="text-xs text-zinc-500">
        Crie no Portal do Desenvolvedor iFood um aplicativo <b>distribuído</b> com os módulos Order, Merchant e Events, e passe pela homologação do iFood.
        Cada loja conecta pelo painel (Integrações) com um código de vínculo.
      </p>
    </section>
  );
}
