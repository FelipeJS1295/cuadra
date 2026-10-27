'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, FileSpreadsheet, UploadCloud } from 'lucide-react';
import { useRef, useState } from 'react';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Button, ErrorBox, Field, inputCls, Modal } from './ui';

/**
 * Subir un Excel de ventas o de liquidación de un retailer.
 * Se elige el retailer, se arrastra el archivo y se muestra el resultado en palabras.
 */
export function UploadDialog({ kind, onClose }: { kind: 'ventas' | 'liquidacion'; onClose: () => void }) {
  const qc = useQueryClient();
  const retailers = useQuery({
    queryKey: ['import-retailers', kind],
    queryFn: kind === 'ventas' ? api.importRetailers : api.settlementRetailers,
  });
  const [retailer, setRetailer] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const upload = useMutation({
    mutationFn: async () => {
      if (kind === 'ventas') {
        const r = await api.importSales(retailer, file!);
        return { ok: r.inserted, other: r.skipped, errors: r.errors, rows: r.totalRows };
      }
      const r = await api.importSettlement(retailer, file!);
      return { ok: r.inserted, other: r.updated, errors: r.errors, rows: r.totalRows };
    },
    onSuccess: () => {
      for (const k of ['sales', 'home', 'receivables', 'reconciliation', 'onboarding', 'vat']) qc.invalidateQueries({ queryKey: [k] });
    },
  });

  const title = kind === 'ventas' ? 'Subir ventas' : 'Subir liquidación';
  if (upload.data) {
    const r = upload.data;
    return (
      <Modal title={title} onClose={onClose} footer={<Button onClick={onClose}>Listo</Button>}>
        <div className="flex items-start gap-3 rounded-xl bg-money-50 p-4">
          <CheckCircle2 className="mt-0.5 size-6 shrink-0 text-money-600" />
          <div>
            <p className="font-semibold">Archivo leído: {r.rows} filas</p>
            <p className="text-sm text-ink">
              {kind === 'ventas'
                ? `${r.ok} ventas nuevas${r.other ? ` · ${r.other} ya estaban cargadas (no se duplican)` : ''}.`
                : `${r.ok} movimientos nuevos${r.other ? ` · ${r.other} actualizados` : ''}.`}
            </p>
          </div>
        </div>
        {r.errors.length > 0 && (
          <div className="rounded-xl bg-sun-50 p-4 text-sm">
            <p className="font-medium text-sun-700">{r.errors.length} filas no se pudieron leer:</p>
            <ul className="mt-1 max-h-40 space-y-0.5 overflow-auto text-xs">
              {r.errors.slice(0, 50).map((e) => (
                <li key={e.row}>
                  Fila {e.row}: {e.message}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Modal>
    );
  }

  return (
    <Modal
      title={title}
      intro={
        kind === 'ventas'
          ? 'Descarga el reporte de órdenes desde el portal del retailer (Excel o CSV) y súbelo tal cual. Las ventas que ya estaban no se duplican.'
          : 'Descarga la liquidación o estado de cuenta del retailer y súbela tal cual. Cuadra la cruza sola con tus ventas.'
      }
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => upload.mutate()} loading={upload.isPending} disabled={!retailer || !file}>
            Subir archivo
          </Button>
        </>
      }
    >
      <Field label="¿De qué retailer es?">
        <select value={retailer} onChange={(e) => setRetailer(e.target.value)} className={inputCls}>
          <option value="">Elige uno…</option>
          {retailers.data?.map((r) => (
            <option key={r.code} value={r.code}>
              {r.name}
            </option>
          ))}
        </select>
      </Field>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
        }}
        onClick={() => input.current?.click()}
        className={cn(
          'flex cursor-pointer flex-col items-center rounded-2xl border-2 border-dashed px-6 py-10 text-center transition',
          drag ? 'border-brand-500 bg-brand-50' : 'border-line hover:border-brand-200 hover:bg-stone-50',
        )}
      >
        {file ? (
          <>
            <FileSpreadsheet className="size-10 text-brand-600" />
            <p className="mt-2 font-medium">{file.name}</p>
            <p className="text-xs text-muted">Haz clic para cambiarlo</p>
          </>
        ) : (
          <>
            <UploadCloud className="size-10 text-muted" />
            <p className="mt-2 font-medium">Arrastra el archivo aquí</p>
            <p className="text-sm text-muted">o haz clic para buscarlo (.xlsx, .xls o .csv)</p>
          </>
        )}
        <input ref={input} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => e.target.files?.[0] && setFile(e.target.files[0])} />
      </div>
      <ErrorBox error={upload.error ?? retailers.error} />
    </Modal>
  );
}
