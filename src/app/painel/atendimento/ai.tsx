"use client";
import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { usePanel } from "@/lib/panel/context";
import { Alert, Toggle } from "@/components/ui";
import { errorMessage } from "@/lib/format";

type Settings = {
  enabled: boolean; unit_id: string | null; instructions: string | null; use_own_key: boolean; own_key_hint: string | null;
  own_key_test: { at: string; ok: boolean; error: string | null } | null; platform_available: boolean; monthly_limit: number;
  used_platform: number; used_own: number; wa_enabled: boolean; can_edit: boolean;
};
type Line = { role: "user" | "assistant"; text: string; handoff?: boolean; reason?: string };

async function fnError(error: unknown) {
  try { return (await (error as { context?: Response }).context?.json())?.error ?? errorMessage(error); } catch { return errorMessage(error); }
}

/** Atendente IA: configuração (dono) e teste da conversa (dono e gerente). */
export function AiAttendant({ onChanged }: { onChanged?: () => void }) {
  const { tenantId, units } = usePanel();
  const sb = supabaseBrowser();
  const [s, setS] = useState<Settings | null>(null);
  const [open, setOpen] = useState(false);
  const [instr, setInstr] = useState("");
  const [key, setKey] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [chat, setChat] = useState<Line[]>([]);
  const [ask, setAsk] = useState("");
  const [thinking, setThinking] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await sb.rpc("ai_settings_get", { p_tenant_id: tenantId });
    if (error) { setErr(errorMessage(error)); return; }
    const v = data as Settings;
    setS(v); setInstr(v.instructions ?? "");
  }, [sb, tenantId]);
  useEffect(() => { void load(); }, [load]);

  async function save(p: Record<string, unknown>, ok: string, ownKey?: string) {
    setBusy(true); setErr(""); setMsg("");
    const { data, error } = await sb.rpc("ai_settings_save", { p_tenant_id: tenantId, p, p_own_key: ownKey ?? null });
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return false; }
    setS(data as Settings); setMsg(ok); onChanged?.();
    return true;
  }
  async function testKey() {
    setBusy(true); setErr(""); setMsg("");
    const { data, error } = await sb.functions.invoke("atendente/test", { body: { scope: "tenant", tenant_id: tenantId } });
    setBusy(false);
    if (error) { setErr(await fnError(error)); return; }
    const r = data as { ok: boolean; error: string | null };
    if (r.ok) setMsg("Chave funcionando."); else setErr(r.error ?? "A chave não funcionou.");
    void load();
  }
  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!ask.trim()) return;
    const next: Line[] = [...chat, { role: "user", text: ask.trim() }];
    setChat(next); setAsk(""); setThinking(true); setErr("");
    const { data, error } = await sb.functions.invoke("atendente/preview", { body: { tenant_id: tenantId, messages: next.map((l) => ({ role: l.role, text: l.text })) } });
    setThinking(false);
    if (error) { setErr(await fnError(error)); return; }
    const r = data as { reply: string; handoff: boolean; reason: string };
    setChat([...next, { role: "assistant", text: r.reply, handoff: r.handoff, reason: r.reason }]);
    void load();
  }

  if (!s) return null;
  const used = s.use_own_key ? s.used_own : s.used_platform;
  const keyReady = s.use_own_key ? !!s.own_key_hint && s.own_key_test?.ok === true : s.platform_available;
  const status = s.enabled ? "Ligado" : "Desligado";

  return (
    <section className="card space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 font-semibold">Atendente IA
            <span className={`badge ${s.enabled ? "bg-green-100 text-green-800" : "bg-zinc-200 text-zinc-700"}`}>{status}</span></h2>
          <p className="text-sm text-zinc-600">Responde os clientes no WhatsApp sobre cardápio, preços, horário, entrega e situação do pedido, e manda o link do cardápio para pedir. Passa para a equipe quando não sabe ou quando o cliente pede.</p>
        </div>
        <div className="flex items-center gap-3">
          {s.can_edit && (
            <Toggle checked={s.enabled} label="Ligar atendente IA"
              onChange={(v) => void save({ enabled: v }, v ? "Atendente IA ligado. Ele responde as próximas mensagens." : "Atendente IA desligado.")} />
          )}
          <button className="btn-ghost text-sm" onClick={() => setOpen((v) => !v)} aria-expanded={open}>{open ? "Fechar" : "Configurar e testar"}</button>
        </div>
      </div>
      <Alert>{err}</Alert>
      <Alert kind="success">{msg}</Alert>
      {!s.wa_enabled && <p className="text-xs text-amber-800">O atendente responde pelo WhatsApp oficial, que ainda não está ligado (Marketing › WhatsApp). Dá para configurar e testar abaixo enquanto isso.</p>}
      {!s.use_own_key && !s.platform_available && <p className="text-xs text-amber-800">A IA da plataforma ainda não está disponível. Use a sua própria chave da API do Claude.</p>}

      {open && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-4 text-sm">
            {units.length > 1 && (
              <label className="block">
                <span className="mb-1 block font-medium">Loja que o atendente representa</span>
                <select className="input" disabled={!s.can_edit || busy} value={s.unit_id ?? ""} onChange={(e) => void save({ unit_id: e.target.value }, "Loja do atendente atualizada.")}>
                  {units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
                <span className="mt-1 block text-xs text-zinc-500">Ele usa o cardápio, o horário e as áreas de entrega desta loja.</span>
              </label>
            )}
            <label className="block">
              <span className="mb-1 block font-medium">Instruções da loja (opcional)</span>
              <textarea className="input min-h-[110px]" maxLength={2000} disabled={!s.can_edit} value={instr} onChange={(e) => setInstr(e.target.value)}
                placeholder="Ex.: A pizza grande serve 3 pessoas. Massa sem glúten só às sextas. Não fazemos meio a meio de doces." />
              <span className="mt-1 flex justify-between text-xs text-zinc-500"><span>Informações que não estão no cardápio. O atendente não inventa o que não está aqui.</span><span>{instr.length}/2000</span></span>
            </label>
            {s.can_edit && <button className="btn-secondary" disabled={busy || instr === (s.instructions ?? "")} onClick={() => void save({ instructions: instr }, "Instruções salvas.")}>Salvar instruções</button>}

            <fieldset className="space-y-2 rounded-xl bg-zinc-50 p-3">
              <legend className="px-1 font-medium">Chave da IA</legend>
              <label className="flex items-start gap-2">
                <input type="radio" name="aikey" className="mt-1 accent-brand-600" disabled={!s.can_edit || busy} checked={!s.use_own_key}
                  onChange={() => void save({ use_own_key: false }, "Usando a IA da plataforma.")} />
                <span>Da plataforma{s.platform_available ? "" : " (indisponível)"}
                  <span className="block text-xs text-zinc-500">Incluída no plano, até {s.monthly_limit.toLocaleString("pt-BR")} respostas por mês. Este mês: {s.used_platform.toLocaleString("pt-BR")}.</span></span>
              </label>
              <label className="flex items-start gap-2">
                <input type="radio" name="aikey" className="mt-1 accent-brand-600" disabled={!s.can_edit || busy || !s.own_key_hint} checked={s.use_own_key}
                  onChange={() => void save({ use_own_key: true }, "Usando a sua chave.")} />
                <span>Minha chave da API do Claude{s.own_key_hint ? ` (${s.own_key_hint})` : ""}
                  <span className="block text-xs text-zinc-500">Sem limite de respostas; o uso é cobrado pela Anthropic na sua conta. Este mês: {s.used_own.toLocaleString("pt-BR")}.</span></span>
              </label>
              {s.can_edit && (
                <div className="flex flex-wrap gap-2 pt-1">
                  <input className="input flex-1" type="password" autoComplete="off" placeholder="sk-ant-..." value={key} onChange={(e) => setKey(e.target.value)} aria-label="Sua chave da API do Claude" />
                  <button className="btn-secondary" disabled={busy || !key.trim()} onClick={async () => { if (await save({}, "Chave salva. Agora teste.", key)) setKey(""); }}>Salvar chave</button>
                  <button className="btn-ghost" disabled={busy || !s.own_key_hint} onClick={() => void testKey()}>Testar</button>
                </div>
              )}
              {s.own_key_test && (
                <p className={`text-xs ${s.own_key_test.ok ? "text-green-700" : "text-red-700"}`}>
                  {s.own_key_test.ok ? "Chave testada e funcionando." : `Teste falhou: ${s.own_key_test.error ?? ""}`} ({new Date(s.own_key_test.at).toLocaleString("pt-BR")})</p>
              )}
              <p className="text-xs text-zinc-500">A chave fica guardada no cofre do sistema e não aparece de novo depois de salva. Crie em console.anthropic.com › API Keys.</p>
            </fieldset>
            <p className="text-xs text-zinc-500">
              Na conversa: quando alguém da equipe responde, a IA sai da conversa por 12 horas. Quando a IA passa para a equipe, a conversa fica marcada
              com "Precisa de atendente" e ela para de responder até alguém devolver. O atendente não registra pedidos nem recebe pagamentos: ele manda o link do cardápio.
            </p>
          </div>

          <div className="flex min-h-[360px] flex-col rounded-xl ring-1 ring-zinc-200">
            <p className="border-b border-zinc-200 px-3 py-2 text-sm font-medium">Testar o atendente <span className="font-normal text-zinc-500">(não envia nada no WhatsApp; conta no limite do mês)</span></p>
            <div className="flex-1 space-y-2 overflow-y-auto bg-[#f4efe8] p-3 text-sm" aria-live="polite">
              {chat.length === 0 && <p className="text-center text-xs text-zinc-500">Escreva como um cliente, por exemplo: "Vocês entregam no centro? Quanto fica a taxa?"</p>}
              {chat.map((l, i) => (
                <div key={i} className={`flex ${l.role === "assistant" ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 shadow-sm ${l.role === "assistant" ? "rounded-br-md bg-emerald-100" : "rounded-bl-md bg-white"}`}>
                    {l.text}
                    {l.handoff && <span className="mt-1 block text-[11px] font-semibold text-amber-800">Passaria para a equipe: {l.reason || "sem motivo informado"}</span>}
                  </div>
                </div>
              ))}
              {thinking && <p className="text-right text-xs text-zinc-500">Respondendo...</p>}
            </div>
            <form onSubmit={send} className="flex gap-2 border-t border-zinc-200 p-2">
              <input className="input flex-1" maxLength={1000} placeholder="Mensagem do cliente" value={ask} onChange={(e) => setAsk(e.target.value)} aria-label="Mensagem de teste" />
              <button className="btn-primary" disabled={thinking || !ask.trim() || !keyReady}>Enviar</button>
              {chat.length > 0 && <button type="button" className="btn-ghost" onClick={() => setChat([])}>Limpar</button>}
            </form>
            {!keyReady && <p className="px-3 pb-2 text-xs text-amber-800">Para testar, use a IA da plataforma ou salve e teste a sua chave.</p>}
            {used >= s.monthly_limit && !s.use_own_key && <p className="px-3 pb-2 text-xs text-red-700">Limite de respostas do mês atingido.</p>}
          </div>
        </div>
      )}
    </section>
  );
}
