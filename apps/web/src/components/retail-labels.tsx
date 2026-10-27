'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, ExternalLink, Printer } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, type SaleRow } from '@/lib/api';
import { Button, ErrorBox, Loading, Modal } from './ui';

/**
 * Etiquetas de despacho de las ventas elegidas, sacadas de la API de cada retailer
 * (Falabella, Walmart, Mercado Libre) y juntas en un PDF para imprimir de una vez.
 */
export function RetailLabels({ sales, onClose }: { sales: SaleRow[]; onClose: () => void }) {
  const providers = useQuery({ queryKey: ['label-providers'], queryFn: api.labelProviders, staleTime: 300_000 });
  const [pack, setPack] = useState(true);
  const [url, setUrl] = useState<string | null>(null);

  // Una orden por línea (una orden con varios productos lleva una etiqueta)
  const orders = useMemo(() => {
    const seen = new Set<string>();
    return sales
      .filter((s) => !s.cancelled && s.orderNumber)
      .map((s) => ({ retailerCode: s.retailerCode, retailer: s.retailer, orderNumber: s.orderNumber! }))
      .filter((o) => !seen.has(`${o.retailerCode}|${o.orderNumber}`) && seen.add(`${o.retailerCode}|${o.orderNumber}`));
  }, [sales]);
  const supported = new Set((providers.data ?? []).map((p) => p.code));
  const ok = orders.filter((o) => supported.has(o.retailerCode));
  const other = orders.filter((o) => !supported.has(o.retailerCode));
  const byRetailer = (list: typeof orders) =>
    Object.entries(list.reduce<Record<string, number>>((m, o) => ({ ...m, [o.retailer]: (m[o.retailer] ?? 0) + 1 }), {}));

  const run = useMutation({
    mutationFn: () =>
      api.retailLabels(
        ok.map(({ retailerCode, orderNumber }) => ({ retailerCode, orderNumber })),
        pack,
      ),
    onSuccess: (r) => {
      const u = URL.createObjectURL(r.pdf);
      setUrl(u);
      window.open(u, '_blank');
    },
  });
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);

  return (
    <Modal
      title="Etiquetas de despacho"
      intro={`${orders.length} ${orders.length === 1 ? 'orden elegida' : 'órdenes elegidas'}`}
      onClose={onClose}
      footer={
        run.data ? (
          <>
            <Button variant="secondary" onClick={onClose}>
              Listo
            </Button>
            <a href={url!} target="_blank" rel="noreferrer">
              <Button>
                <ExternalLink className="size-4" /> Abrir PDF
              </Button>
            </a>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancelar
            </Button>
            <Button onClick={() => run.mutate()} loading={run.isPending} disabled={!ok.length}>
              <Printer className="size-4" /> Sacar {ok.length} {ok.length === 1 ? 'etiqueta' : 'etiquetas'}
            </Button>
          </>
        )
      }
    >
      {providers.isLoading ? (
        <Loading />
      ) : run.data ? (
        <div className="space-y-3 text-sm">
          <div className="anim-rise flex items-center gap-2 rounded-xl bg-money-50 px-3 py-2.5 text-money-700">
            <CheckCircle2 className="size-4 shrink-0" /> {run.data.count} {run.data.count === 1 ? 'etiqueta lista' : 'etiquetas listas'} en un PDF para
            imprimir.
          </div>
          {run.data.problems.length > 0 && (
            <div className="rounded-xl border border-sun-100 bg-sun-50 px-3 py-2.5 text-sun-700">
              <p className="mb-1 flex items-center gap-1.5 font-medium">
                <AlertTriangle className="size-4" /> Sin etiqueta ({run.data.problems.length})
              </p>
              <ul className="space-y-0.5 text-xs">
                {run.data.problems.map((p) => (
                  <li key={`${p.retailer}${p.orderNumber}`}>
                    <b>
                      {p.retailer} {p.orderNumber}
                    </b>
                    : {p.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3 text-sm">
          {ok.length > 0 ? (
            <p>
              Se piden a la API de cada retailer:{' '}
              {byRetailer(ok)
                .map(([r, n]) => `${r} (${n})`)
                .join(', ')}
              .
            </p>
          ) : (
            <p className="text-muted">Ninguna de las ventas elegidas es de un retailer que entregue etiquetas por API.</p>
          )}
          {other.length > 0 && (
            <p className="text-xs text-muted">
              {byRetailer(other)
                .map(([r, n]) => `${r} (${n})`)
                .join(', ')}
              : no entregan etiquetas por API, se imprimen en su portal.
            </p>
          )}
          {ok.some((o) => o.retailerCode === 'FALABELLA') && (
            <label className="flex items-start gap-2 rounded-xl border border-line bg-[#fafbfc] px-3 py-2.5">
              <input type="checkbox" checked={pack} onChange={(e) => setPack(e.target.checked)} className="mt-0.5 size-4 accent-brand-600" />
              <span>
                <span className="font-medium">Falabella: marcar como empacadas si falta</span>
                <span className="block text-xs text-muted">
                  Falabella solo entrega la etiqueta de pedidos empacados. Es lo mismo que hace su portal al imprimir.
                </span>
              </span>
            </label>
          )}
          <ErrorBox error={run.error ?? providers.error} />
        </div>
      )}
    </Modal>
  );
}
