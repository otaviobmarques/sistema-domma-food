import type { Metadata } from "next";
import Link from "next/link";
import { SiteHeader } from "@/components/marketing/header";
import { RevealOnScroll } from "@/components/marketing/reveal";
import { BrowserFrame, PhoneFrame } from "@/components/marketing/frames";
import { ModuleTabs } from "@/components/marketing/module-tabs";
import { Counter } from "@/components/marketing/counter";

export const metadata: Metadata = {
  title: "Domma Food · Cardápio digital, delivery e gestão sem comissão",
  description: "Venda pelo seu próprio cardápio digital, receba pedidos do 99Food, Keeta e aiqfome no mesmo gestor, Pix na hora e gestão completa. 14 dias grátis.",
  openGraph: {
    title: "Domma Food · Venda mais, pague menos taxa",
    description: "Cardápio digital próprio, gestor de pedidos em tempo real e marketplaces num lugar só.",
    images: [{ url: "/marketing/painel-pedidos.webp", width: 2400, height: 1500, alt: "Gestor de pedidos do Domma Food" }],
    locale: "pt_BR", type: "website",
  },
};

const I = {
  bolt: "M13 2 4 14h7l-1 8 9-12h-7l1-8Z",
  pix: "M12 2 2 12l10 10 10-10L12 2Zm0 5 5 5-5 5-5-5 5-5Z",
  shield: "M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3Z",
  percent: "M19 5 5 19M7.5 9.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm9 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
  bell: "M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8Zm4.5 12a1.5 1.5 0 0 0 3 0",
  chart: "M4 20V10m6 10V4m6 16v-7m4 7H2",
  phone: "M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm3 17h2",
  map: "M12 21s7-6.1 7-12a7 7 0 1 0-14 0c0 5.9 7 12 7 12Zm0-9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  lock: "M6 11h12v10H6V11Zm2 0V7a4 4 0 1 1 8 0v4",
  cloud: "M7 18a5 5 0 1 1 1-9.9A6 6 0 0 1 19.6 10 4 4 0 0 1 18 18H7Z",
  eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  doc: "M7 3h7l5 5v13H7V3Zm7 0v5h5M10 13h6M10 17h6",
  tag: "M3 12V4h8l10 10-8 8L3 12Zm5-4h.01",
  users: "M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1m7-9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm13 9v-1a4 4 0 0 0-3-3.9M16 4.1a3 3 0 0 1 0 5.8",
  plug: "M9 2v6m6-6v6M6 8h12v4a6 6 0 0 1-12 0V8Zm6 10v4",
};
function Icon({ d, className = "h-6 w-6" }: { d: string; className?: string }) {
  return <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
}

const CHANNELS: [string, string][] = [
  ["Cardápio próprio", "bg-white text-navy-900 ring-zinc-200"],
  ["WhatsApp", "bg-green-600 text-white ring-green-700"],
  ["99Food", "bg-yellow-300 text-zinc-900 ring-yellow-400"],
  ["Keeta", "bg-zinc-900 text-yellow-300 ring-zinc-900"],
  ["aiqfome", "bg-purple-700 text-white ring-purple-800"],
  ["Retirada no balcão", "bg-white text-navy-900 ring-zinc-200"],
  ["Pedido agendado", "bg-white text-navy-900 ring-zinc-200"],
];

const FEATURES = [
  { icon: I.percent, t: "Sem comissão por pedido", d: "No seu cardápio digital você paga só a assinatura. O lucro do pedido fica com você." },
  { icon: I.bell, t: "Pedido na tela na hora", d: "Alerta sonoro, cronômetro e kanban em tempo real. Nada se perde no WhatsApp." },
  { icon: I.pix, t: "Pix gerado automaticamente", d: "QR Code e copia e cola com o valor certo em cada pedido. Expira sozinho se não pagar." },
  { icon: I.phone, t: "Cliente pede sem baixar app", d: "Cardápio bonito no celular, complementos, meio a meio, cupom e acompanhamento ao vivo." },
  { icon: I.map, t: "Entrega por raio ou bairro", d: "Taxa, tempo e pedido mínimo por região, com frete grátis acima de um valor." },
  { icon: I.plug, t: "Marketplaces no mesmo lugar", d: "99Food, Keeta e aiqfome entram no gestor com o selo de cada um." },
  { icon: I.chart, t: "Números que importam", d: "Faturamento, ticket médio, horários de pico e produtos campeões." },
  { icon: I.shield, t: "Segurança de banco", d: "Dados isolados por empresa, 2FA, auditoria e backup diário criptografado." },
];

const STEPS = [
  { img: "/marketing/app-cardapio.webp", t: "Escolhe no cardápio", d: "Fotos, destaques e busca. Abre direto pelo link ou QR Code." },
  { img: "/marketing/app-produto.webp", t: "Personaliza o pedido", d: "Complementos, borda, meio a meio e observações." },
  { img: "/marketing/app-checkout.webp", t: "Finaliza em segundos", d: "Entrega ou retirada, cupom e forma de pagamento." },
  { img: "/marketing/app-pix.webp", t: "Paga no Pix e acompanha", d: "QR Code na hora e status do pedido em tempo real." },
];

const PLANS = [
  { name: "Essencial", price: "149", for: "Para quem está começando no delivery", items: ["Cardápio digital próprio", "Gestor de pedidos em tempo real", "Pix com QR Code na hora", "Cupons de desconto", "Dashboard"], hl: false, soon: "" },
  { name: "Delivery", price: "229", for: "Operação focada em entrega", items: ["Tudo do Essencial", "Áreas de entrega por raio e bairro", "Clientes, cashback e pontos", "Integração 99Food, Keeta e aiqfome", "Relatórios de vendas"], hl: false, soon: "" },
  { name: "Completo", price: "389", for: "Operação completa e redes", items: ["Tudo do Delivery e do Salão", "Até 3 lojas", "Auditoria e 2FA para a equipe", "Prioridade no suporte", "Novos módulos sem custo extra"], hl: true, soon: "" },
  { name: "Salão", price: "229", for: "Restaurante com mesas", items: ["Tudo do Essencial", "Mesas e comandas", "Caixa e PDV de balcão", "KDS (monitor de cozinha)", "Taxa de serviço e divisão da conta"], hl: false, soon: "" },
];

const FAQ = [
  ["Preciso contratar um servidor ou VPS?", "Não. O Domma Food é 100% on-line: roda na nuvem (Vercel e Supabase, com servidores em São Paulo), com atualizações, segurança e backups por nossa conta. Você só precisa de um navegador."],
  ["Vocês cobram taxa por pedido?", "No seu cardápio digital próprio, não: você paga apenas a mensalidade do plano. Taxas dos marketplaces (99Food, Keeta, aiqfome) e das maquininhas continuam sendo deles."],
  ["Integra com 99Food, Keeta e aiqfome?", "Sim. Usamos o padrão aberto Open Delivery, aceito pelos três. Os pedidos entram no gestor com o selo de cada marketplace e o status volta automaticamente. Você só precisa das credenciais de integrador de cada um."],
  ["E com o iFood?", "A integração com o iFood usa a API própria deles e exige homologação. Está no nosso roadmap; avisamos assim que estiver liberada."],
  ["Como funciona o Pix?", "Cada pedido gera um QR Code e um código copia e cola com o valor exato, na sua chave Pix. Você confirma o recebimento com um toque e o pedido segue para o preparo. Pix não pago expira sozinho."],
  ["Posso usar meu próprio domínio?", "Hoje sua loja fica em um endereço do Domma Food (ex.: /loja/sua-pizzaria). O domínio próprio, como pedido.suapizzaria.com.br, está chegando."],
  ["Meus dados e os dos meus clientes estão seguros?", "Sim. Cada empresa tem os dados isolados no banco, o acesso tem perfis e verificação em duas etapas, toda alteração importante fica registrada e há backup diário criptografado. Seguimos a LGPD."],
  ["Como coloco meu cardápio no sistema?", "Você cadastra categorias, produtos, fotos e complementos no painel em poucos minutos. Ao criar a loja já deixamos um exemplo pronto para você editar."],
];

export default function Home() {
  return (
    <div className="overflow-x-clip bg-white text-zinc-900">
      <RevealOnScroll />
      <SiteHeader />

      {/* HERO */}
      <section className="relative isolate overflow-hidden bg-navy-950 pb-20 pt-28 text-white sm:pb-28 sm:pt-32">
        <div aria-hidden="true" className="absolute inset-0 -z-10 animate-gradient bg-[linear-gradient(120deg,#1e1033_0%,#3b0d1a_40%,#b5121f_75%,#ea1d2c_100%)] opacity-95" />
        <div aria-hidden="true" className="absolute -left-32 top-10 -z-10 h-96 w-96 animate-blob rounded-full bg-red-brand/40 blur-3xl" />
        <div aria-hidden="true" className="absolute -right-20 bottom-0 -z-10 h-[28rem] w-[28rem] animate-blob rounded-full bg-amber-400/20 blur-3xl [animation-delay:-6s]" />
        <div aria-hidden="true" className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_1px_1px,rgb(255_255_255/0.08)_1px,transparent_0)] [background-size:28px_28px]" />

        <div className="mx-auto grid max-w-7xl items-center gap-14 px-4 sm:px-6 lg:grid-cols-[1.02fr_1fr]">
          <div data-reveal>
            <span className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-white ring-1 ring-white/20 backdrop-blur">
              <span className="h-2 w-2 animate-pulse-ring rounded-full bg-red-brand" /> 0% de comissão no seu cardápio próprio
            </span>
            <h1 className="mt-6 text-[2.6rem] font-black leading-[1.02] tracking-tight sm:text-6xl lg:text-[3.8rem]">
              Venda mais.<br />
              <span className="bg-gradient-to-r from-amber-300 via-orange-300 to-white bg-clip-text text-transparent">Pague menos taxa.</span>
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-white/80">
              Cardápio digital próprio, gestor de pedidos em tempo real, Pix na hora e 99Food, Keeta e aiqfome
              no mesmo lugar. Tudo o que sua cozinha precisa, numa assinatura só.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link href="/login?modo=cadastro" className="group inline-flex items-center justify-center gap-2 rounded-2xl bg-white px-6 py-4 text-base font-bold text-navy-900 shadow-[0_20px_40px_-15px_rgb(0_0_0/0.6)] transition hover:-translate-y-0.5 hover:bg-brand-50">
                Criar minha loja grátis
                <svg viewBox="0 0 20 20" className="h-5 w-5 transition group-hover:translate-x-1" fill="currentColor" aria-hidden="true"><path d="M11 4l6 6-6 6-1.4-1.4L13.2 11H3V9h10.2L9.6 5.4 11 4Z" /></svg>
              </Link>
              <Link href="/loja/bella-massa" className="inline-flex items-center justify-center gap-2 rounded-2xl px-6 py-4 text-base font-semibold text-white ring-1 ring-white/30 transition hover:bg-white/10">
                <Icon d={I.eye} className="h-5 w-5" /> Ver loja de demonstração
              </Link>
            </div>
            <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm text-white/75">
              {["14 dias grátis", "Sem cartão de crédito", "Pix na hora", "Pronto em 2 minutos"].map((t) => (
                <li key={t} className="flex items-center gap-2">
                  <svg viewBox="0 0 20 20" className="h-4 w-4 text-amber-300" fill="currentColor" aria-hidden="true"><path d="M7.6 13.6 4 10l-1.4 1.4 5 5 10-10L16.2 5l-8.6 8.6Z" /></svg>{t}
                </li>
              ))}
            </ul>
          </div>

          <div className="relative mx-auto w-full max-w-xl lg:max-w-none" data-reveal="zoom" style={{ ["--d" as string]: "150ms" }}>
            <div className="animate-float">
              <BrowserFrame src="/marketing/painel-pedidos.webp" alt="Gestor de pedidos do Domma Food com pedidos do cardápio próprio, 99Food, Keeta e aiqfome" priority />
            </div>
            <div className="absolute -bottom-10 -left-4 w-[34%] min-w-[118px] animate-float-slow sm:-left-10">
              <PhoneFrame src="/marketing/app-cardapio.webp" alt="Cardápio digital no celular" priority />
            </div>
            <div className="absolute -top-5 right-2 animate-toast sm:-right-4">
              <div className="flex items-center gap-3 rounded-2xl bg-white px-4 py-3 text-zinc-900 shadow-[0_20px_40px_-12px_rgb(0_0_0/0.5)]">
                <span className="grid h-9 w-9 place-items-center rounded-xl bg-yellow-300 text-[11px] font-black text-zinc-900">99</span>
                <div className="leading-tight">
                  <p className="text-xs font-semibold text-zinc-500">Novo pedido · 99Food</p>
                  <p className="text-sm font-extrabold">#7702 · R$ 99,80</p>
                </div>
              </div>
            </div>
            <div className="absolute -right-2 bottom-6 hidden animate-toast rounded-2xl bg-white px-4 py-3 text-zinc-900 shadow-[0_20px_40px_-12px_rgb(0_0_0/0.5)] [animation-delay:-3s] sm:block">
              <p className="text-xs font-semibold text-emerald-700">Pix recebido ✓</p>
              <p className="text-sm font-extrabold">Pedido #348 · R$ 97,80</p>
            </div>
          </div>
        </div>
      </section>

      {/* CANAIS */}
      <section aria-label="Canais de venda" className="border-b border-zinc-100 bg-white py-8">
        <p className="mb-5 text-center text-xs font-bold uppercase tracking-[0.2em] text-zinc-500">Receba pedidos de todos os canais num só gestor</p>
        <div className="relative overflow-hidden [mask-image:linear-gradient(90deg,transparent,black_10%,black_90%,transparent)]">
          <div className="flex w-max animate-marquee gap-3">
            {[...CHANNELS, ...CHANNELS].map(([n, c], i) => (
              <span key={i} className={`shrink-0 rounded-full px-5 py-2.5 text-sm font-extrabold ring-1 ${c}`}>{n}</span>
            ))}
          </div>
        </div>
      </section>

      {/* NÚMEROS */}
      <section className="bg-cream py-16">
        <div className="mx-auto grid max-w-6xl grid-cols-2 gap-4 px-4 sm:px-6 lg:grid-cols-4">
          {[
            [<Counter key="a" to={0} suffix="%" />, "de comissão no seu cardápio próprio"],
            [<span key="b">&lt; <Counter to={2} suffix=" s" /></span>, "para o pedido aparecer no painel"],
            [<Counter key="c" to={14} suffix=" dias" />, "grátis para testar tudo"],
            [<Counter key="d" to={24} suffix="/7" />, "no ar, com backup diário"],
          ].map(([n, l], i) => (
            <div key={i} data-reveal style={{ ["--d" as string]: `${i * 90}ms` }} className="rounded-3xl bg-white p-6 text-center shadow-soft ring-1 ring-zinc-100">
              <p className="text-4xl font-black tracking-tight text-red-brand sm:text-5xl">{n}</p>
              <p className="mt-2 text-sm text-zinc-600">{l}</p>
            </div>
          ))}
        </div>
      </section>

      {/* RECURSOS */}
      <section id="recursos" className="py-20 sm:py-28">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <div className="mx-auto max-w-3xl text-center" data-reveal>
            <p className="text-sm font-bold uppercase tracking-[0.2em] text-red-brand">Tudo num só sistema</p>
            <h2 className="mt-3 text-3xl font-black tracking-tight text-navy-900 sm:text-5xl">Do pedido no celular ao lucro no fim do mês</h2>
            <p className="mt-4 text-lg text-zinc-600">Pare de alternar entre WhatsApp, caderno, maquininha e marketplace. O Domma Food organiza tudo.</p>
          </div>
          <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map((f, i) => (
              <div key={f.t} data-reveal style={{ ["--d" as string]: `${(i % 4) * 80}ms` }}
                className="group rounded-3xl border border-zinc-100 bg-white p-6 shadow-soft transition duration-300 hover:-translate-y-1.5 hover:border-brand-100 hover:shadow-lift">
                <span className="grid h-12 w-12 place-items-center rounded-2xl bg-brand-50 text-red-brand transition group-hover:scale-110 group-hover:bg-red-brand group-hover:text-white">
                  <Icon d={f.icon} />
                </span>
                <h3 className="mt-5 text-lg font-extrabold text-navy-900">{f.t}</h3>
                <p className="mt-2 text-sm leading-relaxed text-zinc-600">{f.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* MÓDULOS */}
      <section id="modulos" className="bg-cream py-20 sm:py-28">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <div className="max-w-3xl" data-reveal>
            <p className="text-sm font-bold uppercase tracking-[0.2em] text-red-brand">Conheça por dentro</p>
            <h2 className="mt-3 text-3xl font-black tracking-tight text-navy-900 sm:text-5xl">Telas reais do sistema, não maquete</h2>
            <p className="mt-4 text-lg text-zinc-600">Clique nos módulos e veja como é o dia a dia da sua loja no Domma Food.</p>
          </div>
          <div className="mt-12" data-reveal><ModuleTabs /></div>
        </div>
      </section>

      {/* CLIENTE PEDE ASSIM */}
      <section className="relative overflow-hidden bg-navy-900 py-20 text-white sm:py-28">
        <div aria-hidden="true" className="absolute -right-40 top-0 h-[30rem] w-[30rem] animate-blob rounded-full bg-red-brand/25 blur-3xl" />
        <div className="relative mx-auto max-w-7xl px-4 sm:px-6">
          <div className="grid items-end gap-6 lg:grid-cols-2" data-reveal>
            <div>
              <p className="text-sm font-bold uppercase tracking-[0.2em] text-amber-300">App do seu cliente</p>
              <h2 className="mt-3 text-3xl font-black tracking-tight sm:text-5xl">Seu cliente pede assim</h2>
            </div>
            <p className="text-lg text-white/75 lg:text-right">Sem baixar aplicativo e sem criar conta. Rápido no 4G e com a cara da sua marca.</p>
          </div>
          <div className="no-scrollbar -mx-4 mt-12 flex snap-x snap-mandatory gap-6 overflow-x-auto px-4 pb-4 lg:mx-0 lg:grid lg:grid-cols-4 lg:overflow-visible lg:px-0">
            {STEPS.map((s, i) => (
              <div key={s.t} data-reveal style={{ ["--d" as string]: `${i * 110}ms` }} className="w-[72vw] max-w-[280px] shrink-0 snap-center lg:w-auto lg:max-w-none">
                <PhoneFrame src={s.img} alt={s.t} className="transition duration-500 hover:-translate-y-2" />
                <div className="mt-5 flex gap-3">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-red-brand text-sm font-black">{i + 1}</span>
                  <div>
                    <h3 className="font-extrabold">{s.t}</h3>
                    <p className="mt-1 text-sm text-white/70">{s.d}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-10 text-center" data-reveal>
            <Link href="/loja/bella-massa" className="inline-flex items-center gap-2 rounded-2xl bg-white px-6 py-3.5 font-bold text-navy-900 transition hover:-translate-y-0.5">
              Testar a loja de demonstração <span aria-hidden="true">→</span>
            </Link>
          </div>
        </div>
      </section>

      {/* INTEGRAÇÕES */}
      <section id="integracoes" className="py-20 sm:py-28">
        <div className="mx-auto grid max-w-7xl items-center gap-12 px-4 sm:px-6 lg:grid-cols-[1fr_1.15fr]">
          <div data-reveal="left">
            <p className="text-sm font-bold uppercase tracking-[0.2em] text-red-brand">Integrações</p>
            <h2 className="mt-3 text-3xl font-black tracking-tight text-navy-900 sm:text-5xl">Marketplaces, Pix e muito mais. Tudo conversando.</h2>
            <p className="mt-4 text-lg text-zinc-600">
              Conectamos pelo <b>Open Delivery</b>, o padrão aberto da Abrasel. Os pedidos chegam no seu gestor com o selo do canal,
              e o status volta sozinho para o marketplace.
            </p>
            <div className="mt-8 grid gap-3 sm:grid-cols-2">
              {[["99Food", "Pronto", "bg-yellow-300 text-zinc-900"], ["Keeta", "Pronto", "bg-zinc-900 text-yellow-300"], ["aiqfome", "Pronto", "bg-purple-700 text-white"],
                ["Pix com QR Code", "Pronto", "bg-emerald-600 text-white"], ["WhatsApp com IA", "Em breve", "bg-green-600 text-white"], ["Pixel Meta e Google", "Em breve", "bg-sky-700 text-white"]]
                .map(([n, s, c]) => (
                  <div key={n} className="flex items-center justify-between rounded-2xl bg-white p-4 shadow-soft ring-1 ring-zinc-100 transition hover:-translate-y-0.5 hover:shadow-lift">
                    <span className={`rounded-full px-3 py-1 text-sm font-extrabold ${c}`}>{n}</span>
                    <span className={`text-xs font-bold ${s === "Pronto" ? "text-emerald-700" : "text-zinc-500"}`}>{s}</span>
                  </div>
                ))}
            </div>
          </div>
          <div data-reveal="right"><BrowserFrame src="/marketing/painel-integracoes.webp" alt="Tela de integrações com 99Food, Keeta e aiqfome" /></div>
        </div>
      </section>

      {/* SEGURANÇA */}
      <section className="bg-cream py-20 sm:py-28">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <div className="mx-auto max-w-3xl text-center" data-reveal>
            <p className="text-sm font-bold uppercase tracking-[0.2em] text-red-brand">Segurança e confiabilidade</p>
            <h2 className="mt-3 text-3xl font-black tracking-tight text-navy-900 sm:text-5xl">Feito para sexta à noite lotada</h2>
            <p className="mt-4 text-lg text-zinc-600">Sua operação não pode parar e os dados dos seus clientes não podem vazar.</p>
          </div>
          <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {[
              [I.lock, "Dados isolados por empresa", "Cada loja só enxerga os próprios dados, com regras aplicadas direto no banco."],
              [I.shield, "Verificação em duas etapas", "2FA com app autenticador para quem administra a loja."],
              [I.doc, "Auditoria de tudo", "Mudança de preço, cupom, cancelamento e acesso ficam registrados."],
              [I.cloud, "Backup diário criptografado", "Cópias automáticas e uma cópia externa independente todos os dias."],
              [I.map, "Servidores em São Paulo", "Nuvem com rede global e banco de dados no Brasil, para mais velocidade."],
              [I.users, "LGPD de verdade", "Opt-in de marketing, exportação e exclusão dos dados do cliente."],
            ].map(([ic, t, d], i) => (
              <div key={t} data-reveal style={{ ["--d" as string]: `${(i % 3) * 90}ms` }} className="flex gap-4 rounded-3xl bg-white p-6 shadow-soft ring-1 ring-zinc-100">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-navy-900 text-white"><Icon d={ic} className="h-5 w-5" /></span>
                <div><h3 className="font-extrabold text-navy-900">{t}</h3><p className="mt-1 text-sm text-zinc-600">{d}</p></div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* PLANOS */}
      <section id="planos" className="py-20 sm:py-28">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <div className="mx-auto max-w-3xl text-center" data-reveal>
            <p className="text-sm font-bold uppercase tracking-[0.2em] text-red-brand">Planos</p>
            <h2 className="mt-3 text-3xl font-black tracking-tight text-navy-900 sm:text-5xl">Preço justo, sem surpresa</h2>
            <p className="mt-4 text-lg text-zinc-600">Comece grátis por 14 dias. Sem fidelidade e sem taxa por pedido no seu cardápio.</p>
          </div>
          <div className="mt-14 grid gap-5 md:grid-cols-2 xl:grid-cols-4">
            {PLANS.map((p, i) => (
              <div key={p.name} data-reveal style={{ ["--d" as string]: `${i * 90}ms` }}
                className={`relative flex flex-col rounded-3xl p-7 transition duration-300 hover:-translate-y-1.5 ${p.hl
                  ? "bg-navy-900 text-white shadow-[0_30px_60px_-20px_rgb(30_16_51/0.6)] ring-2 ring-red-brand"
                  : "bg-white shadow-soft ring-1 ring-zinc-200 hover:shadow-lift"}`}>
                {p.hl && <span className="absolute -top-3 left-7 rounded-full bg-red-brand px-3 py-1 text-xs font-black uppercase tracking-wide text-white">Mais completo</span>}
                {p.soon && <span className="absolute -top-3 left-7 rounded-full bg-amber-300 px-3 py-1 text-xs font-black uppercase tracking-wide text-zinc-900">{p.soon}</span>}
                <h3 className="text-xl font-black">{p.name}</h3>
                <p className={`mt-1 text-sm ${p.hl ? "text-white/70" : "text-zinc-500"}`}>{p.for}</p>
                <p className="mt-6 flex items-baseline gap-1">
                  <span className={`text-sm font-bold ${p.hl ? "text-white/70" : "text-zinc-500"}`}>R$</span>
                  <span className="text-5xl font-black tracking-tight">{p.price}</span>
                  <span className={`text-sm ${p.hl ? "text-white/70" : "text-zinc-500"}`}>/mês</span>
                </p>
                <ul className="mt-6 flex-1 space-y-2.5 text-sm">
                  {p.items.map((it) => (
                    <li key={it} className="flex gap-2">
                      <svg viewBox="0 0 20 20" className={`mt-0.5 h-4 w-4 shrink-0 ${p.hl ? "text-amber-300" : "text-red-brand"}`} fill="currentColor" aria-hidden="true"><path d="M7.6 13.6 4 10l-1.4 1.4 5 5 10-10L16.2 5l-8.6 8.6Z" /></svg>{it}
                    </li>
                  ))}
                </ul>
                <Link href="/login?modo=cadastro" className={`mt-8 rounded-2xl py-3.5 text-center font-bold transition ${p.hl ? "bg-red-brand text-white hover:bg-brand-700" : "bg-navy-900 text-white hover:bg-navy-800"}`}>
                  Começar teste grátis
                </Link>
              </div>
            ))}
          </div>
          <p className="mt-8 text-center text-sm text-zinc-500" data-reveal>
            Adicionais a partir de R$ 49/mês: loja extra, totem, NFC-e e atendente com IA no WhatsApp (em breve).
          </p>
        </div>
      </section>

      {/* FAQ */}
      <section id="duvidas" className="bg-cream py-20 sm:py-28">
        <div className="mx-auto max-w-3xl px-4 sm:px-6">
          <div className="text-center" data-reveal>
            <p className="text-sm font-bold uppercase tracking-[0.2em] text-red-brand">Dúvidas</p>
            <h2 className="mt-3 text-3xl font-black tracking-tight text-navy-900 sm:text-5xl">Perguntas frequentes</h2>
          </div>
          <div className="mt-10 space-y-3">
            {FAQ.map(([q, a], i) => (
              <details key={q} className="faq group rounded-2xl bg-white shadow-soft ring-1 ring-zinc-100 transition open:ring-brand-200" data-reveal style={{ ["--d" as string]: `${i * 40}ms` }}>
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-6 py-5 font-bold text-navy-900">
                  {q}
                  <span className="faq-icon grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand-50 text-xl leading-none text-red-brand transition-transform duration-300">+</span>
                </summary>
                <p className="faq-body px-6 pb-6 text-zinc-600">{a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* CTA FINAL */}
      <section className="relative isolate overflow-hidden bg-navy-900 py-20 text-white sm:py-24">
        <div aria-hidden="true" className="absolute inset-0 -z-10 grid grid-cols-3 grid-rows-2 sm:grid-cols-6 sm:grid-rows-1">
          {["pizza", "burger", "acai", "combo", "margherita", "batata"].map((f) => (
            <img key={f} src={`/marketing/food-${f}.webp`} alt="" width={418} height={231} loading="lazy" className="h-full w-full object-cover" />
          ))}
        </div>
        <div aria-hidden="true" className="absolute inset-0 -z-10 bg-gradient-to-r from-red-brand/95 via-red-brand/85 to-navy-900/90" />
        <div className="mx-auto max-w-4xl px-4 text-center sm:px-6" data-reveal="zoom">
          <img src="/brand/domma-food-mark-white.svg" alt="" className="mx-auto h-16 w-auto" width={130} height={84} />
          <h2 className="mt-6 text-3xl font-black tracking-tight sm:text-5xl">Sua loja on-line hoje, seu primeiro pedido ainda hoje</h2>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-white/85">Crie a conta, cadastre o cardápio e compartilhe o link. Leva menos tempo que fazer uma pizza.</p>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            <Link href="/login?modo=cadastro" className="rounded-2xl bg-white px-7 py-4 text-base font-bold text-red-brand shadow-xl transition hover:-translate-y-0.5">Criar minha loja grátis</Link>
            <Link href="/loja/bella-massa" className="rounded-2xl px-7 py-4 text-base font-semibold text-white ring-1 ring-white/50 transition hover:bg-white/10">Ver demonstração</Link>
          </div>
        </div>
      </section>

      <footer className="bg-navy-950 py-12 text-white/70">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-6 px-4 sm:flex-row sm:px-6">
          <div className="flex flex-col items-center gap-2 sm:items-start">
            <img src="/brand/domma-food-logo-dark-transparent.svg" alt="Domma Food" className="h-10 w-auto" width={200} height={50} />
            <p className="text-sm">Domma Food · uma empresa Domma Tecnologia</p>
          </div>
          <nav className="flex flex-wrap justify-center gap-5 text-sm" aria-label="Rodapé">
            <a href="#recursos" className="hover:text-white">Recursos</a>
            <a href="#planos" className="hover:text-white">Planos</a>
            <a href="#duvidas" className="hover:text-white">Dúvidas</a>
            <Link href="/login" className="hover:text-white">Entrar</Link>
          </nav>
          <p className="text-xs">© {new Date().getFullYear()} Domma Tecnologia. Todos os direitos reservados.</p>
        </div>
      </footer>
    </div>
  );
}
