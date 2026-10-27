'use client';

import { useMutation } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { AuthLayout } from '@/components/auth-layout';
import { Button, ErrorBox, Field, inputCls } from '@/components/ui';
import { api } from '@/lib/api';

export default function SignupPage() {
  const [f, setF] = useState({ name: '', email: '', password: '', companyName: '', taxId: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const signup = useMutation({
    mutationFn: () => api.signup({ ...f, taxId: f.taxId || undefined }),
    onSuccess: () => (window.location.href = '/bienvenida'),
  });
  return (
    <AuthLayout>
      <h1 className="display text-[1.75rem] font-semibold">Crea tu cuenta</h1>
      <p className="mt-1 text-muted">14 días gratis. Sin tarjeta.</p>
      <form
        className="mt-8 space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          signup.mutate();
        }}
      >
        <Field label="Tu nombre">
          <input value={f.name} onChange={set('name')} className={inputCls} autoFocus />
        </Field>
        <Field label="Correo">
          <input type="email" value={f.email} onChange={set('email')} className={inputCls} />
        </Field>
        <Field label="Contraseña" hint="Mínimo 8 caracteres">
          <input type="password" autoComplete="new-password" value={f.password} onChange={set('password')} className={inputCls} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nombre de tu empresa">
            <input value={f.companyName} onChange={set('companyName')} placeholder="Ej: Muebles del Sur" className={inputCls} />
          </Field>
          <Field label="RUT de la empresa" hint="Opcional por ahora">
            <input value={f.taxId} onChange={set('taxId')} placeholder="76.123.456-7" className={inputCls} />
          </Field>
        </div>
        <ErrorBox error={signup.error} />
        <Button type="submit" size="lg" className="w-full" loading={signup.isPending} disabled={!f.name || !f.email || f.password.length < 8 || !f.companyName}>
          Crear mi cuenta
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-muted">
        ¿Ya tienes cuenta?{' '}
        <Link href="/login" className="font-medium text-brand-700 hover:underline">
          Entra aquí
        </Link>
      </p>
    </AuthLayout>
  );
}
