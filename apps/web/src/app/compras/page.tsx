'use client';

import { useQuery } from '@tanstack/react-query';
import { CloudDownload, Plus, Receipt, Truck, Wallet } from 'lucide-react';
import { useMemo, useState } from 'react';
import { AssignDialog, InvoiceDetail, SiiImportDialog } from '@/components/purchases';
import { useSession } from '@/components/session';
import { BigNumber, Button, Card, clp, Empty, ErrorBox, Loading, Page, Pill, shortDate, Tabs, td, th } from '@/components/ui';
import { api, type PurchaseInvoice } from '@/lib/api';
import { cn } from '@/lib/cn';

const STATUS = {
  PENDIENTE: { label: 'Por pagar', tone: 'rojo' as const },
  PARCIAL: { label: 'Abonada', tone: 'ambar' as const },
  PAGADA: { label: 'Pagada', tone: 'verde' as const },
  NOTA_CREDITO: { label: 'Nota de crédito', tone: 'azul' as const },
};

export default function PurchasesPage() {
  const { canEdit, isFactory } = useSession();
  const invoices = useQuery({ queryKey: ['invoices'], queryFn: api.listInvoices });
  const sii = useQuery({ queryKey: ['sii-status'], queryFn: api.siiStatus, staleTime: 300_000 });
  const [tab, setTab] = useState<'pagar' | 'todas'>('pagar');
  const [open, setOpen] = useState<PurchaseInvoice | null>(null);
  const [assign, setAssign] = useState<{ invoice: PurchaseInvoice | null } | null>(null);
  const [siiOpen, setSiiOpen] = useState(false);
  const all = invoices.data ?? [];
  const rows = useMemo(() => (tab === 'pagar' ? all.filter((i) => i.balance > 0) : all), [all, tab]);
  const bySupplier = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of all) if (i.balance > 0) m.set(i.supplier, (m.get(i.supplier) ?? 0) + i.balance);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [all]);

  return (
    <Page
      title="Compras"
      intro={
        isFactory
          ? 'Las facturas de tus proveedores de insumos: cuánto les debes y cuánto les pagaste.'
          : 'Las facturas de tus proveedores: cuánto les debes y a qué ventas corresponden.'
      }
      help={
        <>
          {isFactory ? (
            <p>Como fabricas, el costo de cada venta sale de la receta de insumos (en Productos), no de estas facturas. Aquí llevas lo que debes y pagas.</p>
          ) : (
            <p>Cada factura del proveedor se asigna a las ventas que cubre. Así Cuadra sabe cuánto te costó cada producto que vendiste.</p>
          )}
          <p>Si tienes el SII conectado, puedes traer las facturas solas desde el Registro de Compras.</p>
        </>
      }
      actions={
        canEdit && (
          <>
            {sii.data?.can.compras && (
              <Button variant="secondary" onClick={() => setSiiOpen(true)}>
                <CloudDownload className="size-4" /> Traer del SII
              </Button>
            )}
            {!isFactory && (
              <Button onClick={() => setAssign({ invoice: null })}>
                <Plus className="size-4" /> Agregar factura
              </Button>
            )}
          </>
        )
      }
    >
      <ErrorBox error={invoices.error} />
      {invoices.isLoading ? (
        <Loading />
      ) : (
        <>
          <div className="mb-6 grid gap-4 sm:grid-cols-3">
            <BigNumber label="Le debes a proveedores" value={clp(all.reduce((n, i) => n + Math.max(0, i.balance), 0))} sub={`${all.filter((i) => i.balance > 0).length} facturas por pagar`} icon={<Wallet className="size-4" />} tone="ambar" />
            <BigNumber label="Ya pagaste" value={clp(all.reduce((n, i) => n + i.paid, 0))} icon={<Receipt className="size-4" />} tone="verde" />
            <Card className="p-5">
              <p className="flex items-center gap-2 text-sm font-medium text-muted">
                <span className="grid size-8 place-items-center rounded-full bg-stone-100">
                  <Truck className="size-4" />
                </span>
                A quién le debes
              </p>
              <ul className="mt-3 space-y-1 text-sm">
                {bySupplier.length === 0 && <li className="text-muted">A nadie. ¡Al día!</li>}
                {bySupplier.slice(0, 4).map(([s, v]) => (
                  <li key={s} className="flex justify-between gap-2">
                    <span className="truncate">{s}</span>
                    <span className="num font-medium">{clp(v)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
          <div className="mb-4">
            <Tabs
              value={tab}
              onChange={setTab}
              items={[
                { id: 'pagar', label: 'Por pagar', count: all.filter((i) => i.balance > 0).length },
                { id: 'todas', label: 'Todas', count: all.length },
              ]}
            />
          </div>
          <Card>
            {rows.length === 0 ? (
              <Empty
                icon={<Receipt className="size-6" />}
                title={all.length ? 'No debes ninguna factura' : 'Aún no hay facturas'}
                text={all.length ? undefined : 'Agrega las facturas de tus proveedores para saber cuánto ganas en cada venta.'}
                action={canEdit && !all.length && <Button onClick={() => setAssign({ invoice: null })}>Agregar factura</Button>}
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-line">
                    <tr>
                      <th className={th}>Fecha</th>
                      <th className={th}>Proveedor</th>
                      <th className={cn(th, 'text-right')}>Total</th>
                      <th className={cn(th, 'text-right')}>Falta pagar</th>
                      <th className={th}>Estado</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {rows.map((i) => (
                      <tr key={i.id} onClick={() => setOpen(i)} className="cursor-pointer hover:bg-stone-50">
                        <td className={cn(td, 'text-muted')}>{shortDate(i.issueDate)}</td>
                        <td className={td}>
                          <p className="font-medium">{i.supplier}</p>
                          <p className="text-xs text-muted">
                            N° {i.documentNumber}
                            {isFactory ? '' : ` · ${i.orders} ventas`}
                            {i.fromSii ? ' · del SII' : ''}
                          </p>
                        </td>
                        <td className={cn(td, 'num text-right')}>{clp(i.total)}</td>
                        <td className={cn(td, 'num text-right font-medium', i.balance > 0 && 'text-berry-700')}>{clp(i.balance)}</td>
                        <td className={td}>
                          <Pill tone={STATUS[i.status].tone}>{STATUS[i.status].label}</Pill>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
      {open && (
        <InvoiceDetail
          invoice={open}
          onClose={() => setOpen(null)}
          onAssign={() => {
            setAssign({ invoice: open });
            setOpen(null);
          }}
        />
      )}
      {assign && <AssignDialog invoice={assign.invoice} onClose={() => setAssign(null)} />}
      {siiOpen && <SiiImportDialog onClose={() => setSiiOpen(false)} />}
    </Page>
  );
}
