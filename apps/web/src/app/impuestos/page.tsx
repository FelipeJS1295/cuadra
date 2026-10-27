'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownCircle, ArrowUpCircle, Download, FileMinus, Landmark, Scale } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { useSession } from '@/components/session';
import { Button, Card, clp, dmy, Empty, ErrorBox, Field, inputCls, Loading, Modal, monthLabel, MonthPicker, Page, Pill, Tabs, td, th, todayCL } from '@/components/ui';
import { api, type CreditNotePending } from '@/lib/api';
import { cn } from '@/lib/cn';

export default function TaxesPage() {
  const [month, setMonth] = useState(todayCL().slice(0, 7));
  const [tab, setTab] = useState<'iva' | 'notas'>(typeof window !== 'undefined' && window.location.search.includes('tab=notas') ? 'notas' : 'iva');
  return (
    <Page
      title="Impuestos"
      intro="Tu IVA del mes explicado simple, y las notas de crédito de las ventas que se cancelaron."
      help={
        <>
          <p>
            <b>IVA de tus ventas</b>: el 19% que va incluido en tus boletas. Ese se lo debes al SII.
          </p>
          <p>
            <b>IVA que descuentas</b>: el 19% que tú pagaste en las facturas de tus proveedores y en las comisiones y envíos que te cobran los retailers.
          </p>
          <p>
            Lo que pagas es la resta. Es un cálculo de referencia para preparar tu F29: compáralo siempre con el Registro de Compras y Ventas del SII.
          </p>
        </>
      }
      actions={<MonthPicker value={month} onChange={setMonth} />}
    >
      <div className="mb-4">
        <Tabs
          value={tab}
          onChange={setTab}
          items={[
            { id: 'iva', label: 'IVA del mes' },
            { id: 'notas', label: 'Notas de crédito' },
          ]}
        />
      </div>
      {tab === 'iva' ? <Vat month={month} /> : <CreditNotes />}
    </Page>
  );
}

function Vat({ month }: { month: string }) {
  const months = useQuery({ queryKey: ['vat', 'months'], queryFn: () => api.vatMonths(12) });
  const check = useMutation({ mutationFn: () => api.salesCheck(month) });
  const sii = useQuery({ queryKey: ['sii-status'], queryFn: api.siiStatus, staleTime: 300_000 });
  const m = months.data?.find((x) => x.month === month);
  if (months.isLoading) return <Loading />;
  if (!m) return <ErrorBox error={months.error ?? 'Sin datos para este mes'} />;
  const pays = m.balance >= 0;
  return (
    <div className="space-y-6">
      <Card className={cn('p-6', pays ? 'bg-white' : 'bg-money-50')}>
        <p className="text-sm font-medium text-muted capitalize">{monthLabel(month)}</p>
        <p className="mt-1 text-lg">{pays ? 'Este mes pagas de IVA' : 'Este mes te queda IVA a favor'}</p>
        <p className={cn('num text-5xl font-semibold tracking-tight', pays ? 'text-ink' : 'text-money-700')}>{clp(Math.abs(m.balance))}</p>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <div className="rounded-2xl bg-stone-50 p-4">
            <p className="flex items-center gap-2 font-medium">
              <ArrowUpCircle className="size-5 text-berry-500" /> IVA de tus ventas
            </p>
            <p className="num mt-1 text-2xl font-semibold">{clp(m.debit)}</p>
            <ul className="mt-2 space-y-0.5 text-sm text-muted">
              <li className="flex justify-between">
                <span>Boletas y facturas</span>
                <span className="num">{clp(m.debitReceipts)}</span>
              </li>
              <li className="flex justify-between">
                <span>Menos notas de crédito</span>
                <span className="num">{clp(m.debitCreditNotes)}</span>
              </li>
            </ul>
          </div>
          <div className="rounded-2xl bg-stone-50 p-4">
            <p className="flex items-center gap-2 font-medium">
              <ArrowDownCircle className="size-5 text-money-500" /> IVA que descuentas
            </p>
            <p className="num mt-1 text-2xl font-semibold">{clp(m.credit)}</p>
            <ul className="mt-2 space-y-0.5 text-sm text-muted">
              <li className="flex justify-between">
                <span>Facturas de proveedores</span>
                <span className="num">{clp(m.creditPurchases)}</span>
              </li>
              <li className="flex justify-between">
                <span>Comisiones de retailers</span>
                <span className="num">{clp(m.creditCommissions)}</span>
              </li>
              <li className="flex justify-between">
                <span>Envíos y logística</span>
                <span className="num">{clp(m.creditLogistics)}</span>
              </li>
            </ul>
          </div>
        </div>
        {(m.salesWithoutReceipt > 0 || m.draftCreditNotes > 0) && (
          <div className="mt-4 rounded-xl bg-sun-50 p-4 text-sm text-sun-700">
            {m.salesWithoutReceipt > 0 && (
              <p>
                Ojo: tienes ventas por {clp(m.salesWithoutReceipt)} sin boleta. Su IVA ({clp(m.salesWithoutReceiptVat)}) todavía no está sumado.{' '}
                <Link href="/ventas?filtro=sin-boleta" className="font-medium underline">
                  Ver ventas sin boleta
                </Link>
              </p>
            )}
            {m.draftCreditNotes > 0 && <p>{m.draftCreditNotes} notas de crédito en borrador aún no rebajan el IVA: fírmalas en el portal del SII.</p>}
          </div>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <a href={api.vatCsvUrl(month)} className="inline-flex items-center gap-2 rounded-xl border border-line bg-white px-4 py-2 text-sm font-medium hover:bg-stone-50">
            <Download className="size-4" /> Bajar detalle en Excel
          </a>
          {sii.data?.can.cuadratura && (
            <Button variant="secondary" onClick={() => check.mutate()} loading={check.isPending}>
              <Scale className="size-4" /> Comparar con el SII
            </Button>
          )}
        </div>
        <ErrorBox error={check.error} />
        {check.data && (
          <table className="mt-4 w-full text-sm">
            <thead className="border-b border-line">
              <tr>
                <th className={th}>Documento</th>
                <th className={cn(th, 'text-right')}>Cuadra</th>
                <th className={cn(th, 'text-right')}>SII</th>
                <th className={th}>¿Cuadra?</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {check.data.types.map((t) => (
                <tr key={t.type}>
                  <td className={td}>{t.name}</td>
                  <td className={cn(td, 'num text-right')}>
                    {t.erp.count} · {clp(t.erp.total)}
                  </td>
                  <td className={cn(td, 'num text-right')}>{t.sii ? `${t.sii.count} · ${clp(t.sii.total)}` : '—'}</td>
                  <td className={td}>{!t.sii ? <Pill>Sin datos</Pill> : t.totalDiff ? <Pill tone="rojo">Difiere {clp(t.totalDiff)}</Pill> : <Pill tone="verde">Sí</Pill>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function CreditNotes() {
  const { canEdit } = useSession();
  const pending = useQuery({ queryKey: ['credit-notes-pending'], queryFn: api.pendingCreditNotes });
  const list = useQuery({ queryKey: ['credit-notes'], queryFn: api.listCreditNotes });
  const [doFor, setDoFor] = useState<CreditNotePending | null>(null);
  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-2 text-lg font-semibold">Ventas canceladas con boleta sin anular</h2>
        <Card>
          {pending.isLoading ? (
            <Loading />
          ) : !pending.data?.length ? (
            <Empty icon={<FileMinus className="size-6" />} title="Nada pendiente" text="Todas las ventas canceladas tienen su nota de crédito." />
          ) : (
            <ul className="divide-y divide-line">
              {pending.data.map((p) => (
                <li key={`${p.retailerCode}-${p.orderNumber}`} className="flex flex-wrap items-center gap-4 px-5 py-4">
                  <div className="min-w-48 flex-1">
                    <p className="font-medium">{p.productName}</p>
                    <p className="text-sm text-muted">
                      {p.retailer} · orden {p.orderId ?? p.orderNumber} · boleta N° {p.receiptNumber}
                    </p>
                  </div>
                  <span className="num font-semibold text-berry-700">{clp(p.missing)}</span>
                  {canEdit && <Button onClick={() => setDoFor(p)}>Hacer nota de crédito</Button>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>
      <section>
        <h2 className="mb-2 text-lg font-semibold">Notas de crédito</h2>
        <Card>
          {!list.data?.length ? (
            <p className="p-5 text-sm text-muted">Aún no hay notas de crédito.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-line">
                <tr>
                  <th className={th}>Fecha</th>
                  <th className={th}>Venta</th>
                  <th className={cn(th, 'text-right')}>Monto</th>
                  <th className={th}>Estado</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {list.data.map((n) => (
                  <tr key={n.id}>
                    <td className={cn(td, 'text-muted')}>{dmy(n.issuedAt ?? n.createdAt)}</td>
                    <td className={td}>
                      {n.retailer} · {n.orderNumber}
                      <p className="text-xs text-muted">{n.reason}</p>
                    </td>
                    <td className={cn(td, 'num text-right')}>{clp(n.amountGross)}</td>
                    <td className={td}>
                      <Pill tone={n.status === 'BORRADOR' ? 'ambar' : n.status === 'ERROR' ? 'rojo' : 'verde'}>
                        {n.status === 'BORRADOR' ? 'Falta firmar en el SII' : n.folio ? `N° ${n.folio}` : n.status}
                      </Pill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </section>
      {doFor && <CreditNoteDialog p={doFor} onClose={() => setDoFor(null)} />}
    </div>
  );
}

function CreditNoteDialog({ p, onClose }: { p: CreditNotePending; onClose: () => void }) {
  const qc = useQueryClient();
  const sii = useQuery({ queryKey: ['sii-status'], queryFn: api.siiStatus });
  const [mode, setMode] = useState<'sii' | 'manual'>('sii');
  const [folio, setFolio] = useState('');
  const [date, setDate] = useState(todayCL());
  const base = { retailerCode: p.retailerCode, orderNumber: p.orderNumber, amountGross: p.missing, refCode: 1 as const, reason: 'Venta cancelada' };
  const save = useMutation({
    mutationFn: () => (mode === 'sii' ? api.draftCreditNote(base) : api.registerCreditNote({ ...base, folio: folio.trim(), issuedAt: date }).then(() => null)),
    onSuccess: () => {
      for (const k of ['credit-notes', 'credit-notes-pending', 'home', 'vat', 'sales']) qc.invalidateQueries({ queryKey: [k] });
    },
  });
  if (save.isSuccess) {
    return (
      <Modal title="Nota de crédito" onClose={onClose} footer={<Button onClick={onClose}>Listo</Button>}>
        {save.data?.folio ? (
          <p className="rounded-xl bg-money-50 p-3 text-sm text-money-700">
            Nota de crédito N° {save.data.folio} emitida en {sii.data?.providerName ?? 'el SII'}.
          </p>
        ) : save.data ? (
          <div className="space-y-2 text-sm">
            <p className="rounded-xl bg-money-50 p-3 text-money-700">Borrador N° {save.data.draftCode} creado en el portal del SII.</p>
            <p>Entra a sii.cl → Factura electrónica → Sistema de facturación gratuito → Documentos borradores, ábrelo y presiona “Firmar y enviar”. Cuadra anotará el folio solo.</p>
          </div>
        ) : (
          <p className="rounded-xl bg-money-50 p-3 text-money-700">Nota de crédito N° {folio} anotada.</p>
        )}
      </Modal>
    );
  }
  return (
    <Modal
      title="Anular la boleta"
      intro={`${p.retailer} · orden ${p.orderId ?? p.orderNumber} · boleta N° ${p.receiptNumber} por ${clp(p.missing)}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={(mode === 'sii' && !sii.data?.can.notasCredito) || (mode === 'manual' && !folio.trim())}>
            {mode === 'sii' ? (sii.data?.can.notasCreditoDirectas ? 'Emitir nota' : 'Crear en el SII') : 'Anotar'}
          </Button>
        </>
      }
    >
      <Tabs
        value={mode}
        onChange={setMode}
        items={[
          { id: 'sii', label: 'Crearla en el SII' },
          { id: 'manual', label: 'Ya la hice' },
        ]}
      />
      {mode === 'sii' ? (
        sii.data?.can.notasCredito ? (
          <p className="flex items-start gap-2 text-sm text-muted">
            <Landmark className="mt-0.5 size-4 shrink-0" />
            {sii.data.can.notasCreditoDirectas
              ? `Cuadra emite la nota por ${clp(p.missing)} en ${sii.data.providerName} y anota su folio.`
              : `Cuadra arma la nota en el portal del SII por ${clp(p.missing)}; tú solo la firmas allá.`}
          </p>
        ) : (
          <p className="text-sm text-sun-700">
            {sii.data?.enabled
              ? `Con ${sii.data.providerName} no se crean notas de crédito: hazla en el SII y anótala en “Ya la hice”.`
              : 'Conecta el SII en Configuración para crearlas desde aquí.'}
          </p>
        )
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="N° (folio) de la nota">
            <input value={folio} onChange={(e) => setFolio(e.target.value)} className={inputCls} />
          </Field>
          <Field label="Fecha">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />
          </Field>
        </div>
      )}
      <ErrorBox error={save.error} />
    </Modal>
  );
}
