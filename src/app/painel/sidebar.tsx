"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { canManage, usePanel } from "@/lib/panel/context";
import { Logo } from "@/components/ui";

const NAV: { href: string; label: string; icon: string; manage?: boolean }[] = [
  { href: "/painel", label: "Dashboard", icon: "▦", manage: true },
  { href: "/painel/pedidos", label: "Pedidos", icon: "☰" },
  { href: "/painel/cardapio", label: "Cardápio", icon: "◫", manage: true },
  { href: "/painel/entregas", label: "Áreas de entrega", icon: "➤", manage: true },
  { href: "/painel/cupons", label: "Cupons", icon: "%", manage: true },
  { href: "/painel/clientes", label: "Clientes", icon: "☺", manage: true },
  { href: "/painel/configuracoes", label: "Configurações", icon: "⚙", manage: true },
  { href: "/painel/seguranca", label: "Segurança", icon: "⛨" },
];

export function Sidebar() {
  const { unit, units, role, email } = usePanel();
  const path = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const items = NAV.filter((n) => !n.manage || canManage(role));

  function switchUnit(id: string) {
    document.cookie = `df_unit=${id}; path=/; max-age=31536000; samesite=lax; secure`;
    router.refresh();
  }

  return (
    <>
      <div className="flex items-center justify-between bg-brand-800 px-4 py-3 lg:hidden">
        <Logo dark />
        <button className="text-white" onClick={() => setOpen(!open)} aria-label="Menu">☰</button>
      </div>
      <aside className={`${open ? "block" : "hidden"} bg-brand-800 text-brand-100 lg:sticky lg:top-0 lg:block lg:h-screen lg:w-60 lg:shrink-0`}>
        <div className="flex h-full flex-col p-4">
          <div className="hidden lg:block"><Logo dark /></div>
          {units.length > 1 ? (
            <select className="mt-4 w-full rounded-lg bg-brand-900 px-2 py-2 text-sm text-white" value={unit.id} onChange={(e) => switchUnit(e.target.value)}>
              {units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          ) : (
            <p className="mt-4 truncate text-sm font-medium text-white">{unit.name}</p>
          )}
          <a href={`/loja/${unit.slug}`} target="_blank" rel="noopener" className="mt-1 text-xs text-brand-200 hover:text-white">
            Ver cardápio ↗
          </a>
          <nav className="mt-6 flex-1 space-y-1">
            {items.map((n) => {
              const active = n.href === "/painel" ? path === "/painel" : path.startsWith(n.href);
              return (
                <Link key={n.href} href={n.href} onClick={() => setOpen(false)}
                  className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm ${active ? "bg-white/15 font-semibold text-white" : "hover:bg-white/10"}`}>
                  <span className="w-4 text-center">{n.icon}</span>{n.label}
                </Link>
              );
            })}
          </nav>
          <div className="border-t border-white/10 pt-3 text-xs">
            <p className="truncate">{email}</p>
            <button className="mt-2 text-brand-200 hover:text-white"
              onClick={async () => { await supabaseBrowser().auth.signOut(); router.replace("/login"); router.refresh(); }}>
              Sair
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
