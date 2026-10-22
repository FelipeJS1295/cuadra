'use client';

import { useQuery } from '@tanstack/react-query';
import { createContext, useContext, type ReactNode } from 'react';
import { api, type SessionUser } from '@/lib/api';

interface SessionCtx {
  user: SessionUser;
  /** Puede crear y cambiar cosas (no es solo lectura) */
  canEdit: boolean;
  /** Dueño o administrador de la empresa */
  isAdmin: boolean;
}

const Ctx = createContext<SessionCtx | null>(null);

export function useSession() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession fuera de SessionProvider');
  return v;
}

export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: api.me, staleTime: 60_000, retry: false });
}

export function SessionProvider({ user, children }: { user: SessionUser; children: ReactNode }) {
  const value: SessionCtx = {
    user,
    canEdit: user.role !== 'LECTURA',
    isAdmin: user.role === 'DUENO' || user.role === 'ADMIN',
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
