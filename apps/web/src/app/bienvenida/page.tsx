'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Check, Landmark, Package, ShoppingBag, Wallet } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CompanyForm, SiiForm } from '@/components/forms';
import { Button, Card, LinkButton, Loading, Progress } from '@/components/ui';
import { UploadDialog } from '@/components/upload';
import { api, type Onboarding } from '@/lib/api';
import { cn } from '@/lib/cn';

type StepId = Onboarding['steps'][number]['id'];

const STEPS: Record<StepId, { title: string; text: string; icon: typeof Building2 }> = {
  empresa: { title: 'Los datos de tu empresa', text: 'Razón social y RUT: van en tus boletas.', icon: Building2 },
  ventas: { title: 'Trae tus ventas', text: 'Conecta tus retailers por API o sube el reporte de órdenes.', icon: ShoppingBag },
  liquidaciones: { title: 'Sube lo que te pagaron', text: 'La liquidación del retailer: así sabemos qué te pagaron y qué te deben.', icon: Wallet },
  costos: { title: 'Ponle costo a tus productos', text: 'Con el costo calculamos cuánto ganas en cada venta.', icon: Package },
  sii: { title: 'Conecta el SII', text: 'Para emitir boletas y notas de crédito con un clic. Puedes hacerlo después.', icon: Landmark },
};

export default function WelcomePage() {
  const qc = useQueryClient();
  const ob = useQuery({ queryKey: ['onboarding'], queryFn: api.onboarding });
  const [active, setActive] = useState<StepId | null>(null);
  const [upload, setUpload] = useState<'ventas' | 'liquidacion' | null>(null);
  const mark = useMutation({
    mutationFn: ({ step, value }: { step: StepId; value: 'SALTADO' | null }) => api.markOnboarding(step, value),
    onSuccess: (d) => {
      qc.setQueryData(['onboarding'], d);
      qc.invalidateQueries({ queryKey: ['home'] });
    },
  });
  const d = ob.data;
  useEffect(() => {
    if (d && !active) setActive(d.steps.find((s) => s.status === 'PENDIENTE')?.id ?? 'empresa');
  }, [d, active]);
  if (!d) return <Loading />;
  const done = d.completed === d.total;
  const next = () => {
    const nextStep = d.steps.find((s) => s.status === 'PENDIENTE' && s.id !== active);
    setActive(nextStep?.id ?? null);
  };

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6">
      <h1 className="text-3xl font-semibold tracking-tight">{done ? '¡Todo listo!' : 'Dejemos Cuadra listo en 5 pasos'}</h1>
      <p className="mt-1 text-muted">Puedes saltarte cualquier paso y volver después. Nada se pierde.</p>
      <div className="mt-4 flex items-center gap-3">
        <Progress value={d.completed} total={d.total} />
        <span className="num shrink-0 text-sm text-muted">
          {d.completed} de {d.total}
        </span>
      </div>

      <div className="mt-8 space-y-3">
        {d.steps.map((s, i) => {
          const meta = STEPS[s.id];
          const open = active === s.id;
          const ok = s.status !== 'PENDIENTE';
          return (
            <Card key={s.id} className={cn('overflow-hidden', open && 'border-brand-200 ring-2 ring-brand-100')}>
              <button onClick={() => setActive(open ? null : s.id)} className="flex w-full items-center gap-4 p-5 text-left">
                <span className={cn('grid size-10 shrink-0 place-items-center rounded-full font-semibold', ok ? 'bg-brand-500 text-white' : 'bg-stone-100 text-muted')}>
                  {ok ? <Check className="size-5" /> : i + 1}
                </span>
                <div className="flex-1">
                  <p className="font-semibold">{meta.title}</p>
                  <p className="text-sm text-muted">{s.status === 'SALTADO' ? 'Lo saltaste · puedes hacerlo cuando quieras' : meta.text}</p>
                </div>
                <meta.icon className="size-5 text-muted" />
              </button>
              {open && (
                <div className="border-t border-line bg-stone-50/60 p-5">
                  {s.id === 'empresa' && <CompanyForm onSaved={next} />}
                  {s.id === 'ventas' && (
                    <div className="flex flex-wrap gap-3">
                      <Button onClick={() => setUpload('ventas')}>Subir reporte de ventas</Button>
                      <LinkButton href="/conexiones" variant="secondary">
                        Conectar por API
                      </LinkButton>
                    </div>
                  )}
                  {s.id === 'liquidaciones' && <Button onClick={() => setUpload('liquidacion')}>Subir liquidación</Button>}
                  {s.id === 'costos' && (
                    <LinkButton href="/productos">Ir a Productos</LinkButton>
                  )}
                  {s.id === 'sii' && <SiiForm onSaved={next} />}
                  {!ok && (
                    <button onClick={() => mark.mutate({ step: s.id, value: 'SALTADO' }, { onSuccess: next })} className="mt-4 block text-sm text-muted hover:text-ink hover:underline">
                      Saltar este paso por ahora
                    </button>
                  )}
                </div>
              )}
            </Card>
          );
        })}
      </div>
      <div className="mt-8">
        <LinkButton href="/" variant={done ? 'primary' : 'secondary'}>
          {done ? 'Ir al inicio' : 'Ir al inicio y seguir después'}
        </LinkButton>
      </div>
      {upload && (
        <UploadDialog
          kind={upload}
          onClose={() => {
            setUpload(null);
            qc.invalidateQueries({ queryKey: ['onboarding'] });
          }}
        />
      )}
    </div>
  );
}
