"use client";
import Link from "next/link";
import { useEffect, useState } from "react";

const LINES = [
  ["Pedidos de todos os canais", "Cardápio próprio, 99Food, Keeta e aiqfome numa tela só."],
  ["Pix na hora", "QR Code com o valor exato gerado em cada pedido."],
  ["0% de comissão", "No seu cardápio digital, o lucro do pedido é seu."],
  ["Dados protegidos", "2FA, auditoria e backup diário criptografado."],
];

function Rotator() {
  const [i, setI] = useState(0);
  useEffect(() => { const t = setInterval(() => setI((x) => (x + 1) % LINES.length), 3800); return () => clearInterval(t); }, []);
  return (
    <div className="relative h-24" aria-live="polite">
      {LINES.map(([t, d], k) => (
        <div key={t} className={`absolute inset-0 transition-all duration-700 ${k === i ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0"}`} aria-hidden={k !== i}>
          <p className="text-2xl font-black tracking-tight">{t}</p>
          <p className="mt-1 text-white/75">{d}</p>
        </div>
      ))}
      <div className="absolute -bottom-2 left-0 flex gap-1.5">
        {LINES.map((_, k) => <span key={k} className={`h-1.5 rounded-full transition-all duration-500 ${k === i ? "w-8 bg-white" : "w-2 bg-white/35"}`} />)}
      </div>
    </div>
  );
}

export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-cream lg:grid lg:grid-cols-[1.05fr_1fr]">
      <aside className="relative isolate hidden overflow-hidden p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div aria-hidden="true" className="absolute inset-0 -z-10 animate-gradient bg-[linear-gradient(135deg,#1e1033_0%,#3b0d1a_45%,#b5121f_80%,#ea1d2c_100%)]" />
        <div aria-hidden="true" className="absolute -right-24 -top-24 -z-10 h-96 w-96 animate-blob rounded-full bg-red-brand/40 blur-3xl" />
        <div aria-hidden="true" className="absolute -bottom-32 -left-16 -z-10 h-96 w-96 animate-blob rounded-full bg-amber-400/20 blur-3xl [animation-delay:-7s]" />
        <div aria-hidden="true" className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_1px_1px,rgb(255_255_255/0.08)_1px,transparent_0)] [background-size:26px_26px]" />
        <Link href="/" className="w-fit"><img src="/brand/domma-food-logo-dark-transparent.svg" alt="Domma Food" className="h-11 w-auto" width={220} height={56} /></Link>
        <div className="grid grid-cols-[1fr_auto] items-center gap-10">
          <div>
            <h2 className="text-5xl font-black leading-[1.05] tracking-tight">A cozinha cheia.<br /><span className="text-amber-300">A gestão leve.</span></h2>
            <div className="mt-10"><Rotator /></div>
          </div>
          <div className="w-44 animate-float xl:w-52">
            <div className="rounded-[2.2rem] bg-navy-900 p-2 shadow-[0_30px_60px_-15px_rgb(0_0_0/0.6)] ring-1 ring-white/15">
              <div className="overflow-hidden rounded-[1.8rem]"><img src="/marketing/app-cardapio.webp" alt="" width={780} height={1309} className="block h-auto w-full" /></div>
            </div>
          </div>
        </div>
        <p className="text-sm text-white/60">© {new Date().getFullYear()} Domma Tecnologia · Domma Food</p>
      </aside>
      <section className="relative flex min-h-screen items-center justify-center px-4 py-10">
        <div aria-hidden="true" className="absolute inset-x-0 top-0 h-56 bg-gradient-to-b from-brand-50 to-transparent lg:hidden" />
        <div className="relative w-full max-w-sm animate-fade-in">
          <Link href="/" className="mb-8 flex justify-center lg:hidden"><img src="/brand/domma-food-logo.svg" alt="Domma Food" className="h-11 w-auto" width={220} height={56} /></Link>
          <div className="rounded-3xl bg-white p-6 shadow-[0_20px_50px_-20px_rgb(30_16_51/0.25)] ring-1 ring-zinc-100 sm:p-8">{children}</div>
          <p className="mt-6 text-center text-xs text-zinc-500">Conexão segura · seus dados protegidos pela LGPD</p>
        </div>
      </section>
    </main>
  );
}
