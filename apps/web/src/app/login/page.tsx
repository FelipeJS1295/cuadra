'use client';

import { useMutation } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { AuthLayout } from '@/components/auth-layout';
import { Button, ErrorBox, Field, inputCls } from '@/components/ui';
import { api } from '@/lib/api';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const login = useMutation({ mutationFn: () => api.login(email, password), onSuccess: () => (window.location.href = '/') });
  return (
    <AuthLayout>
      <h1 className="display text-[1.75rem] font-semibold">Entra a Cuadra</h1>
      <p className="mt-1.5 text-muted">Con el correo y la contraseña de tu cuenta.</p>
      <form
        className="mt-8 space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          login.mutate();
        }}
      >
        <Field label="Correo">
          <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} autoFocus />
        </Field>
        <Field label="Contraseña">
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className={inputCls} />
        </Field>
        <ErrorBox error={login.error} />
        <Button type="submit" size="lg" className="w-full" loading={login.isPending} disabled={!email || !password}>
          Entrar
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-muted">
        ¿No tienes cuenta?{' '}
        <Link href="/registro" className="font-medium text-brand-700 hover:underline">
          Crea una gratis
        </Link>
      </p>
    </AuthLayout>
  );
}
