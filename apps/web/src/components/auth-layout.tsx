import { CheckCircle2 } from 'lucide-react';
import type { ReactNode } from 'react';

/** Pantalla de entrada: a la izquierda qué hace Cuadra, a la derecha el formulario */
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <aside className="hidden flex-col justify-between bg-brand-900 p-12 text-white lg:flex">
        <div className="flex items-center gap-2">
          <span className="grid size-10 place-items-center rounded-xl bg-white text-xl font-bold text-brand-900">C</span>
          <span className="text-xl font-semibold">Cuadra</span>
        </div>
        <div>
          <h2 className="text-4xl leading-tight font-semibold">Sabe cuánto ganaste en cada venta y quién te debe plata.</h2>
          <ul className="mt-8 space-y-3 text-lg text-brand-100">
            {[
              'Tus ventas de Falabella, Paris, Walmart y más, en un solo lugar',
              'Cuadra solo lo que te pagó cada retailer contra lo que vendiste',
              'Boletas y notas de crédito al SII con un clic',
              'Tu IVA del mes, sin planillas',
            ].map((t) => (
              <li key={t} className="flex items-start gap-3">
                <CheckCircle2 className="mt-1 size-5 shrink-0 text-brand-200" /> {t}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-sm text-brand-200">Hecho en Chile para vendedores de marketplace.</p>
      </aside>
      <main className="flex items-center justify-center p-6">
        <div className="w-full max-w-md">{children}</div>
      </main>
    </div>
  );
}
