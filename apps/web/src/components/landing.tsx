'use client';

import { BadgeCheck, CalendarClock, FileCheck2, Factory, PackageSearch, Receipt, Scale, Store, TrendingUp } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Logo } from './logo';

/** Portada pública: qué es Cuadra y cómo se contrata */
export function Landing() {
  return (
    <div className="min-h-screen bg-white text-ink">
      <style>{`
        @keyframes row-in { from { opacity: 0; transform: translateY(4px) } to { opacity: 1; transform: none } }
        @keyframes stamp { 0% { opacity: 0; transform: scale(.92) } 60% { opacity: 1; transform: scale(1.03) } 100% { opacity: 1; transform: none } }
        .ledger-row { opacity: 0; animation: row-in .45s ease-out forwards }
        .ledger-stamp { opacity: 0; animation: stamp .5s ease-out forwards; animation-delay: 1.45s }
      `}</style>

      <header className="sticky top-0 z-30 border-b border-line/70 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-8 px-5 py-3.5 sm:px-8">
          <Logo />
          <nav className="hidden items-center gap-6 text-sm text-muted md:flex" aria-label="Secciones">
            <a href="#que-hace" className="hover:text-ink">
              Qué hace
            </a>
            <a href="#como-empiezas" className="hover:text-ink">
              Cómo empiezas
            </a>
            <a href="#para-quien" className="hover:text-ink">
              Para quién
            </a>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <Link href="/login" className="rounded-lg px-3 py-2 text-sm font-medium text-ink hover:bg-paper">
              Entrar
            </Link>
            <Link href="/registro" className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">
              Crear cuenta
            </Link>
          </div>
        </div>
      </header>

      {/* Banner principal (lleva a crear cuenta) */}
      <section aria-label="Cuadra, soluciones para empresas" className="bg-[#0b1626]">
        <Link href="/registro" className="group mx-auto block max-w-[2048px]" aria-label="Crear cuenta en Cuadra">
          <picture>
            <source type="image/webp" srcSet="/img/banner-768.webp 768w, /img/banner-1280.webp 1280w, /img/banner-2048.webp 2048w" sizes="100vw" />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/img/banner-2048.jpg"
              width={2048}
              height={768}
              alt="Cuadra, soluciones para empresas: desarrollo de software, automatización de procesos, sistemas en la nube e integración de sistemas"
              className="block h-auto w-full"
              fetchPriority="high"
            />
          </picture>
        </Link>
      </section>

      {/* Portada */}
      <section className="border-b border-line bg-[linear-gradient(180deg,#ffffff_0%,#f5f6f8_100%)]">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-5 pt-16 pb-20 sm:px-8 lg:grid-cols-[1.05fr_1fr] lg:pt-24 lg:pb-28">
          <div>
            <h1 className="display max-w-xl text-[2.6rem] leading-[1.04] font-semibold sm:text-[3.4rem]">Cada peso que te paga el retail, cuadrado.</h1>
            <p className="mt-6 max-w-lg text-lg leading-relaxed text-muted">
              Cuadra junta tus ventas de Falabella, Paris y Walmart, las compara con cada liquidación y te muestra cuánto ganaste de verdad en cada
              orden. Sin planillas.
            </p>
            <div className="mt-9 flex flex-wrap items-center gap-3">
              <Link href="/registro" className="inline-flex h-11 items-center rounded-lg bg-brand-600 px-5 text-[0.9375rem] font-medium text-white hover:bg-brand-700">
                Crear cuenta gratis
              </Link>
              <Link
                href="/login"
                className="inline-flex h-11 items-center rounded-lg border border-line-strong bg-white px-5 text-[0.9375rem] font-medium hover:border-ink/40"
              >
                Ya tengo cuenta
              </Link>
            </div>
            <p className="mt-5 text-sm text-muted">Prueba 14 días gratis, sin tarjeta.</p>
          </div>
          <Ledger />
        </div>
      </section>

      {/* Con quién se conecta */}
      <section aria-label="Integraciones" className="border-b border-line">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-10 gap-y-3 px-5 py-7 sm:px-8">
          <p className="text-sm text-muted">Se conecta con</p>
          {['Falabella', 'Paris', 'Walmart', 'Hites', 'SII', 'Nubox'].map((n) => (
            <span key={n} className="display text-lg font-semibold text-ink/70">
              {n}
            </span>
          ))}
        </div>
      </section>

      {/* Qué hace */}
      <section id="que-hace" className="scroll-mt-20">
        <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8 lg:py-24">
          <div className="max-w-2xl">
            <h2 className="display text-3xl font-semibold sm:text-[2.25rem]">Lo que hoy haces en cinco planillas, en un solo lugar.</h2>
            <p className="mt-4 text-lg text-muted">Desde que entra la orden hasta que llega la plata a tu cuenta.</p>
          </div>
          <div className="mt-14 grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
            <Feature icon={<Scale />} title="Liquidaciones cuadradas">
              Sube la liquidación y Cuadra la cruza orden por orden: comisión, despacho, envío y descuentos. Ves al tiro lo que te pagaron de menos.
            </Feature>
            <Feature icon={<TrendingUp />} title="Ganancia real por venta">
              Venta y envío, menos el costo, el IVA y lo que cobró el retailer. Por orden, por producto y por canal.
            </Feature>
            <Feature icon={<CalendarClock />} title="Cuándo te pagan">
              Cada retailer paga distinto. Cuadra calcula la fecha de cada pago y te avisa cuando algo debió llegar y no llegó.
            </Feature>
            <Feature icon={<Receipt />} title="Boletas y facturas al SII">
              Emite boletas, facturas y notas de crédito de una o muchas órdenes a la vez, con Nubox o directo con el SII.
            </Feature>
            <Feature icon={<FileCheck2 />} title="Compras e IVA del mes">
              Trae las facturas de tus proveedores desde el SII y arma el IVA del mes con lo vendido y lo comprado.
            </Feature>
            <Feature icon={<PackageSearch />} title="Stock y precios en cada tienda">
              Cambia stock, precios, ofertas y descripciones en Paris, Falabella y Walmart sin entrar a cada portal.
            </Feature>
          </div>
        </div>
      </section>

      {/* Cómo empiezas: es una secuencia real */}
      <section id="como-empiezas" className="scroll-mt-20 border-y border-line bg-paper">
        <div className="mx-auto grid max-w-6xl gap-12 px-5 py-20 sm:px-8 lg:grid-cols-[0.8fr_1.2fr] lg:py-24">
          <div>
            <h2 className="display text-3xl font-semibold sm:text-[2.25rem]">Tus números al día en una tarde.</h2>
            <p className="mt-4 text-lg text-muted">No hay que instalar nada ni cambiar cómo trabajas con los retailers.</p>
          </div>
          <ol className="space-y-0 border-l border-line-strong">
            <Step n={1} title="Conecta tus tiendas">
              Pega las credenciales de API de Falabella, Paris o Walmart. Si prefieres, sube los reportes en Excel que ya descargas.
            </Step>
            <Step n={2} title="Carga tus costos">
              El costo de cada producto, o la receta de insumos si fabricas. Con eso Cuadra calcula tu margen en cada venta.
            </Step>
            <Step n={3} title="Sube la liquidación y revisa">
              Cuadra cruza lo vendido con lo pagado y te deja listas las diferencias, los pagos que vienen y los documentos por emitir.
            </Step>
          </ol>
        </div>
      </section>

      {/* Para quién */}
      <section id="para-quien" className="scroll-mt-20">
        <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8 lg:py-24">
          <h2 className="display max-w-2xl text-3xl font-semibold sm:text-[2.25rem]">Para quien compra y revende, y para quien fabrica.</h2>
          <div className="mt-12 grid gap-10 md:grid-cols-2">
            <Audience icon={<Store />} title="Revendedores">
              Asocia cada venta a la factura de tu proveedor y conoce la ganancia exacta, aunque la factura llegue después.
            </Audience>
            <Audience icon={<Factory />} title="Fabricantes">
              Arma la receta de insumos de cada producto. Si sube la tela o la espuma, el costo de todo lo que la usa se actualiza solo.
            </Audience>
          </div>
        </div>
      </section>

      {/* Cierre */}
      <section className="bg-graphite-900 text-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-8 px-5 py-16 sm:px-8">
          <div className="max-w-xl">
            <h2 className="display text-3xl font-semibold">Deja de perseguir la plata del retail.</h2>
            <p className="mt-3 text-white/65">14 días gratis, sin tarjeta. Conecta tu primera tienda hoy.</p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link href="/registro" className="inline-flex h-11 items-center rounded-lg bg-brand-600 px-5 font-medium text-white hover:bg-brand-500">
              Crear cuenta gratis
            </Link>
            <Link href="/login" className="inline-flex h-11 items-center rounded-lg border border-white/20 px-5 font-medium text-white hover:bg-white/10">
              Entrar
            </Link>
          </div>
        </div>
      </section>

      <footer className="bg-graphite-900 text-white/50">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 border-t border-white/10 px-5 py-6 text-sm sm:px-8">
          <Logo dark className="opacity-80" />
          <p>© {new Date().getFullYear()} Cuadra. Santiago, Chile.</p>
        </div>
      </footer>
    </div>
  );
}

/** La pieza central de la portada: una liquidación real que cuadra al peso */
function Ledger() {
  const rows: { label: string; detail?: string; amount: string; tone?: 'neg' }[] = [
    { label: 'Producto', detail: 'Sofá seccional 3 cuerpos', amount: '$259.990' },
    { label: 'Envío pagado por el cliente', amount: '$25.990' },
    { label: 'Comisión', detail: '15% de la venta', amount: '−$38.999', tone: 'neg' },
    { label: 'Despacho', amount: '−$22.990', tone: 'neg' },
  ];
  return (
    <figure className="relative mx-auto w-full max-w-md lg:max-w-none" aria-label="Ejemplo de una liquidación cuadrada">
      <div className="rounded-2xl border border-line bg-white shadow-[0_30px_70px_-35px_rgba(20,30,50,0.45)]">
        <div className="flex items-center justify-between border-b border-line px-6 py-4">
          <div>
            <p className="text-sm font-semibold">Paris</p>
            <p className="num text-sm text-muted">Orden 3153888690</p>
          </div>
          <p className="text-sm text-muted">Pago del miércoles 28 oct</p>
        </div>
        <dl className="px-6 py-2">
          {rows.map((r, i) => (
            <div key={r.label} className="ledger-row flex items-baseline justify-between gap-4 border-b border-dashed border-line py-3" style={{ animationDelay: `${0.15 + i * 0.22}s` }}>
              <dt>
                <span className="text-[0.9375rem]">{r.label}</span>
                {r.detail && <span className="block text-xs text-muted">{r.detail}</span>}
              </dt>
              <dd className={`figure text-lg ${r.tone === 'neg' ? 'text-muted' : ''}`}>{r.amount}</dd>
            </div>
          ))}
          <div className="ledger-row flex items-baseline justify-between gap-4 py-4" style={{ animationDelay: '1.05s' }}>
            <dt className="font-semibold">Te pagaron</dt>
            <dd className="figure text-[1.75rem] font-semibold">$223.991</dd>
          </div>
        </dl>
        <div className="flex items-center justify-between gap-3 rounded-b-2xl border-t border-line bg-[#f8f9fb] px-6 py-3.5">
          <span className="text-sm text-muted">
            Esperado <span className="figure text-ink">$223.991</span>
          </span>
          <span className="ledger-stamp inline-flex items-center gap-1.5 rounded-full bg-money-50 px-3 py-1 text-sm font-medium text-money-700">
            <BadgeCheck className="size-4" /> Cuadra al peso
          </span>
        </div>
      </div>
      <figcaption className="mt-4 text-center text-sm text-muted lg:text-left">Cada orden, con lo que vendiste y lo que realmente te depositaron.</figcaption>
    </figure>
  );
}

function Feature({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="bg-white p-7">
      <span className="text-brand-600 [&>svg]:size-5 [&>svg]:stroke-[1.75]">{icon}</span>
      <h3 className="mt-4 text-base font-semibold">{title}</h3>
      <p className="mt-2 text-[0.9375rem] leading-relaxed text-muted">{children}</p>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="relative pb-10 pl-10 last:pb-0">
      <span className="num absolute top-0 -left-[15px] grid size-[30px] place-items-center rounded-full border border-line-strong bg-white text-sm font-semibold">{n}</span>
      <h3 className="pt-1 text-lg font-semibold">{title}</h3>
      <p className="mt-1.5 max-w-xl leading-relaxed text-muted">{children}</p>
    </li>
  );
}

function Audience({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="border-t-2 border-ink pt-6">
      <span className="text-ink [&>svg]:size-6 [&>svg]:stroke-[1.5]">{icon}</span>
      <h3 className="mt-3 text-xl font-semibold">{title}</h3>
      <p className="mt-2 max-w-md text-lg leading-relaxed text-muted">{children}</p>
    </div>
  );
}
