"use client";
import Link from "next/link";
import { useEffect, useState } from "react";

const NAV = [["#recursos", "Recursos"], ["#modulos", "Módulos"], ["#integracoes", "Integrações"], ["#planos", "Planos"], ["#duvidas", "Dúvidas"]];

export function SiteHeader() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 12);
    on(); window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  return (
    <header className={`fixed inset-x-0 top-0 z-50 transition-all duration-300 ${scrolled || open ? "bg-white/85 shadow-[0_1px_0_rgb(0_0_0/0.06)] backdrop-blur-xl" : "bg-transparent"}`}>
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
        <Link href="/" aria-label="Domma Food — início" className="shrink-0">
          <img src={scrolled || open ? "/brand/domma-food-logo.svg" : "/brand/domma-food-logo-dark-transparent.svg"} alt="Domma Food" className="h-9 w-auto transition-opacity" width={190} height={48} />
        </Link>
        <nav className="hidden items-center gap-1 lg:flex" aria-label="Principal">
          {NAV.map(([h, l]) => (
            <a key={h} href={h} className={`rounded-lg px-3 py-2 text-sm font-medium transition ${scrolled ? "text-zinc-700 hover:bg-zinc-100 hover:text-zinc-900" : "text-white/85 hover:bg-white/10 hover:text-white"}`}>{l}</a>
          ))}
        </nav>
        <div className="hidden items-center gap-2 lg:flex">
          <Link href="/login" className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${scrolled ? "text-zinc-800 hover:bg-zinc-100" : "text-white hover:bg-white/10"}`}>Entrar</Link>
          <Link href="/login?modo=cadastro" className="rounded-xl bg-red-brand px-4 py-2.5 text-sm font-bold text-white shadow-[0_8px_20px_-8px_rgb(234_29_44/0.8)] transition hover:-translate-y-0.5 hover:bg-brand-700">Teste grátis</Link>
        </div>
        <button className={`grid h-10 w-10 place-items-center rounded-xl lg:hidden ${scrolled || open ? "text-zinc-900" : "text-white"}`} onClick={() => setOpen(!open)} aria-expanded={open} aria-label="Abrir menu">
          <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
          </svg>
        </button>
      </div>
      {open && (
        <div className="animate-fade-in border-t border-zinc-100 bg-white px-4 pb-5 pt-2 lg:hidden">
          {NAV.map(([h, l]) => (
            <a key={h} href={h} onClick={() => setOpen(false)} className="block rounded-lg px-3 py-3 text-base font-medium text-zinc-800 hover:bg-zinc-50">{l}</a>
          ))}
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Link href="/login" className="btn-secondary py-3">Entrar</Link>
            <Link href="/login?modo=cadastro" className="btn-primary py-3">Teste grátis</Link>
          </div>
        </div>
      )}
    </header>
  );
}
