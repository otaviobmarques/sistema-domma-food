import Link from "next/link";

const features = [
  ["Cardápio digital próprio", "Seus clientes pedem pelo celular, sem baixar app e sem comissão por pedido."],
  ["Gestor de pedidos em tempo real", "Todos os pedidos numa tela só, com alerta sonoro e cronômetro."],
  ["Pix na hora", "QR Code e copia e cola gerados automaticamente para cada pedido."],
  ["Entrega por raio ou bairro", "Taxa, tempo e pedido mínimo por região; frete grátis acima de um valor."],
  ["Cupons e CRM", "Cupons com regras, histórico de cada cliente e base pronta para campanhas."],
  ["Segurança de verdade", "Dados isolados por empresa, 2FA, auditoria de cada alteração e backups."],
];

export default function Home() {
  return (
    <main>
      <header className="bg-brand-800 text-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
          <span className="inline-flex items-center gap-2 font-bold">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-white text-lg text-brand-800">d</span>domma food
          </span>
          <nav className="flex gap-2">
            <Link href="/login" className="btn text-white hover:bg-white/10">Entrar</Link>
            <Link href="/login?modo=cadastro" className="btn bg-white text-brand-800 hover:bg-brand-50">Testar grátis</Link>
          </nav>
        </div>
        <div className="mx-auto max-w-6xl px-4 pb-20 pt-12">
          <h1 className="max-w-3xl text-4xl font-bold leading-tight sm:text-5xl">
            O sistema completo para quem vende comida.
          </h1>
          <p className="mt-4 max-w-2xl text-lg text-brand-100">
            Canal de vendas próprio sem comissão, gestão de pedidos em tempo real e uma operação que mostra o lucro de verdade.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/login?modo=cadastro" className="btn bg-white px-6 py-3 text-base text-brand-800 hover:bg-brand-50">Criar minha loja em 2 minutos</Link>
          </div>
          <p className="mt-3 text-sm text-brand-200">14 dias grátis · sem cartão de crédito</p>
        </div>
      </header>
      <section className="mx-auto grid max-w-6xl gap-4 px-4 py-16 sm:grid-cols-2 lg:grid-cols-3">
        {features.map(([t, d]) => (
          <div key={t} className="card">
            <h2 className="font-semibold text-brand-800">{t}</h2>
            <p className="mt-1 text-sm text-zinc-600">{d}</p>
          </div>
        ))}
      </section>
      <footer className="border-t border-zinc-200 py-8 text-center text-sm text-zinc-500">
        © {new Date().getFullYear()} Domma Tecnologia
      </footer>
    </main>
  );
}
