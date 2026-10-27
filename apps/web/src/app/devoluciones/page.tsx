'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, CheckCircle2, PackageOpen, ScanBarcode, Search, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { BarcodeScanner, readTextFrom } from '@/components/barcode-scanner';
import { useSession } from '@/components/session';
import { Button, Card, dmy, ErrorBox, inputCls, Loading, Page, Pill } from '@/components/ui';
import { ORDER_STATE_INFO, type OrderState } from '@cuadra/shared';
import { api, type ReceiveReturnInput, type ReturnStatus, type ScannedOrder } from '@/lib/api';
import { cn } from '@/lib/cn';

const REASONS = ['Devolución del cliente', 'Cliente no recibió / rechazó', 'Producto con falla', 'Cambio de producto', 'Otro'];

const STATUS: Record<ReturnStatus, { label: string; tone: 'verde' | 'ambar' | 'rojo' | 'azul' | 'gris' }> = {
  SOLICITADA: { label: 'Solicitada', tone: 'ambar' },
  EN_TRANSITO: { label: 'En camino', tone: 'azul' },
  RECIBIDA: { label: 'Recibida', tone: 'verde' },
  CERRADA: { label: 'Cerrada', tone: 'gris' },
  RECHAZADA: { label: 'Rechazada', tone: 'rojo' },
};

/**
 * Devoluciones: pensada para el teléfono en bodega. Se escanea el código de barras del paquete
 * con la cámara (o se escribe), Cuadra muestra a qué orden y producto corresponde y se marca
 * como recibida con el estado en que llegó.
 */
export default function ReturnsPage() {
  const { canEdit } = useSession();
  const [scanning, setScanning] = useState(false);
  const [typed, setTyped] = useState('');
  // Lo que se busca: un código (escaneado o escrito) o el texto leído de la etiqueta (OCR)
  const [query, setQuery] = useState<{ kind: 'code' | 'text'; value: string; frame?: HTMLCanvasElement | null } | null>(null);
  const code = query?.value ?? null;
  const [lastSaved, setLastSaved] = useState<string | null>(null);

  const lookup = useQuery({
    queryKey: ['return-lookup', query],
    queryFn: async () => {
      if (query!.kind === 'text') return { ...(await api.lookupReturnText(query!.value)), viaText: true };
      const r = await api.lookupReturn(query!.value);
      if (r.orders.length || !query!.frame) return { ...r, candidates: [] as string[], viaText: false };
      // El código de barras no es de una orden (ej. guía de Bluexpress en devoluciones de Walmart):
      // se leen los números impresos en la misma foto (N° de REFERENCIA / orden)
      const t = await api.lookupReturnText(await readTextFrom(query!.frame));
      return { ...t, viaText: true };
    },
    enabled: Boolean(query),
    retry: false,
  });
  const list = useQuery({ queryKey: ['returns'], queryFn: api.listReturns });
  // Si la orden se encontró por un número leído de la etiqueta, se muestra ese número
  useEffect(() => {
    if (lookup.data?.viaText && lookup.data.orders.length && lookup.data.code) setTyped(lookup.data.code);
  }, [lookup.data]);

  const onCode = useCallback((c: string, frame: HTMLCanvasElement | null = null) => {
    setScanning(false);
    setLastSaved(null);
    setTyped(c);
    setQuery({ kind: 'code', value: c, frame });
  }, []);
  const onText = useCallback((text: string) => {
    setScanning(false);
    setLastSaved(null);
    setTyped('');
    setQuery({ kind: 'text', value: text });
  }, []);

  const search = () => {
    const c = typed.trim();
    if (c) onCode(c);
  };
  const again = () => {
    setQuery(null);
    setTyped('');
    setScanning(true);
  };

  return (
    <Page title="Devoluciones" intro="Escanea el código de barras del paquete devuelto para ver de qué orden y producto es, y márcalo como recibido.">
      <div className="mx-auto max-w-xl space-y-4">
        <Card className="space-y-3 p-4">
          {scanning ? (
            <>
              <BarcodeScanner onCode={onCode} onText={onText} />
              <Button variant="secondary" className="w-full" onClick={() => setScanning(false)}>
                <X className="size-4" /> Cerrar cámara
              </Button>
            </>
          ) : (
            <Button size="lg" className="w-full" onClick={() => setScanning(true)}>
              <Camera className="size-5" /> Escanear con la cámara
            </Button>
          )}
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              search();
            }}
          >
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="O escribe el código / N° de orden"
              className={inputCls}
              autoCapitalize="characters"
              enterKeyHint="search"
            />
            <Button type="submit" variant="secondary" disabled={!typed.trim()} aria-label="Buscar">
              <Search className="size-4" />
            </Button>
          </form>
        </Card>

        {lastSaved && (
          <div className="anim-rise flex items-center justify-between gap-3 rounded-2xl bg-money-50 px-4 py-3 text-sm text-money-700">
            <span className="flex items-center gap-2">
              <CheckCircle2 className="size-5 shrink-0" /> Devolución de {lastSaved} marcada como recibida.
            </span>
            <Button size="sm" onClick={again}>
              <ScanBarcode className="size-4" /> Otra
            </Button>
          </div>
        )}

        {code &&
          !lastSaved &&
          (lookup.isLoading ? (
            <Loading />
          ) : lookup.error ? (
            <ErrorBox error={lookup.error} />
          ) : !lookup.data?.orders.length ? (
            <Card className="p-5 text-center">
              <PackageOpen className="mx-auto mb-2 size-7 text-muted" />
              {lookup.data?.viaText ? (
                <>
                  <p className="font-medium">Ningún número de la etiqueta calza con una venta</p>
                  {lookup.data?.candidates.length ? (
                    <>
                      <p className="mt-2 text-sm text-muted">Números leídos (toca uno para corregirlo):</p>
                      <div className="mt-2 flex flex-wrap justify-center gap-1.5">
                        {lookup.data.candidates.slice(0, 8).map((c) => (
                          <button
                            key={c}
                            onClick={() => setTyped(c)}
                            className="rounded-lg border border-line bg-white px-2 py-1 font-mono text-xs hover:border-brand-500"
                          >
                            {c}
                          </button>
                        ))}
                      </div>
                    </>
                  ) : (
                    <p className="mt-2 text-sm text-muted">No se pudo leer ningún número. Acerca más la cámara a la etiqueta, con buena luz.</p>
                  )}
                </>
              ) : (
                <>
                  <p className="font-medium">No encontramos ventas con el código</p>
                  <p className="mt-1 font-mono text-sm break-all">{code}</p>
                  <p className="mt-2 text-sm text-muted">
                    Ese código de barras puede ser la guía del courier, no la orden (pasa en las devoluciones de Walmart). Abre la cámara y usa{' '}
                    <b>Leer número de la etiqueta</b> apuntando al N° de REFERENCIA u orden, o escríbelo a mano.
                  </p>
                </>
              )}
              <Button variant="secondary" className="mt-3" onClick={again}>
                <Camera className="size-4" /> Escanear de nuevo
              </Button>
            </Card>
          ) : (
            <div className="space-y-3">
              {lookup.data.orders.length > 1 && (
                <p className="text-sm text-muted">El código calza con {lookup.data.orders.length} órdenes. Elige la que corresponde.</p>
              )}
              {lookup.data.orders.map((o) => (
                <OrderCard
                  key={`${o.retailerCode}|${o.orderNumber}`}
                  order={o}
                  code={lookup.data!.code || code || ''}
                  canEdit={canEdit}
                  onSaved={() => {
                    setLastSaved(`${o.retailer} ${o.orderNumber}`);
                    setQuery(null);
                  }}
                />
              ))}
            </div>
          ))}

        {/* Últimas devoluciones */}
        <section>
          <h2 className="mb-2 text-sm font-semibold text-ink/85">Últimas devoluciones</h2>
          {list.isLoading ? (
            <Loading />
          ) : !list.data?.length ? (
            <p className="text-sm text-muted">Aún no hay devoluciones registradas.</p>
          ) : (
            <Card className="divide-y divide-line">
              {list.data.slice(0, 30).map((r) => (
                <div key={r.id} className="flex items-start justify-between gap-3 px-4 py-3 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{r.productName ?? 'Producto'}</p>
                    <p className="text-xs text-muted">
                      {r.retailer} · {r.orderNumber} · {dmy(r.receivedAt ?? r.requestedAt)}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <Pill tone={STATUS[r.status]?.tone ?? 'gris'}>{STATUS[r.status]?.label ?? r.status}</Pill>
                    {r.productCondition && (
                      <span className={cn('text-xs font-medium', r.productCondition === 'DANADO' ? 'text-berry-700' : 'text-money-700')}>
                        {r.productCondition === 'DANADO' ? 'Dañado' : 'Buen estado'}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </Card>
          )}
        </section>
      </div>
    </Page>
  );
}

function OrderCard({ order: o, code, canEdit, onSaved }: { order: ScannedOrder; code: string; canEdit: boolean; onSaved: () => void }) {
  const qc = useQueryClient();
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(o.lines.map((l) => l.saleId)));
  const [condition, setCondition] = useState<'BUENO' | 'DANADO' | null>(null);
  const [reason, setReason] = useState(REASONS[0]);
  const [notes, setNotes] = useState('');
  useEffect(() => setChosen(new Set(o.lines.map((l) => l.saleId))), [o]);

  const state = ORDER_STATE_INFO[o.state as OrderState] ?? ORDER_STATE_INFO.OTRO;
  const received = o.existing && ['RECIBIDA', 'CERRADA'].includes(o.existing.status);

  const save = useMutation({
    mutationFn: () => {
      const lines = o.lines.filter((l) => chosen.has(l.saleId));
      const input: ReceiveReturnInput = {
        retailerCode: o.retailerCode,
        orderNumber: o.orderNumber,
        code,
        scope: lines.length === o.lines.length ? 'TOTAL' : 'PARCIAL',
        products: lines.map((l) => `${l.product}${l.quantity > 1 ? ` x${l.quantity}` : ''}`),
        productCondition: condition!,
        reason,
        notes: notes.trim() || null,
      };
      return api.receiveReturn(input);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['returns'] });
      onSaved();
    },
  });

  return (
    <Card className="anim-rise overflow-hidden">
      <div className="space-y-1 border-b border-line px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold tracking-wide text-muted uppercase">{o.retailer}</span>
          <Pill tone={state.tone}>{state.label}</Pill>
        </div>
        <p className="display text-xl font-semibold break-all">OC {o.orderNumber}</p>
        <p className="text-sm text-muted">
          {[o.customer, o.commune].filter(Boolean).join(' · ') || 'Sin datos del cliente'}
          {o.orderDate && ` · comprada el ${dmy(o.orderDate)}`}
        </p>
        <p className="text-xs text-muted">
          Encontrada por {o.matchedBy.toLowerCase()}
          {o.courier && ` · ${o.courier}`}
          {o.tracking && ` · seguimiento ${o.tracking}`}
        </p>
        {o.existing && (
          <p className={cn('text-xs font-medium', received ? 'text-money-700' : 'text-sun-700')}>
            {received
              ? `Ya se registró como ${STATUS[o.existing.status].label.toLowerCase()}${o.existing.receivedAt ? ` el ${dmy(o.existing.receivedAt)}` : ''}.`
              : `Tiene una devolución ${STATUS[o.existing.status].label.toLowerCase()}: al guardar queda recibida.`}
          </p>
        )}
      </div>

      <ul className="divide-y divide-line">
        {o.lines.map((l) => (
          <li key={l.saleId}>
            <label className="flex cursor-pointer items-start gap-3 px-4 py-3">
              {o.lines.length > 1 && (
                <input
                  type="checkbox"
                  className="mt-1 size-5 accent-brand-600"
                  checked={chosen.has(l.saleId)}
                  onChange={(e) =>
                    setChosen((s) => {
                      const n = new Set(s);
                      if (e.target.checked) n.add(l.saleId);
                      else n.delete(l.saleId);
                      return n;
                    })
                  }
                />
              )}
              <span className="min-w-0 flex-1">
                <span className="block text-base leading-snug font-semibold">{l.product}</span>
                {l.retailName && <span className="block text-xs text-muted">{l.retailName}</span>}
                <span className="mt-0.5 block font-mono text-xs text-muted">{[l.parentSku, l.sku].filter(Boolean).join(' · ') || 'Sin SKU'}</span>
              </span>
              <span className="figure shrink-0 text-sm font-medium">×{l.quantity}</span>
            </label>
          </li>
        ))}
      </ul>

      {canEdit && !received && (
        <div className="space-y-3 border-t border-line bg-[#fafbfc] px-4 py-4">
          <div>
            <p className="mb-1.5 text-[0.8125rem] font-medium text-ink/85">¿Cómo llegó?</p>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  ['BUENO', 'Buen estado'],
                  ['DANADO', 'Dañado'],
                ] as const
              ).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setCondition(v)}
                  className={cn(
                    'rounded-xl border px-3 py-3 text-sm font-semibold transition-colors',
                    condition === v
                      ? v === 'BUENO'
                        ? 'border-money-600 bg-money-50 text-money-700 ring-2 ring-money-100'
                        : 'border-berry-500 bg-berry-50 text-berry-700 ring-2 ring-berry-100'
                      : 'border-line bg-white hover:border-line-strong',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <select value={reason} onChange={(e) => setReason(e.target.value)} className={inputCls} aria-label="Motivo">
            {REASONS.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Nota (opcional): caja rota, falta una pieza…" className={inputCls} />
          <ErrorBox error={save.error} />
          <Button size="lg" className="w-full" onClick={() => save.mutate()} loading={save.isPending} disabled={!condition || !chosen.size}>
            <CheckCircle2 className="size-5" /> Marcar como recibida
            {o.lines.length > 1 && chosen.size < o.lines.length ? ` (${chosen.size} de ${o.lines.length})` : ''}
          </Button>
          {!condition && <p className="text-center text-xs text-muted">Elige cómo llegó el producto</p>}
        </div>
      )}
    </Card>
  );
}
