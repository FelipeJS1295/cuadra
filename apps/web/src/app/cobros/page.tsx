'use client';

import { useQueries, useQuery } from '@tanstack/react-query';
import { AlertTriangle, CalendarClock, Coins, Upload, Wallet } from 'lucide-react';
import { useState } from 'react';
import { useSession } from '@/components/session';
import { BigNumber, Button, Card, clp, Empty, ErrorBox, Loading, Page, Pill, shortDate, Tabs, td, th } from '@/components/ui';
import { UploadDialog } from '@/components/upload';
import { api, type Receivables } from '@/lib/api';
import { cn } from '@/lib/cn';

export default function CollectionsPage() {
  const { canEdit } = useSession();
  const [upload, setUpload] = useState(false);
  const [tab, setTab] = useState<'calendario' | 'deben' | 'diferencias'>('calendario');
  const cxc = useQuery({ queryKey: ['receivables'], queryFn: api.receivables });
  const retailers = useQuery({ queryKey: ['import-retailers', 'liquidacion'], queryFn: api.settlementRetailers });
  const recs = useQueries({
    queries: (retailers.data ?? []).map((r) => ({ queryKey: ['reconciliation', r.code], queryFn: () => api.reconcile(r.code), enabled: tab === 'diferencias' })),
  });
  const diffs = recs.flatMap((q, i) =>
    (q.data?.rows ?? []).filter((r) => r.status === 'CON_DIFERENCIA').map((r) => ({ ...r, retailer: retailers.data![i].name })),
  );
  const d = cxc.data;

  return (
    <Page
      title="Cobros"
      intro="Cuánto te deben los retailers, cuándo te deberían pagar y si te pagaron bien."
      help={
        <>
          <p>
            <b>Te deben</b>: ventas que el retailer aún no paga en una liquidación. Lo esperado es el precio menos la comisión pactada.
          </p>
          <p>
            <b>Cuándo te pagan</b>: cada retailer paga distinto. Walmart cierra el 14 y fin de mes y paga 7 días hábiles después; Falabella
            paga 8 días hábiles después de que el cliente recibe; Paris paga los miércoles lo entregado la semana anterior. Lo ajustas en
            Configuración → Conexiones → tu retailer.
          </p>
          <p>
            Si la venta aún no se entrega, la fecha es <b>estimada</b> (≈): supone que llega a tiempo.
          </p>
          <p>
            <b>Atrasado</b>: ya pasó la fecha en que debía llegar el pago.
          </p>
          <p>
            <b>Diferencias</b>: ventas que el retailer pagó distinto a lo esperado (otra comisión, menos plata, cobros extra).
          </p>
        </>
      }
      actions={
        canEdit && (
          <Button onClick={() => setUpload(true)}>
            <Upload className="size-4" /> Subir liquidación
          </Button>
        )
      }
    >
      <ErrorBox error={cxc.error} />
      {cxc.isLoading && <Loading />}
      {d && (
        <>
          <div className="mb-6 grid gap-4 sm:grid-cols-3">
            <BigNumber label="Te deben en total" value={clp(d.totals.expected)} sub={`${d.totals.orders} ventas sin pagar`} icon={<Coins className="size-4" />} tone="ambar" />
            <BigNumber
              label="Atrasado"
              value={clp(d.totals.overdue)}
              sub={d.totals.overdue > 0 ? 'Ya debieron pagarte esto' : 'Nada atrasado'}
              icon={<AlertTriangle className="size-4" />}
              tone={d.totals.overdue > 0 ? 'rojo' : 'verde'}
            />
            <BigNumber
              label="Próximo pago"
              value={d.upcoming[0] ? clp(d.upcoming.filter((u) => u.date === d.upcoming[0].date).reduce((n, u) => n + u.amount, 0)) : '—'}
              sub={
                d.upcoming[0]
                  ? `${dayLabel(d.upcoming[0].date)} · ${d.upcoming
                      .filter((u) => u.date === d.upcoming[0].date)
                      .map((u) => u.retailer)
                      .join(', ')}`
                  : 'Sin pagos pendientes'
              }
              icon={<CalendarClock className="size-4" />}
              tone="azul"
            />
          </div>

          <div className="mb-4">
            <Tabs
              value={tab}
              onChange={setTab}
              items={[
                { id: 'calendario', label: 'Cuándo te pagan' },
                { id: 'deben', label: 'Quién te debe' },
                { id: 'diferencias', label: 'Te pagaron distinto' },
              ]}
            />
          </div>

          {tab === 'calendario' && <Calendar d={d} />}

          {tab === 'deben' &&
            (d.retailers.length === 0 ? (
              <Card>
                <Empty icon={<Wallet className="size-6" />} title="Nadie te debe nada" text="Todas tus ventas ya fueron pagadas por los retailers." />
              </Card>
            ) : (
              <div className="grid gap-4 md:grid-cols-2">
                {d.retailers.map((r) => {
                  const items = d.items
                    .filter((i) => i.retailerCode === r.code)
                    .sort((a, b) => b.daysOverdue - a.daysOverdue || (a.dueDate ?? '').localeCompare(b.dueDate ?? ''));
                  return (
                    <Card key={r.code} className="p-5">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-lg font-semibold">{r.name}</p>
                          <p className="text-sm text-muted">
                            {r.terms}
                            {r.commissionPct ? ` · comisión ${r.commissionPct}%` : ''}
                          </p>
                          {r.nextPayment && (
                            <p className="mt-1 text-sm">
                              Próximo pago: <b>{dayLabel(r.nextPayment.date)}</b> · {clp(r.nextPayment.amount)}
                            </p>
                          )}
                        </div>
                        <div className="text-right">
                          <p className="num text-xl font-semibold">{clp(r.expected)}</p>
                          {r.overdue > 0 && <Pill tone="rojo">{clp(r.overdue)} atrasado</Pill>}
                        </div>
                      </div>
                      <ul className="mt-4 divide-y divide-line text-sm">
                        {items.slice(0, 6).map((i) => (
                          <li key={i.orderNumber} className="flex items-center justify-between gap-3 py-2">
                            <div className="min-w-0">
                              <p className="truncate">{i.productName ?? i.orderLabel ?? i.orderNumber}</p>
                              <p className="text-xs text-muted">
                                Vendida {shortDate(i.orderDate)}
                                {i.deliveredAt ? ` · entregada ${shortDate(i.deliveredAt)}` : ''} ·{' '}
                                {i.daysOverdue > 0 ? (
                                  <span className="text-berry-700">atrasada {i.daysOverdue} días</span>
                                ) : (
                                  <span title={i.dueWhy}>
                                    llega {i.dueEstimated ? '≈ ' : ''}
                                    {i.dueDate ? dayLabel(i.dueDate) : 'sin fecha'}
                                  </span>
                                )}
                              </p>
                            </div>
                            <span className="num shrink-0">{clp(i.expected)}</span>
                          </li>
                        ))}
                      </ul>
                      {items.length > 6 && <p className="mt-1 text-xs text-muted">y {items.length - 6} ventas más</p>}
                    </Card>
                  );
                })}
              </div>
            ))}

          {tab === 'diferencias' && (
            <Card>
              {recs.some((q) => q.isLoading) ? (
                <Loading label="Revisando las liquidaciones…" />
              ) : diffs.length === 0 ? (
                <Empty title="Todo cuadra" text="No encontramos ventas pagadas distinto a lo esperado." />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="border-b border-line">
                      <tr>
                        <th className={th}>Venta</th>
                        <th className={cn(th, 'text-right')}>Vendiste</th>
                        <th className={cn(th, 'text-right')}>Te pagaron</th>
                        <th className={th}>Qué pasó</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {diffs.map((r, i) => (
                        <tr key={i}>
                          <td className={td}>
                            <p className="font-medium">{r.productName}</p>
                            <p className="text-xs text-muted">
                              {r.retailer} · {r.orderLabel ?? r.orderNumber} · {shortDate(r.orderDate)}
                            </p>
                          </td>
                          <td className={cn(td, 'num text-right')}>{clp(r.salePrice)}</td>
                          <td className={cn(td, 'num text-right')}>{clp(r.net)}</td>
                          <td className={cn(td, 'text-sm')}>
                            {r.reasons.map((x) => (
                              <p key={x}>{x}</p>
                            ))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          )}
        </>
      )}
      {upload && <UploadDialog kind="liquidacion" onClose={() => setUpload(false)} />}
    </Page>
  );
}

const WD = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
/** "2026-10-28" -> "mié 28 oct" */
function dayLabel(d: string) {
  const x = new Date(`${d.slice(0, 10)}T12:00:00Z`);
  return `${WD[x.getUTCDay()]} ${shortDate(d)}`;
}

/** Próximos pagos agrupados por fecha, y lo atrasado arriba */
function Calendar({ d }: { d: Receivables }) {
  const dates = [...new Set(d.upcoming.map((u) => u.date))];
  const overdue = d.retailers.filter((r) => r.overdue > 0);
  if (!dates.length && !overdue.length)
    return (
      <Card>
        <Empty icon={<Wallet className="size-6" />} title="Nadie te debe nada" text="Todas tus ventas ya fueron pagadas por los retailers." />
      </Card>
    );
  return (
    <div className="space-y-4">
      {overdue.length > 0 && (
        <Card className="border-berry-100 bg-berry-50/40 p-4">
          <p className="flex items-center gap-2 font-medium text-berry-700">
            <AlertTriangle className="size-4" /> Debió llegar y no llegó
          </p>
          <ul className="mt-2 space-y-1 text-sm">
            {overdue.map((r) => (
              <li key={r.code} className="flex justify-between gap-3">
                <span>{r.name}</span>
                <span className="num font-medium">{clp(r.overdue)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">Revisa si llegó la liquidación y súbela, o reclama al retailer.</p>
        </Card>
      )}
      <Card>
        <ul className="divide-y divide-line">
          {dates.slice(0, 12).map((date) => {
            const rows = d.upcoming.filter((u) => u.date === date);
            const total = rows.reduce((n, u) => n + u.amount, 0);
            const allEstimated = rows.every((u) => u.estimated === u.amount);
            return (
              <li key={date} className="flex flex-wrap items-start gap-x-6 gap-y-2 px-5 py-4">
                <div className="w-28 shrink-0">
                  <p className="font-semibold first-letter:uppercase">{dayLabel(date)}</p>
                  <p className="text-xs text-muted">{daysFrom(d.today, date)}</p>
                </div>
                <div className="min-w-0 flex-1 space-y-1 text-sm">
                  {rows.map((u) => (
                    <div key={u.retailerCode} className="flex justify-between gap-3">
                      <span>
                        {u.retailer} <span className="text-muted">· {u.orders} {u.orders === 1 ? 'venta' : 'ventas'}</span>
                        {u.estimated > 0 && (
                          <span className="ml-1 text-xs text-muted" title="Ventas aún no entregadas: la fecha supone que llegan a tiempo">
                            {u.estimated === u.amount ? '(estimado)' : `(${clp(u.estimated)} estimado)`}
                          </span>
                        )}
                      </span>
                      <span className="num">{clp(u.amount)}</span>
                    </div>
                  ))}
                </div>
                <p className={cn('num w-28 shrink-0 text-right text-lg font-semibold', allEstimated && 'text-muted')}>
                  {allEstimated ? '≈ ' : ''}
                  {clp(total)}
                </p>
              </li>
            );
          })}
        </ul>
      </Card>
      <p className="text-xs text-muted">
        Lo esperado es la venta menos la comisión pactada; la liquidación puede traer otros descuentos (despacho, multas). Las fechas consideran
        fines de semana y feriados.
      </p>
    </div>
  );
}

function daysFrom(today: string, date: string) {
  const n = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
  return n === 0 ? 'hoy' : n === 1 ? 'mañana' : `en ${n} días`;
}
