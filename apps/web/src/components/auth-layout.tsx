import Link from 'next/link';
import type { ReactNode } from 'react';
import { Logo } from './logo';

/** Pantalla de entrada: a la izquierda qué hace Cuadra, a la derecha el formulario */
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-screen bg-white lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <aside className="relative hidden flex-col justify-between overflow-hidden bg-graphite-900 p-12 text-white lg:flex">
        <Link href="/" className="w-fit">
          <Logo dark />
        </Link>
        <div className="max-w-md">
          <p className="display text-[2.25rem] leading-[1.1] font-semibold">Lo vendido y lo pagado, frente a frente.</p>
          <dl className="mt-10 divide-y divide-white/10 border-y border-white/10 text-sm">
            {[
              ['Ventas de Falabella, Paris y Walmart', 'en un solo lugar'],
              ['Cada liquidación', 'cruzada orden por orden'],
              ['Boletas, facturas y notas', 'directo al SII'],
              ['Fecha de cada pago', 'según cómo paga cada retailer'],
            ].map(([a, b]) => (
              <div key={a} className="flex items-baseline justify-between gap-6 py-3.5">
                <dt className="text-white/90">{a}</dt>
                <dd className="text-right text-white/50">{b}</dd>
              </div>
            ))}
          </dl>
        </div>
        <p className="text-sm text-white/40">Hecho en Chile para empresas que venden en marketplaces.</p>
      </aside>
      <main className="flex flex-col p-6 sm:p-10">
        <Link href="/" className="lg:hidden">
          <Logo />
        </Link>
        <div className="flex flex-1 items-center justify-center py-10">
          <div className="w-full max-w-[400px]">{children}</div>
        </div>
      </main>
    </div>
  );
}
