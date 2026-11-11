"use client";
import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { usePanel } from "@/lib/panel/context";
import { Alert, Field, Modal } from "@/components/ui";
import { errorMessage } from "@/lib/format";
import { ago, type Agent } from "./shared";

export function Agents({ agents, onChanged }: { agents: Agent[]; onChanged: () => Promise<void> | void }) {
  const { unit } = usePanel();
  const sb = supabaseBrowser();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("Computador da cozinha");
  const [token, setToken] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState("");
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 10000); return () => clearInterval(t); }, []);

  const active = agents.filter((a) => a.active);
  const cmd = token ? `node print-agent.mjs --token ${token}` : "";

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr("");
    const { data, error } = await sb.rpc("print_agent_create", { p_unit_id: unit.id, p_name: name });
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return; }
    setToken(data as string); await onChanged();
  }
  async function revoke(a: Agent) {
    if (!confirm(`Desconectar "${a.name}"? A chave deixa de funcionar e o programa daquele computador para de imprimir.`)) return;
    const { error } = await sb.rpc("print_agent_revoke", { p_agent_id: a.id });
    if (error) setErr(errorMessage(error)); else await onChanged();
  }
  async function copy(text: string, key: string) {
    try { await navigator.clipboard.writeText(text); setCopied(key); setTimeout(() => setCopied(""), 2000); } catch { /* sem permissão */ }
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">Computadores conectados</h2>
          <p className="text-sm text-zinc-500">Para impressoras de rede ou do computador, um programa pequeno roda no computador da loja e imprime a fila.</p>
        </div>
        <button className="btn-secondary" onClick={() => { setOpen(true); setToken(null); setErr(""); }}>+ Conectar computador</button>
      </div>
      <Alert>{err && !open ? err : ""}</Alert>
      {active.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-300 p-4 text-center text-sm text-zinc-500">Nenhum computador conectado. Se usa só a impressão pelo navegador, não precisa.</p>
      ) : (
        <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 bg-white">
          {active.map((a) => {
            const online = !!a.last_seen_at && Date.now() - new Date(a.last_seen_at).getTime() < 30_000;
            return (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
                <span>
                  <span className="font-medium">{a.name}</span>
                  <span className={`badge ml-2 ${online ? "bg-green-100 text-green-800" : "bg-zinc-100 text-zinc-600"}`}>
                    {online ? "Conectado" : a.last_seen_at ? `Desconectado há ${ago(a.last_seen_at)}` : "Ainda não conectou"}
                  </span>
                  {a.last_seen_info && <span className="block text-xs text-zinc-500">{a.last_seen_info}</span>}
                </span>
                <button className="btn-ghost text-red-600" onClick={() => revoke(a)}>Desconectar</button>
              </li>
            );
          })}
        </ul>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="Conectar computador">
        {!token ? (
          <form onSubmit={create} className="space-y-3">
            <Field label="Nome do computador"><input className="input" required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Alert>{err}</Alert>
            <button className="btn-primary w-full" disabled={busy}>{busy ? "Gerando chave..." : "Gerar chave de conexão"}</button>
          </form>
        ) : (
          <div className="space-y-4 text-sm">
            <Alert kind="info">Guarde esta chave agora. Por segurança ela não aparece de novo; se perder, desconecte e gere outra.</Alert>
            <div>
              <p className="label">Chave</p>
              <div className="flex gap-2">
                <code className="input flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs">{token}</code>
                <button type="button" className="btn-secondary" onClick={() => copy(token, "token")}>{copied === "token" ? "Copiado" : "Copiar"}</button>
              </div>
            </div>
            <ol className="list-decimal space-y-2 pl-5 text-zinc-700">
              <li>Instale o Node.js 18 ou mais novo: <a className="text-brand-700 underline" href="https://nodejs.org" target="_blank" rel="noopener noreferrer">nodejs.org</a>.</li>
              <li>Baixe o programa: <a className="text-brand-700 underline" href="/print-agent.mjs" download>print-agent.mjs</a> e salve numa pasta (ex.: Documentos\DommaFood).</li>
              <li>
                Abra o terminal (Prompt de Comando) nessa pasta e rode:
                <div className="mt-1 flex gap-2">
                  <code className="flex-1 overflow-x-auto whitespace-nowrap rounded-lg bg-zinc-900 px-3 py-2 font-mono text-xs text-zinc-100">{cmd}</code>
                  <button type="button" className="btn-secondary" onClick={() => copy(cmd, "cmd")}>{copied === "cmd" ? "Copiado" : "Copiar"}</button>
                </div>
              </li>
              <li>Deixe a janela aberta. Para iniciar junto com o Windows, crie um atalho com esse comando na pasta Inicializar (Win + R, digite <code className="font-mono">shell:startup</code>).</li>
            </ol>
            <p className="text-xs text-zinc-500">O programa só conversa com a Domma Food e com as impressoras da sua rede. Ele aparece aqui como &quot;Conectado&quot; em alguns segundos.</p>
            <button className="btn-primary w-full" onClick={() => setOpen(false)}>Concluir</button>
          </div>
        )}
      </Modal>
    </section>
  );
}
