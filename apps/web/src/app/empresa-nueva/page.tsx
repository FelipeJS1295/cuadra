'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Card, ErrorBox, Field, inputCls, Page } from '@/components/ui';
import { api } from '@/lib/api';

export default function NewCompanyPage() {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [taxId, setTaxId] = useState('');
  const create = useMutation({
    mutationFn: () => api.createTenant(name, taxId || undefined),
    onSuccess: () => {
      qc.clear();
      window.location.href = '/bienvenida';
    },
  });
  return (
    <Page title="Agregar una empresa" intro="Cada empresa tiene sus propias ventas, boletas y claves. Puedes cambiar entre ellas arriba a la izquierda.">
      <Card className="max-w-lg p-6">
        <div className="space-y-4">
          <Field label="Nombre de la empresa">
            <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} autoFocus />
          </Field>
          <Field label="RUT (opcional)">
            <input value={taxId} onChange={(e) => setTaxId(e.target.value)} placeholder="76.123.456-7" className={inputCls} />
          </Field>
          <ErrorBox error={create.error} />
          <Button onClick={() => create.mutate()} loading={create.isPending} disabled={name.trim().length < 2}>
            Crear empresa
          </Button>
        </div>
      </Card>
    </Page>
  );
}
