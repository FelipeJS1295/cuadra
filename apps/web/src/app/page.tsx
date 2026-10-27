'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CheckCircle2, Landmark, Sparkles, Truck } from 'lucide-react';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { useSession } from '@/components/session';
import { Card, clp, ErrorBox, Help, LinkButton, Loading, monthLabel, MonthPicker, Progress, todayCL } from '@/components/ui';
import { api, type HomeTask } from '@/lib/api';
import { cn } from '@/lib/cn';

const TASK_TONE: Record<HomeTask['tone'], string> = {
  rojo: 'bg-berry-500',
  amarillo: 'bg-sun-500',
  azul: 'bg-brand-500',
};

export default function HomePage() {
  const { user, isFactory } = useSession();
  const [month, setMonth] = useState(todayCL().slice(0, 7));
  const home = useQuery({ queryKey: ['home', month], queryFn: () => api.home(month) });
  const onboarding = useQuery({ queryKey: ['onboarding'], queryFn: api.onboarding });
  const d = home.data;
  const firstName = user.name.split(' ')[0];

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:py-8">
      <header className="mb-7 flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
        <div>
          <p className="text-sm text-muted">Hola, {firstName}</p>
          <h1 className="display mt-0.5 text-[1.75rem] leading-tight font-semibold">
            {user.tenantName} en <span className="capitalize">{monthLabel(month).split(' ')[0]}</span>
          </h1>
        </div>
        <MonthPicker value={month} onChange={setMonth} />
      </header>

      {onboarding.data && onboarding.data.completed < onboarding.data.total && (
        <div className="mb-6 flex flex-wrap items-center gap-5 rounded-2xl border border-brand-100 bg-brand-50/70 px-5 py-4">
          <Sparkles className="size-5 text-brand-600" />
          <div className="min-w-56 flex-1">
            <p className="font-medium">
              Te faltan {onboarding.data.total - onboarding.data.completed} {onboarding.data.total - onboarding.data.completed === 1 ? 'paso' : 'pasos'} para dejar todo listo
            </p>
            <div className="mt-2 max-w-sm">
              <Progress value={onboarding.data.completed} total={onboarding.data.total} />
            </div>
          </div>
          <LinkButton href="/bienvenida">
            Continuar <ArrowRight className="size-4" />
          </LinkButton>
        </div>
      )}

      <ErrorBox error={home.error} />
      {home.isLoading && <Loading label="Sumando tus ventas…" />}
      {d && (
        <>
          {/* Las cuatro cifras del mes en un solo estado de cuenta */}
          <Card className="grid gap-px overflow-hidden bg-line sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Vendiste" value={clp(d.sold)} href="/ventas" sub={`${d.orders} ${d.orders === 1 ? 'venta' : 'ventas'}${d.cancelled ? `, ${d.cancelled} canceladas` : ''}`} />
            <Stat label="Te pagaron" value={clp(d.paid)} href="/cobros" tone="verde" sub="Depositado por los retailers" />
            <Stat
              label="Te deben"
              value={clp(d.owed)}
              href="/cobros"
              tone={d.owedOverdue > 0 ? 'rojo' : undefined}
              sub={d.owedOverdue > 0 ? <span className="text-berry-700">{clp(d.owedOverdue)} atrasado</span> : 'Nada atrasado'}
            />
            <Stat
              label="Ganaste"
              value={d.profitOrders ? clp(d.profit) : '—'}
              tone={d.profitOrders ? (d.profit >= 0 ? 'verde' : 'rojo') : undefined}
              sub={
                d.profitOrders
                  ? `${d.profitPct?.toLocaleString('es-CL', { maximumFractionDigits: 1 })}% en ${d.profitOrders} ventas cuadradas`
                  : 'Cuando una venta tenga pago y costo'
              }
            />
          </Card>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <MiniStat
              icon={<Landmark />}
              label={`IVA estimado de ${monthLabel(month).split(' ')[0]}`}
              value={d.vatToPay === null ? '—' : d.vatToPay >= 0 ? clp(d.vatToPay) : `A favor ${clp(-d.vatToPay)}`}
              href="/impuestos"
              action="Ver detalle"
            />
            <MiniStat
              icon={<Truck />}
              label={isFactory ? 'Costo de lo vendido (insumos)' : 'Costo de tus productos'}
              value={clp(d.supplierCost)}
              href={isFactory ? '/productos' : '/compras'}
              action={isFactory ? 'Ver recetas' : 'Ver compras'}
            />
          </div>

          <div className="mt-8 grid gap-6 lg:grid-cols-5">
            <section className="lg:col-span-3">
              <h2 className="mb-3 text-base font-semibold">Pendientes</h2>
              {d.tasks.length === 0 ? (
                <Card className="flex items-center gap-4 p-6">
                  <CheckCircle2 className="size-6 text-money-600" />
                  <div>
                    <p className="font-medium">Todo al día</p>
                    <p className="text-sm text-muted">No hay nada pendiente en este mes.</p>
                  </div>
                </Card>
              ) : (
                <Card className="divide-y divide-line">
                  {d.tasks.map((t) => (
                    <div key={t.id} className="flex flex-wrap items-center gap-4 px-5 py-4">
                      <span className={cn('size-2 shrink-0 rounded-full', TASK_TONE[t.tone])} aria-hidden />
                      <div className="min-w-48 flex-1">
                        <p className="font-medium">{t.title}</p>
                        <p className="text-sm text-muted">{t.why}</p>
                      </div>
                      <LinkButton href={t.href} variant={t.tone === 'rojo' ? 'primary' : 'secondary'}>
                        {t.action}
                      </LinkButton>
                    </div>
                  ))}
                </Card>
              )}
            </section>

            <section className="lg:col-span-2">
              <h2 className="mb-3 text-base font-semibold">Ventas por retailer</h2>
              <Card className="space-y-5 p-5">
                {d.byRetailer.length === 0 && <p className="text-sm text-muted">Aún no hay ventas en este mes.</p>}
                {d.byRetailer.map((r) => {
                  const max = Math.max(...d.byRetailer.map((x) => x.sold), 1);
                  return (
                    <div key={r.retailer}>
                      <div className="flex items-baseline justify-between gap-3 text-sm">
                        <span className="font-medium">{r.retailer}</span>
                        <span className="figure text-base">{clp(r.sold)}</span>
                      </div>
                      <div className="relative mt-2 h-1.5 overflow-hidden rounded-full bg-stone-100">
                        <div className="absolute inset-y-0 left-0 rounded-full bg-brand-200" style={{ width: `${(r.sold / max) * 100}%` }} />
                        <div className="absolute inset-y-0 left-0 rounded-full bg-brand-600" style={{ width: `${(Math.min(r.paid, r.sold) / max) * 100}%` }} />
                      </div>
                      <p className="mt-1.5 text-xs text-muted">
                        {r.orders} {r.orders === 1 ? 'venta' : 'ventas'}, te pagaron {clp(r.paid)}
                      </p>
                    </div>
                  );
                })}
              </Card>
              <Help label="¿Cómo calculamos lo que ganaste?">
                <p>Por cada venta tomamos lo que el retailer te depositó (el precio menos su comisión y cargos de envío).</p>
                <p>A eso le restamos el costo del producto y el IVA que te toca pagar por esa venta.</p>
                <p>Solo contamos las ventas que ya tienen las dos cosas: pago del retailer y costo.</p>
              </Help>
            </section>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, sub, tone, href }: { label: string; value: string; sub: ReactNode; tone?: 'verde' | 'rojo'; href?: string }) {
  const body = (
    <div className={cn('h-full bg-white px-5 py-5 transition-colors', href && 'hover:bg-[#fafbfc]')}>
      <p className="text-sm text-muted">{label}</p>
      <p className={cn('figure mt-2 text-[1.85rem] leading-none font-semibold', tone === 'verde' && 'text-money-700', tone === 'rojo' && 'text-berry-700')}>{value}</p>
      <p className="mt-2 text-sm text-muted">{sub}</p>
    </div>
  );
  return href ? (
    <Link href={href} className="block">
      {body}
    </Link>
  ) : (
    body
  );
}

function MiniStat({ icon, label, value, href, action }: { icon: ReactNode; label: string; value: string; href: string; action: string }) {
  return (
    <Card className="flex items-center gap-4 px-5 py-4">
      <span className="text-muted [&>svg]:size-5 [&>svg]:stroke-[1.75]">{icon}</span>
      <div className="flex-1">
        <p className="text-sm text-muted">{label}</p>
        <p className="figure text-xl font-semibold">{value}</p>
      </div>
      <Link href={href} className="text-sm font-medium text-brand-700 hover:underline">
        {action}
      </Link>
    </Card>
  );
}
