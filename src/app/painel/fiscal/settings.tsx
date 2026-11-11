"use client";
import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { usePanel } from "@/lib/panel/context";
import { Alert, Field, Toggle } from "@/components/ui";
import { errorMessage, onlyDigits } from "@/lib/format";

export type FiscalSettings = {
  unit_id: string; enabled: boolean; provider: string; environment: "homologacao" | "producao";
  cnpj: string | null; legal_name: string | null; state_registration: string | null; tax_regime: "1" | "2" | "3";
  default_ncm: string; default_cfop: string; default_icms_cst: string; default_origin: string;
  auto_emit: boolean; include_marketplace: boolean; token_hint: string | null;
  last_test_at: string | null; last_test_ok: boolean | null; last_test_message: string | null;
};

export const ORIGINS: [string, string][] = [
  ["0", "0 · Nacional"], ["1", "1 · Estrangeira (importação direta)"], ["2", "2 · Estrangeira (mercado interno)"],
  ["3", "3 · Nacional, importado 40–70%"], ["4", "4 · Nacional, processo básico"], ["5", "5 · Nacional, importado até 40%"],
  ["6", "6 · Estrangeira, sem similar (direta)"], ["7", "7 · Estrangeira, sem similar (interno)"], ["8", "8 · Nacional, importado acima de 70%"],
];

export const formatCnpj = (v: string) => {
  const d = onlyDigits(v).slice(0, 14);
  return d.replace(/^(\d{2})(\d)/, "$1.$2").replace(/^(\d{2})\.(\d{3})(\d)/, "$1.$2.$3")
    .replace(/\.(\d{3})(\d)/, ".$1/$2").replace(/(\d{4})(\d)/, "$1-$2");
};

type Form = {
  cnpj: string; legal_name: string; state_registration: string; tax_regime: string; environment: string;
  default_ncm: string; default_cfop: string; default_icms_cst: string; default_origin: string;
  auto_emit: boolean; include_marketplace: boolean; token: string;
};
const toForm = (s: FiscalSettings | null): Form => ({
  cnpj: s?.cnpj ? formatCnpj(s.cnpj) : "", legal_name: s?.legal_name ?? "", state_registration: s?.state_registration ?? "",
  tax_regime: s?.tax_regime ?? "1", environment: s?.environment ?? "homologacao",
  default_ncm: s?.default_ncm ?? "21069090", default_cfop: s?.default_cfop ?? "5102", default_icms_cst: s?.default_icms_cst ?? "102",
  default_origin: s?.default_origin ?? "0", auto_emit: s?.auto_emit ?? false, include_marketplace: s?.include_marketplace ?? false, token: "",
});

export function SettingsForm({ settings, isOwner, onSaved }: { settings: FiscalSettings | null; isOwner: boolean; onSaved: () => Promise<void> }) {
  const { unit } = usePanel();
  const sb = supabaseBrowser();
  const [f, setF] = useState<Form>(toForm(settings));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  useEffect(() => { setF(toForm(settings)); }, [settings]);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setErr(""); setMsg("");
    const cnpj = onlyDigits(f.cnpj);
    if (cnpj && cnpj.length !== 14) { setErr("O CNPJ precisa ter 14 dígitos."); return; }
    if (!/^\d{8}$/.test(f.default_ncm)) { setErr("O NCM padrão precisa ter 8 dígitos."); return; }
    if (!/^\d{4}$/.test(f.default_cfop)) { setErr("O CFOP padrão precisa ter 4 dígitos."); return; }
    if (!/^\d{2,3}$/.test(f.default_icms_cst)) { setErr("O CST/CSOSN padrão precisa ter 2 ou 3 dígitos."); return; }
    setBusy(true);
    const p = {
      cnpj, legal_name: f.legal_name, state_registration: f.state_registration, tax_regime: f.tax_regime, environment: f.environment,
      default_ncm: f.default_ncm, default_cfop: f.default_cfop, default_icms_cst: f.default_icms_cst, default_origin: f.default_origin,
      auto_emit: f.auto_emit, include_marketplace: f.include_marketplace,
    };
    const { error } = await sb.rpc("fiscal_save_settings", { p_unit_id: unit.id, p, p_token: f.token.trim() || null });
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return; }
    setMsg(f.token.trim() ? "Configuração salva. Agora teste a conexão com o provedor." : "Configuração salva.");
    await onSaved();
  }

  const ro = !isOwner;
  return (
    <form onSubmit={save} className="card space-y-4">
      <div>
        <h2 className="font-semibold">Dados da empresa e do provedor</h2>
        {ro && <p className="mt-1 text-sm text-zinc-500">Somente o dono da conta altera a configuração fiscal. Você pode consultar os dados abaixo.</p>}
      </div>
      <fieldset disabled={ro} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="CNPJ"><input className="input tabular-nums" inputMode="numeric" value={f.cnpj} onChange={(e) => set("cnpj", formatCnpj(e.target.value))} placeholder="00.000.000/0000-00" /></Field>
          <Field label="Razão social"><input className="input" maxLength={120} value={f.legal_name} onChange={(e) => set("legal_name", e.target.value)} /></Field>
          <Field label="Inscrição estadual"><input className="input" maxLength={20} value={f.state_registration} onChange={(e) => set("state_registration", e.target.value)} /></Field>
          <Field label="Regime tributário">
            <select className="input" value={f.tax_regime} onChange={(e) => set("tax_regime", e.target.value)}>
              <option value="1">Simples Nacional</option>
              <option value="2">Simples Nacional – excesso de sublimite</option>
              <option value="3">Regime normal</option>
            </select>
          </Field>
          <Field label="Ambiente" hint={f.environment === "homologacao" ? "Homologação: notas de teste, sem valor fiscal." : "Produção: notas com valor fiscal, enviadas à SEFAZ."}>
            <select className="input" value={f.environment} onChange={(e) => set("environment", e.target.value)}>
              <option value="homologacao">Homologação (testes)</option>
              <option value="producao">Produção</option>
            </select>
          </Field>
          <Field label="Token da API do provedor (Focus NFe)" hint={settings?.token_hint ? `Token atual termina em ${settings.token_hint}. Use o token do mesmo ambiente escolhido.` : "Copie o token no painel do provedor. Ele fica guardado criptografado e nunca é exibido."}>
            <input className="input" type="password" autoComplete="new-password" value={f.token} onChange={(e) => set("token", e.target.value)}
              placeholder={settings?.token_hint ? "Deixe em branco para manter o atual" : "Cole o token aqui"} />
          </Field>
        </div>

        <div>
          <h3 className="text-sm font-semibold">Padrões para os produtos</h3>
          <p className="text-xs text-zinc-500">Usados quando o produto não tem dados fiscais próprios no Cardápio. Confirme os códigos com o seu contador.</p>
          <div className="mt-2 grid gap-3 sm:grid-cols-4">
            <Field label="NCM" hint="21069090 · Preparações alimentícias diversas — confirme com o contador">
              <input className="input tabular-nums" inputMode="numeric" maxLength={8} value={f.default_ncm} onChange={(e) => set("default_ncm", onlyDigits(e.target.value))} />
            </Field>
            <Field label="CFOP"><input className="input tabular-nums" inputMode="numeric" maxLength={4} value={f.default_cfop} onChange={(e) => set("default_cfop", onlyDigits(e.target.value))} /></Field>
            <Field label="CST / CSOSN" hint="102 é comum no Simples Nacional"><input className="input tabular-nums" inputMode="numeric" maxLength={3} value={f.default_icms_cst} onChange={(e) => set("default_icms_cst", onlyDigits(e.target.value))} /></Field>
            <Field label="Origem">
              <select className="input" value={f.default_origin} onChange={(e) => set("default_origin", e.target.value)}>
                {ORIGINS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </Field>
          </div>
        </div>

        <div className="space-y-3 rounded-lg border border-zinc-200 p-3">
          <label className="flex items-start justify-between gap-4 text-sm">
            <span><span className="font-medium">Emitir automaticamente</span>
              <span className="block text-xs text-zinc-500">PDV na hora da venda; delivery e retirada quando o pedido pago é concluído; mesas ao fechar a conta.</span></span>
            <Toggle checked={f.auto_emit} onChange={(v) => set("auto_emit", v)} label="Emitir automaticamente" />
          </label>
          <label className="flex items-start justify-between gap-4 text-sm">
            <span><span className="font-medium">Incluir pedidos de marketplace</span>
              <span className="block text-xs text-zinc-500">iFood, 99Food, Keeta e aiqfome. Deixe desligado se a nota já é emitida por outro meio.</span></span>
            <Toggle checked={f.include_marketplace} onChange={(v) => set("include_marketplace", v)} label="Incluir pedidos de marketplace" />
          </label>
        </div>
      </fieldset>
      <Alert>{err}</Alert>
      <Alert kind="success">{msg}</Alert>
      {isOwner && <button className="btn-primary" disabled={busy}>{busy ? "Salvando..." : "Salvar configuração"}</button>}
    </form>
  );
}
