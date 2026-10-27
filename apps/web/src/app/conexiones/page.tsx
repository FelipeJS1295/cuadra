'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Loading } from '@/components/ui';

/** Las conexiones ahora están en Configuración */
export default function ConnectionsRedirect() {
  const router = useRouter();
  useEffect(() => router.replace('/configuracion?tab=conexiones'), [router]);
  return <Loading />;
}
