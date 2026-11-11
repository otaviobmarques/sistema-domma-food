"use client";
import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { canManage, usePanel } from "@/lib/panel/context";
import { Alert, Empty, Toggle } from "@/components/ui";
import { errorMessage } from "@/lib/format";
import { SettingsForm, type FiscalSettings } from "./settings";
import { Documents } from "./documents";

export default function Fiscal() {
  const { unit, role } = usePanel();
  const sb = supabaseBrowser();
  const isOwner = role === "owner";
  const [s, setS] = useState<FiscalSettings | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [testing, setTesting] = useState(false);
  const [toggling, setToggling] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await sb.from("fiscal_settings").select("*").eq("unit_id", unit.id).maybeSingle();
    if (error) setErr(errorMessage(error)); else setS((data as FiscalSettings | null) ?? null);
    setLoaded(true);
  }, [sb, unit.id]);
  useEffect(() => { if (canManage(role)) load(); }, [load, role]);

  async function test() {
    setTesting(true); setErr(""); setMsg("");
    const { data, error } = await sb.functions.invoke("fiscal/test", { body: { unit_id: unit.id } });
    setTesting(false);
    if (error) {
      let m = errorMessage(error);
      try { const b = await (error as { context?: Response }).context?.json(); if (b?.error) m = b.error; } catch { /* sem corpo */ }
      setErr(m);
    } else if (data?.ok) setMsg(data.message);
    else setErr(data?.message ?? "Não foi possível testar a conexão.");
    await load();
  }

  async function setEnabled(v: boolean) {
    setToggling(true); setErr(""); setMsg("");
    const { error } = await sb.rpc("fiscal_save_settings", { p_unit_id: unit.id, p: { enabled: v }, p_token: null });
    setToggling(false);
    if (error) setErr(errorMessage(error)); else setMsg(v ? "NFC-e ativada." : "NFC-e desativada. Nenhuma nota nova será emitida.");
    await load();
  }

  if (!canManage(role)) return <Empty>A configuração fiscal é acessada pela gerência.</Empty>;

  const prod = s?.environment === "producao";
  return (
    <div className="space-y-5">
      <div>
        <h1 className="h1">Nota fiscal (NFC-e)</h1>
        <p className="text-sm text-zinc-500">Emissão de NFC-e pelo provedor Focus NFe. Nada é emitido até a conta no provedor, o certificado digital e o CSC estarem configurados.</p>
      </div>
      <Alert>{err}</Alert>
      <Alert kind="success">{msg}</Alert>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="card space-y-4" aria-label="Situação">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-medium text-zinc-500">Situação</p>
              <p className={`mt-1 text-xl font-semibold ${s?.enabled ? "text-green-700" : "text-zinc-700"}`}>{s?.enabled ? "NFC-e ativada" : "NFC-e desativada"}</p>
            </div>
            {isOwner && (
              <label className="flex items-center gap-3 text-sm font-medium">
                Ativar NFC-e
                <Toggle checked={!!s?.enabled} onChange={(v) => { if (!toggling) void setEnabled(v); }} label="Ativar NFC-e" />
              </label>
            )}
          </div>
          <dl className="grid gap-3 text-sm sm:grid-cols-3">
            <div className="rounded-lg border border-zinc-200 p-3"><dt className="text-xs text-zinc-500">Ambiente</dt>
              <dd className="mt-0.5 font-medium">{prod ? "Produção" : "Homologação"}</dd>
              <dd className="text-xs text-zinc-500">{prod ? "Notas com valor fiscal" : "Testes, sem valor fiscal"}</dd></div>
            <div className="rounded-lg border border-zinc-200 p-3"><dt className="text-xs text-zinc-500">Provedor</dt>
              <dd className="mt-0.5 font-medium">Focus NFe</dd>
              <dd className="text-xs text-zinc-500">{s?.token_hint ? `Token ••••${s.token_hint}` : "Token não informado"}</dd></div>
            <div className="rounded-lg border border-zinc-200 p-3"><dt className="text-xs text-zinc-500">Último teste</dt>
              <dd className={`mt-0.5 font-medium ${s?.last_test_ok ? "text-green-700" : s?.last_test_ok === false ? "text-red-700" : ""}`}>
                {s?.last_test_at ? (s.last_test_ok ? "Conexão OK" : "Falhou") : "Não testado"}</dd>
              <dd className="text-xs text-zinc-500">{s?.last_test_at ? new Date(s.last_test_at).toLocaleString("pt-BR") : "—"}</dd></div>
          </dl>
          {s?.last_test_message && <p className="text-xs text-zinc-600">{s.last_test_message}</p>}
          {isOwner && (
            <button className="btn-secondary" disabled={testing || !s?.token_hint} onClick={test}>
              {testing ? "Testando..." : "Testar conexão"}
            </button>
          )}
          {prod && !s?.last_test_ok && <p className="text-xs text-amber-800">Para emitir em produção, teste a conexão com o token de produção antes de ativar.</p>}
        </section>

        <aside className="card space-y-2 text-sm" aria-label="Antes de começar">
          <h2 className="font-semibold">Antes de começar</h2>
          <ol className="list-decimal space-y-1.5 pl-5 text-zinc-700">
            <li>Contrate um provedor de NFC-e (<a className="font-medium text-brand-700 underline" href="https://focusnfe.com.br" target="_blank" rel="noopener noreferrer">Focus NFe</a>) e cadastre a empresa lá.</li>
            <li>Envie o certificado digital A1 da empresa no painel do provedor.</li>
            <li>Gere o CSC (código de segurança do contribuinte) na SEFAZ do seu estado e cadastre no provedor.</li>
            <li>Confirme que a inscrição estadual está habilitada para emitir NFC-e.</li>
            <li>Confirme NCM, CFOP e CSOSN dos produtos com o seu contador.</li>
          </ol>
          <p className="text-xs text-zinc-500">Comece em homologação: as notas de teste não têm valor fiscal. Depois troque para produção com o token de produção.</p>
        </aside>
      </div>

      {loaded && <SettingsForm settings={s} isOwner={isOwner} onSaved={load} />}
      <Documents />
    </div>
  );
}
