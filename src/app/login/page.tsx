"use client";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Alert, Field, Logo } from "@/components/ui";

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
  const next = safeNext(params.get("next"));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(""); setMsg(""); setBusy(true);
    const sb = supabaseBrowser();
    const redirectFor = (to: string) => `${window.location.origin}/auth/callback?next=${encodeURIComponent(to)}`;
    try {
      if (mode === "login") {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw new Error(error.message === "Invalid login credentials" ? "E-mail ou senha incorretos." : error.message);
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
    <main className="flex min-h-screen items-center justify-center bg-brand-50 px-4">
      <div className="w-full max-w-sm">
        <Link href="/" className="mb-6 flex justify-center"><Logo /></Link>
        <form onSubmit={submit} className="card space-y-4 p-6">
          <h1 className="text-xl font-bold">
            {mode === "login" ? "Entrar no painel" : mode === "signup" ? "Criar conta grátis" : "Recuperar senha"}
          </h1>
          {mode === "signup" && (
            <Field label="Seu nome"><input className="input" required value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></Field>
          )}
          <Field label="E-mail"><input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></Field>
          {mode !== "reset" && (
            <Field label="Senha" hint={mode === "signup" ? "Mínimo de 10 caracteres." : undefined}>
              <input className="input" type="password" required minLength={mode === "signup" ? 10 : 1} value={password}
                onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "signup" ? "new-password" : "current-password"} />
            </Field>
          )}
          <Alert>{err}</Alert>
          <Alert kind="success">{msg}</Alert>
          <button className="btn-primary w-full" disabled={busy}>
            {busy ? "Aguarde..." : mode === "login" ? "Entrar" : mode === "signup" ? "Criar conta" : "Enviar link"}
          </button>
          <div className="flex justify-between text-sm">
            {mode === "login" ? (
              <>
                <button type="button" className="text-brand-700 hover:underline" onClick={() => setMode("signup")}>Criar conta</button>
                <button type="button" className="text-zinc-500 hover:underline" onClick={() => setMode("reset")}>Esqueci a senha</button>
              </>
            ) : (
              <button type="button" className="text-brand-700 hover:underline" onClick={() => setMode("login")}>Já tenho conta</button>
            )}
          </div>
        </form>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return <Suspense><LoginForm /></Suspense>;
}
