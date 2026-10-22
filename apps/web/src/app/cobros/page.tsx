'use client';

import { useQueries, useQuery } from '@tanstack/react-query';
import { AlertTriangle, CalendarClock, Coins, Upload, Wallet } from 'lucide-react';
import { useState } from 'react';
import { useSession } from '@/components/session';
import { BigNumber, Button, Card, clp, Empty, ErrorBox, Loading, Page, Pill, shortDate, Tabs, td, th } from '@/components/ui';
import { UploadDialog } from '@/components/upload';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';

export default function CollectionsPage() {
  const { canEdit } = useSession();
  const [upload, setUpload] = useState(false);
  const [tab, setTab] = useState<'deben' | 'diferencias'>('deben');
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
            <b>Atrasado</b>: ya pasaron los días de pago que tienes con ese retailer (los configuras en Conexiones).
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
            <BigNumber label="Por vencer" value={clp(d.totals.buckets.POR_VENCER)} sub="Te deberían pagar pronto" icon={<CalendarClock className="size-4" />} tone="azul" />
          </div>

          <div className="mb-4">
            <Tabs
              value={tab}
              onChange={setTab}
              items={[
                { id: 'deben', label: 'Quién te debe' },
                { id: 'diferencias', label: 'Te pagaron distinto' },
              ]}
            />
          </div>

          {tab === 'deben' &&
            (d.retailers.length === 0 ? (
              <Card>
                <Empty icon={<Wallet className="size-6" />} title="Nadie te debe nada" text="Todas tus ventas ya fueron pagadas por los retailers." />
              </Card>
            ) : (
              <div className="grid gap-4 md:grid-cols-2">
                {d.retailers.map((r) => {
                  const items = d.items.filter((i) => i.retailerCode === r.code).sort((a, b) => b.daysOverdue - a.daysOverdue);
                  return (
                    <Card key={r.code} className="p-5">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-lg font-semibold">{r.name}</p>
                          <p className="text-sm text-muted">
                            Paga a {r.paymentDays} días desde {r.paymentBase === 'ORDEN' ? 'la venta' : 'el despacho'}
                            {r.commissionPct ? ` · comisión ${r.commissionPct}%` : ''}
                          </p>
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
                                Vendida {shortDate(i.orderDate)} · {i.daysOverdue > 0 ? <span className="text-berry-700">atrasada {i.daysOverdue} días</span> : `vence en ${i.daysToDue} días`}
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
