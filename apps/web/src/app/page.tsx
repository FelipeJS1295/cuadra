'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Coins, HandCoins, Landmark, PartyPopper, ShoppingBag, Sparkles, TrendingUp, Truck } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { useSession } from '@/components/session';
import { BigNumber, Card, clp, ErrorBox, Help, LinkButton, Loading, monthLabel, MonthPicker, Progress, todayCL } from '@/components/ui';
import { api, type HomeTask } from '@/lib/api';
import { cn } from '@/lib/cn';

const TASK_TONE: Record<HomeTask['tone'], string> = {
  rojo: 'bg-berry-500',
  amarillo: 'bg-sun-500',
  azul: 'bg-sky-500',
};

export default function HomePage() {
  const { user } = useSession();
  const [month, setMonth] = useState(todayCL().slice(0, 7));
  const home = useQuery({ queryKey: ['home', month], queryFn: () => api.home(month) });
  const onboarding = useQuery({ queryKey: ['onboarding'], queryFn: api.onboarding });
  const d = home.data;
  const firstName = user.name.split(' ')[0];

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-muted">Hola, {firstName}</p>
          <h1 className="text-3xl font-semibold tracking-tight">
            Así va <span className="text-brand-700">{user.tenantName}</span> en <span className="capitalize">{monthLabel(month).split(' ')[0]}</span>
          </h1>
        </div>
        <MonthPicker value={month} onChange={setMonth} />
      </header>

      {onboarding.data && onboarding.data.completed < onboarding.data.total && (
        <Card className="mb-6 flex flex-wrap items-center gap-4 border-brand-200 bg-brand-50 p-5">
          <div className="grid size-11 place-items-center rounded-full bg-white text-brand-600">
            <Sparkles className="size-5" />
          </div>
          <div className="min-w-56 flex-1">
            <p className="font-semibold">
              Te faltan {onboarding.data.total - onboarding.data.completed} {onboarding.data.total - onboarding.data.completed === 1 ? 'paso' : 'pasos'} para dejar todo listo
            </p>
            <div className="mt-2 max-w-sm">
              <Progress value={onboarding.data.completed} total={onboarding.data.total} />
            </div>
          </div>
          <LinkButton href="/bienvenida">
            Continuar <ArrowRight className="size-4" />
          </LinkButton>
        </Card>
      )}

      <ErrorBox error={home.error} />
      {home.isLoading && <Loading label="Sumando tus ventas…" />}
      {d && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <BigNumber
              label="Vendiste"
              value={clp(d.sold)}
              sub={`${d.orders} ${d.orders === 1 ? 'venta' : 'ventas'}${d.cancelled ? ` · ${d.cancelled} canceladas` : ''}`}
              icon={<ShoppingBag className="size-4" />}
              tone="azul"
              href="/ventas"
            />
            <BigNumber
              label="Te pagaron"
              value={clp(d.paid)}
              sub="Lo que ya depositaron los retailers por estas ventas"
              icon={<HandCoins className="size-4" />}
              tone="verde"
              href="/cobros"
            />
            <BigNumber
              label="Te deben"
              value={clp(d.owed)}
              sub={d.owedOverdue > 0 ? <span className="font-medium text-berry-700">{clp(d.owedOverdue)} ya atrasado</span> : 'Nada atrasado, todo al día'}
              icon={<Coins className="size-4" />}
              tone={d.owedOverdue > 0 ? 'rojo' : 'ambar'}
              href="/cobros"
            />
            <BigNumber
              label="Ganaste"
              value={d.profitOrders ? clp(d.profit) : '—'}
              sub={
                d.profitOrders
                  ? `${d.profitPct?.toLocaleString('es-CL', { maximumFractionDigits: 1 })}% en ${d.profitOrders} ventas ya cuadradas`
                  : 'Aparece cuando una venta tiene pago del retailer y factura del proveedor'
              }
              icon={<TrendingUp className="size-4" />}
              tone="verde"
            />
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Card className="flex items-center gap-4 p-5">
              <span className="grid size-10 place-items-center rounded-full bg-stone-100 text-stone-600">
                <Landmark className="size-5" />
              </span>
              <div className="flex-1">
                <p className="text-sm text-muted">IVA estimado de {monthLabel(month).split(' ')[0]}</p>
                <p className="num text-xl font-semibold">{d.vatToPay === null ? '—' : d.vatToPay >= 0 ? clp(d.vatToPay) : `A favor ${clp(-d.vatToPay)}`}</p>
              </div>
              <Link href="/impuestos" className="text-sm font-medium text-brand-700 hover:underline">
                Ver detalle
              </Link>
            </Card>
            <Card className="flex items-center gap-4 p-5">
              <span className="grid size-10 place-items-center rounded-full bg-stone-100 text-stone-600">
                <Truck className="size-5" />
              </span>
              <div className="flex-1">
                <p className="text-sm text-muted">Costo de tus productos (facturas de proveedor)</p>
                <p className="num text-xl font-semibold">{clp(d.supplierCost)}</p>
              </div>
              <Link href="/compras" className="text-sm font-medium text-brand-700 hover:underline">
                Ver compras
              </Link>
            </Card>
          </div>

          <div className="mt-8 grid gap-6 lg:grid-cols-5">
            <section className="lg:col-span-3">
              <h2 className="mb-3 text-lg font-semibold">Lo que tienes que hacer</h2>
              {d.tasks.length === 0 ? (
                <Card className="flex items-center gap-4 p-6">
                  <PartyPopper className="size-8 text-brand-500" />
                  <div>
                    <p className="font-semibold">¡Todo al día!</p>
                    <p className="text-sm text-muted">No hay nada pendiente en este mes.</p>
                  </div>
                </Card>
              ) : (
                <div className="space-y-3">
                  {d.tasks.map((t) => (
                    <Card key={t.id} className="flex flex-wrap items-center gap-4 p-4">
                      <span className={cn('size-2.5 shrink-0 rounded-full', TASK_TONE[t.tone])} />
                      <div className="min-w-48 flex-1">
                        <p className="font-medium">{t.title}</p>
                        <p className="text-sm text-muted">{t.why}</p>
                      </div>
                      <LinkButton href={t.href} variant={t.tone === 'rojo' ? 'primary' : 'secondary'}>
                        {t.action}
                      </LinkButton>
                    </Card>
                  ))}
                </div>
              )}
            </section>

            <section className="lg:col-span-2">
              <h2 className="mb-3 text-lg font-semibold">Ventas por retailer</h2>
              <Card className="space-y-4 p-5">
                {d.byRetailer.length === 0 && <p className="text-sm text-muted">Aún no hay ventas en este mes.</p>}
                {d.byRetailer.map((r) => {
                  const max = Math.max(...d.byRetailer.map((x) => x.sold), 1);
                  return (
                    <div key={r.retailer}>
                      <div className="flex justify-between text-sm">
                        <span className="font-medium">{r.retailer}</span>
                        <span className="num text-muted">
                          {clp(r.sold)} · {r.orders}
                        </span>
                      </div>
                      <div className="mt-1.5 h-2.5 overflow-hidden rounded-full bg-stone-100">
                        <div className="h-full rounded-full bg-brand-500" style={{ width: `${(r.sold / max) * 100}%` }} />
                      </div>
                      <p className="mt-1 text-xs text-muted">Te pagaron {clp(r.paid)}</p>
                    </div>
                  );
                })}
              </Card>
              <Help label="¿Cómo calculamos lo que ganaste?">
                <p>Por cada venta tomamos lo que el retailer te depositó (el precio menos su comisión y cargos de envío).</p>
                <p>A eso le restamos lo que le pagaste al proveedor y el IVA que te toca pagar por esa venta.</p>
                <p>Solo contamos las ventas que ya tienen las dos cosas: pago del retailer y factura del proveedor.</p>
              </Help>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
