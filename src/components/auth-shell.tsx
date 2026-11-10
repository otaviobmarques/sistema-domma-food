import Link from "next/link";
import { Logo } from "@/components/ui";

const points = ["Cardápio digital sem comissão", "Pedidos em tempo real com Pix", "99Food e Keeta no mesmo gestor", "Dados protegidos e backup diário"];

export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen lg:grid lg:grid-cols-[1.05fr_1fr]">
      <aside className="relative hidden overflow-hidden bg-gradient-to-br from-brand-600 via-brand-700 to-wine-900 p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div aria-hidden="true" className="absolute -right-24 -top-24 h-80 w-80 rounded-full bg-brand-400/30 blur-3xl" />
        <div aria-hidden="true" className="absolute -bottom-32 -left-10 h-80 w-80 rounded-full bg-amber-400/20 blur-3xl" />
        <Link href="/" className="relative"><Logo dark /></Link>
        <div className="relative">
          <h2 className="text-4xl font-black leading-tight tracking-tight">A cozinha cheia.<br /><span className="text-amber-300">A gestão leve.</span></h2>
          <ul className="mt-8 space-y-3 text-white/90">
            {points.map((p) => (
              <li key={p} className="flex items-center gap-3">
                <span className="grid h-6 w-6 place-items-center rounded-full bg-white/15 text-xs">✓</span>{p}
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-sm text-white/60">© {new Date().getFullYear()} Domma Tecnologia</p>
      </aside>
      <section className="flex min-h-screen items-center justify-center bg-cream px-4 py-10">
        <div className="w-full max-w-sm">
          <Link href="/" className="mb-8 flex justify-center lg:hidden"><Logo /></Link>
          {children}
        </div>
      </section>
    </main>
  );
}
