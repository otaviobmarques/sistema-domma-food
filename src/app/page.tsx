import Link from "next/link";
import { Logo, LogoMark } from "@/components/ui";

const Icon = {
  menu: <path d="M4 6h16M4 12h16M4 18h10" />,
  bolt: <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />,
  pix: <path d="m12 3 4 4-4 4-4-4 4-4Zm0 10 4 4-4 4-4-4 4-4ZM3 12l4-4 4 4-4 4-4-4Zm10 0 4-4 4 4-4 4-4-4Z" />,
  pin: <><path d="M12 21s-7-6.2-7-11a7 7 0 1 1 14 0c0 4.8-7 11-7 11Z" /><circle cx="12" cy="10" r="2.5" /></>,
  tag: <><path d="M3 12V4h8l10 10-8 8L3 12Z" /><circle cx="7.5" cy="8.5" r="1.5" /></>,
  shield: <><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3Z" /><path d="m9 12 2 2 4-4" /></>,
  chart: <path d="M4 20V10m6 10V4m6 16v-7m4 7H2" />,
  plug: <path d="M9 2v6m6-6v6M6 8h12v3a6 6 0 0 1-12 0V8Zm6 9v5" />,
};

function I({ d }: { d: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
  );
}

const features: [React.ReactNode, string, string][] = [
  [Icon.menu, "Cardápio digital próprio", "Seu cliente pede pelo celular, sem baixar app e sem comissão sobre cada pedido."],
  [Icon.bolt, "Pedidos em tempo real", "Todos os canais numa tela só, com alerta sonoro, cronômetro e impressão da comanda."],
  [Icon.pix, "Pix na hora", "QR Code e copia e cola gerados para cada pedido, com prazo de pagamento automático."],
  [Icon.pin, "Entrega por raio ou bairro", "Taxa, tempo e pedido mínimo por região, e frete grátis acima do valor que você definir."],
  [Icon.tag, "Cupons e clientes", "Cupons com regras inteligentes e histórico de cada cliente, pronto para campanhas."],
  [Icon.chart, "Dashboard que mostra o lucro", "Faturamento, ticket médio, horários de pico e os pratos que mais vendem."],
  [Icon.plug, "Marketplaces integrados", "Receba pedidos de 99Food, Keeta e outros apps pelo padrão Open Delivery."],
  [Icon.shield, "Segurança de verdade", "Dados isolados por empresa, verificação em duas etapas, auditoria e backup diário."],
];

const plans = [
  { name: "Essencial", price: "149", who: "Para começar no delivery", items: ["Cardápio digital", "Gestor de pedidos", "Cupons", "Pix por pedido"] },
  { name: "Delivery", price: "229", who: "Operação focada em entregas", items: ["Tudo do Essencial", "Áreas e taxas de entrega", "CRM de clientes", "Marketplaces"], highlight: true },
  { name: "Salão", price: "229", who: "Restaurante com mesas", items: ["Tudo do Essencial", "Mesas e comandas", "QR Code na mesa", "Monitor de cozinha"] },
  { name: "Completo", price: "389", who: "Operação híbrida", items: ["Tudo dos planos acima", "Estoque e ficha técnica", "Financeiro", "Assistente com IA"] },
];

function PhoneMock() {
  const items = [
    ["Pizza Margherita", "Molho de tomate, muçarela e manjericão", "54,90", "from-amber-300 to-orange-500"],
    ["Burger da Casa", "Blend 180g, cheddar e cebola caramelizada", "36,90", "from-orange-300 to-red-500"],
    ["Açaí 500 ml", "Com granola, banana e leite em pó", "24,00", "from-fuchsia-400 to-purple-700"],
  ];
  return (
    <div className="relative mx-auto w-[270px] rotate-[-2deg] rounded-[2.5rem] border-[10px] border-zinc-900 bg-zinc-900 shadow-2xl shadow-black/40">
      <div className="overflow-hidden rounded-[1.8rem] bg-cream text-zinc-900">
        <div className="h-24 bg-gradient-to-br from-amber-300 via-orange-400 to-brand-600" />
        <div className="-mt-7 px-4">
          <div className="grid h-14 w-14 place-items-center rounded-full border-4 border-white bg-brand-600 text-xl font-black text-white shadow">B</div>
          <p className="mt-1.5 text-sm font-extrabold">Bella Massa</p>
          <div className="mt-1 flex gap-1.5 text-[9px] font-semibold">
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-emerald-800">Aberto</span>
            <span className="rounded-full bg-white px-2 py-0.5 text-zinc-700 shadow-sm">30–45 min</span>
          </div>
          <div className="mt-3 flex gap-1.5 text-[9px] font-semibold">
            <span className="rounded-full bg-zinc-900 px-2.5 py-1 text-white">Destaques</span>
            <span className="rounded-full bg-white px-2.5 py-1 shadow-sm">Pizzas</span>
            <span className="rounded-full bg-white px-2.5 py-1 shadow-sm">Bebidas</span>
          </div>
          <div className="mt-3 space-y-2 pb-3">
            {items.map(([n, d, p, g]) => (
              <div key={n} className="flex gap-2 rounded-xl bg-white p-2 shadow-sm">
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] font-bold">{n}</p>
                  <p className="line-clamp-2 text-[8px] text-zinc-500">{d}</p>
                  <p className="mt-0.5 text-[10px] font-extrabold text-brand-600">R$ {p}</p>
                </div>
                <div className={`h-12 w-12 shrink-0 rounded-lg bg-gradient-to-br ${g}`} />
              </div>
            ))}
          </div>
        </div>
        <div className="mx-3 mb-3 flex justify-between rounded-xl bg-brand-600 px-3 py-2 text-[10px] font-bold text-white">
          <span>2 itens</span><span>Ver sacola · R$ 91,80</span>
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  return (
    <main className="overflow-x-hidden">
      <header className="relative overflow-hidden bg-gradient-to-br from-brand-600 via-brand-700 to-wine-900 text-white">
        <div aria-hidden="true" className="pointer-events-none absolute -right-32 -top-32 h-96 w-96 rounded-full bg-brand-400/30 blur-3xl" />
        <div aria-hidden="true" className="pointer-events-none absolute -bottom-40 left-1/3 h-96 w-96 rounded-full bg-amber-400/20 blur-3xl" />
        <nav className="relative mx-auto flex max-w-6xl items-center justify-between px-4 py-5">
          <Logo dark />
          <div className="flex items-center gap-1 sm:gap-2">
            <a href="#planos" className="btn hidden text-white/90 hover:bg-white/10 sm:inline-flex">Planos</a>
            <Link href="/login" className="btn text-white hover:bg-white/10">Entrar</Link>
            <Link href="/login?modo=cadastro" className="btn bg-white text-brand-700 shadow-lg shadow-black/10 hover:bg-brand-50">Testar grátis</Link>
          </div>
        </nav>
        <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-4 pb-20 pt-8 lg:grid-cols-[1.15fr_1fr] lg:pb-28 lg:pt-14">
          <div>
            <span className="badge bg-white/15 px-3 py-1 text-white ring-1 ring-white/25">Sem comissão por pedido</span>
            <h1 className="mt-5 text-4xl font-black leading-[1.05] tracking-tight sm:text-6xl">
              Venda mais comida.<br /><span className="text-amber-300">Pague menos taxa.</span>
            </h1>
            <p className="mt-5 max-w-xl text-lg leading-relaxed text-white/85">
              Cardápio digital próprio, pedidos em tempo real, Pix na hora e os marketplaces num lugar só.
              Tudo o que sua cozinha precisa, numa assinatura.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/login?modo=cadastro" className="btn bg-white px-6 py-3.5 text-base text-brand-700 shadow-xl shadow-black/15 hover:bg-brand-50">
                Criar minha loja grátis
              </Link>
              <a href="#como-funciona" className="btn px-6 py-3.5 text-base text-white ring-1 ring-white/40 hover:bg-white/10">Ver como funciona</a>
            </div>
            <p className="mt-4 text-sm text-white/70">14 dias grátis · sem cartão de crédito · pronto em 2 minutos</p>
          </div>
          <PhoneMock />
        </div>
      </header>

      <section className="mx-auto max-w-6xl px-4 py-20">
        <p className="text-sm font-bold uppercase tracking-widest text-brand-600">Tudo num só sistema</p>
        <h2 className="mt-2 max-w-2xl text-3xl font-black tracking-tight sm:text-4xl">Do pedido no celular ao lucro no fim do mês</h2>
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {features.map(([icon, t, d]) => (
            <div key={t} className="card transition hover:-translate-y-0.5 hover:shadow-lift">
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-brand-50 text-brand-600"><I d={icon} /></span>
              <h3 className="mt-4 font-bold">{t}</h3>
              <p className="mt-1 text-sm leading-relaxed text-zinc-600">{d}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="como-funciona" className="bg-white py-20">
        <div className="mx-auto max-w-6xl px-4">
          <p className="text-sm font-bold uppercase tracking-widest text-brand-600">Como funciona</p>
          <h2 className="mt-2 text-3xl font-black tracking-tight sm:text-4xl">Sua loja no ar hoje</h2>
          <ol className="mt-10 grid gap-6 md:grid-cols-3">
            {[
              ["Crie sua conta", "Informe o nome da loja e escolha o endereço do seu cardápio."],
              ["Monte o cardápio", "Cadastre produtos, fotos, complementos e áreas de entrega."],
              ["Divulgue o link", "Coloque no Instagram e no WhatsApp e receba pedidos na hora."],
            ].map(([t, d], i) => (
              <li key={t} className="relative rounded-2xl bg-cream p-6">
                <span className="text-5xl font-black text-brand-100">{String(i + 1).padStart(2, "0")}</span>
                <h3 className="mt-2 text-lg font-bold">{t}</h3>
                <p className="mt-1 text-sm text-zinc-600">{d}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-20">
        <div className="grid items-center gap-10 overflow-hidden rounded-3xl bg-wine-900 p-8 text-white sm:p-12 lg:grid-cols-2">
          <div>
            <p className="text-sm font-bold uppercase tracking-widest text-brand-300">Open Delivery</p>
            <h2 className="mt-2 text-3xl font-black tracking-tight">Marketplaces integrados ao seu gestor</h2>
            <p className="mt-3 text-white/75">
              Pedidos do 99Food, da Keeta e de outros apps que seguem o padrão aberto Open Delivery entram direto na
              mesma tela dos pedidos do seu cardápio. Sem tablet extra no balcão.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {["Cardápio próprio", "99Food", "Keeta", "WhatsApp", "Balcão", "Outros apps"].map((n, i) => (
              <div key={n} className={`flex items-center justify-center rounded-2xl px-3 py-5 text-center text-sm font-bold ${i === 0 ? "bg-brand-600" : "bg-white/10 ring-1 ring-white/15"}`}>{n}</div>
            ))}
          </div>
        </div>
      </section>

      <section id="planos" className="bg-white py-20">
        <div className="mx-auto max-w-6xl px-4">
          <p className="text-center text-sm font-bold uppercase tracking-widest text-brand-600">Planos</p>
          <h2 className="mt-2 text-center text-3xl font-black tracking-tight sm:text-4xl">Preço claro, sem taxa por pedido</h2>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {plans.map((p) => (
              <div key={p.name} className={`relative flex flex-col rounded-3xl p-6 ${p.highlight ? "bg-brand-600 text-white shadow-lift" : "border border-zinc-200 bg-cream"}`}>
                {p.highlight && <span className="badge absolute -top-3 left-6 bg-amber-300 text-amber-950">Mais escolhido</span>}
                <h3 className="text-lg font-extrabold">{p.name}</h3>
                <p className={`text-sm ${p.highlight ? "text-white/80" : "text-zinc-500"}`}>{p.who}</p>
                <p className="mt-4"><span className="text-sm font-semibold">R$</span> <span className="text-4xl font-black">{p.price}</span><span className={`text-sm ${p.highlight ? "text-white/80" : "text-zinc-500"}`}>/mês</span></p>
                <ul className="mt-5 flex-1 space-y-2 text-sm">
                  {p.items.map((i) => (
                    <li key={i} className="flex gap-2"><span className={p.highlight ? "text-amber-300" : "text-brand-600"}>✓</span>{i}</li>
                  ))}
                </ul>
                <Link href="/login?modo=cadastro" className={`btn mt-6 w-full ${p.highlight ? "bg-white text-brand-700 hover:bg-brand-50" : "btn-primary"}`}>Começar grátis</Link>
              </div>
            ))}
          </div>
          <p className="mt-6 text-center text-sm text-zinc-500">Adicionais: atendente com IA no WhatsApp, totem, NFC-e e unidade extra.</p>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-20 text-center">
        <h2 className="text-3xl font-black tracking-tight sm:text-4xl">Pronto para vender sem comissão?</h2>
        <Link href="/login?modo=cadastro" className="btn-primary mt-6 px-8 py-4 text-base">Criar minha loja grátis</Link>
      </section>

      <footer className="bg-wine-900 text-white/70">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 py-10 text-sm sm:flex-row">
          <span className="inline-flex items-center gap-2 font-bold text-white"><LogoMark className="h-7 w-7" /> domma food</span>
          <p>© {new Date().getFullYear()} Domma Tecnologia · Feito para quem vende comida</p>
        </div>
      </footer>
    </main>
  );
}
