"use client";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { loginIdToEmail } from "@/lib/auth";
import { Alert, Field } from "@/components/ui";
import { AuthShell } from "@/components/auth-shell";

function safeNext(n: string | null) {
  return n && n.startsWith("/") && !n.startsWith("//") ? n : "/painel";
}

function LoginForm() {
  const params = useSearchParams();
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "signup" | "reset">(params.get("modo") === "cadastro" ? "signup" : "login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [showPwd, setShowPwd] = useState(false);
  const next = safeNext(params.get("next"));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(""); setMsg(""); setBusy(true);
    const sb = supabaseBrowser();
    const redirectFor = (to: string) => `${window.location.origin}/auth/callback?next=${encodeURIComponent(to)}`;
    try {
      if (mode === "login") {
        const { error } = await sb.auth.signInWithPassword({ email: loginIdToEmail(email), password });
        if (error) throw new Error(error.message === "Invalid login credentials" ? "Usuário/e-mail ou senha incorretos." : error.message);
        router.replace(next);
        router.refresh();
      } else if (mode === "signup") {
        if (password.length < 10) throw new Error("Use uma senha com pelo menos 10 caracteres.");
        const { data, error } = await sb.auth.signUp({ email, password, options: { data: { full_name: name }, emailRedirectTo: redirectFor("/onboarding") } });
        if (error) throw error;
        if (data.session) { router.replace("/onboarding"); router.refresh(); }
        else setMsg("Enviamos um link de confirmação para o seu e-mail. Clique nele para continuar.");
      } else {
        const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: redirectFor("/painel/seguranca?nova-senha=1") });
        if (error) throw error;
        setMsg("Se o e-mail existir, você vai receber um link para criar uma nova senha.");
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Não foi possível continuar.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell>
        <form onSubmit={submit}>
          {mode !== "reset" && (
            <div className="relative mb-6 grid grid-cols-2 rounded-2xl bg-zinc-100 p-1 text-sm font-bold" role="tablist">
              <span aria-hidden="true" className={`absolute inset-y-1 w-[calc(50%-4px)] rounded-xl bg-white shadow-sm transition-transform duration-300 ${mode === "signup" ? "translate-x-[calc(100%+4px)]" : "translate-x-1"}`} />
              <button type="button" role="tab" aria-selected={mode === "login"} onClick={() => { setMode("login"); setErr(""); setMsg(""); }}
                className={`relative z-10 rounded-xl py-2.5 transition ${mode === "login" ? "text-navy-900" : "text-zinc-500 hover:text-zinc-800"}`}>Entrar</button>
              <button type="button" role="tab" aria-selected={mode === "signup"} onClick={() => { setMode("signup"); setErr(""); setMsg(""); }}
                className={`relative z-10 rounded-xl py-2.5 transition ${mode === "signup" ? "text-navy-900" : "text-zinc-500 hover:text-zinc-800"}`}>Criar conta</button>
            </div>
          )}
          <div key={mode} className="animate-fade-in space-y-4">
          <div className="mb-2">
            <h1 className="text-3xl font-black tracking-tight text-navy-900">
              {mode === "login" ? "Bem-vindo de volta" : mode === "signup" ? "Crie sua loja grátis" : "Recuperar senha"}
            </h1>
            <p className="mt-1 text-sm text-zinc-500">
              {mode === "login" ? "Entre para acessar o painel da sua loja." : mode === "signup" ? "14 dias grátis, sem cartão de crédito." : "Enviaremos um link para criar uma nova senha."}
            </p>
          </div>
          {mode === "signup" && (
            <Field label="Seu nome"><input className="input" required value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></Field>
          )}
          <Field label={mode === "login" ? "E-mail ou usuário" : "E-mail"}><input className="input" type={mode === "login" ? "text" : "email"} required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete={mode === "login" ? "username" : "email"} autoCapitalize="none" /></Field>
          {mode !== "reset" && (
            <Field label="Senha" hint={mode === "signup" ? "Mínimo de 10 caracteres." : undefined}>
              <span className="relative block">
                <input className="input pr-16" type={showPwd ? "text" : "password"} required minLength={mode === "signup" ? 10 : 1} value={password}
                  onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "signup" ? "new-password" : "current-password"} />
                <button type="button" onClick={() => setShowPwd(!showPwd)} aria-label={showPwd ? "Ocultar senha" : "Mostrar senha"}
                  className="absolute inset-y-0 right-2 my-auto h-8 rounded-lg px-2 text-xs font-semibold text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-800">
                  {showPwd ? "Ocultar" : "Mostrar"}
                </button>
              </span>
            </Field>
          )}
          <Alert>{err}</Alert>
          <Alert kind="success">{msg}</Alert>
          <button className="btn-primary group w-full py-3.5 text-base transition hover:-translate-y-0.5" disabled={busy}>
            {busy && <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden="true" />}
            {busy ? "Aguarde..." : mode === "login" ? "Entrar" : mode === "signup" ? "Criar conta" : "Enviar link"}
          </button>
          <div className="flex justify-between pt-1 text-sm">
            {mode === "login" ? (
              <button type="button" className="text-zinc-500 transition hover:text-brand-700 hover:underline" onClick={() => setMode("reset")}>Esqueci a senha</button>
            ) : mode === "reset" ? (
              <button type="button" className="font-semibold text-brand-700 hover:underline" onClick={() => setMode("login")}>← Voltar para o login</button>
            ) : (
              <span className="text-xs text-zinc-500">Ao criar a conta você aceita os termos de uso e a política de privacidade.</span>
            )}
          </div>
          </div>
        </form>
    </AuthShell>
  );
}

export default function LoginPage() {
  return <Suspense><LoginForm /></Suspense>;
}
