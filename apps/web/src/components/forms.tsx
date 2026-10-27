'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CheckCircle2, ExternalLink, Factory, ShoppingCart, X, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type BusinessMode, type SiiProvider } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useSession } from './session';
import { Button, ErrorBox, Field, inputCls, Loading, Pill } from './ui';

/** Datos de la empresa (van en boletas y facturas) */
export function CompanyForm({ onSaved }: { onSaved?: () => void }) {
  const qc = useQueryClient();
  const { isAdmin } = useSession();
  const company = useQuery({ queryKey: ['company'], queryFn: api.company });
  const [f, setF] = useState({ name: '', legalName: '', taxId: '' });
  useEffect(() => {
    if (company.data) setF({ name: company.data.name, legalName: company.data.legalName ?? '', taxId: company.data.taxId ?? '' });
  }, [company.data]);
  const save = useMutation({
    mutationFn: () => api.saveCompany({ name: f.name, legalName: f.legalName || null, taxId: f.taxId || null }),
    onSuccess: () => {
      for (const k of ['company', 'me', 'onboarding']) qc.invalidateQueries({ queryKey: [k] });
      onSaved?.();
    },
  });
  if (company.isLoading) return <Loading />;
  return (
    <div className="space-y-6">
      {company.data && <BusinessModePicker current={company.data.businessMode} />}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Nombre de fantasía">
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} disabled={!isAdmin} className={inputCls} />
        </Field>
        <Field label="RUT de la empresa">
          <input value={f.taxId} onChange={(e) => setF({ ...f, taxId: e.target.value })} placeholder="76.123.456-7" disabled={!isAdmin} className={inputCls} />
        </Field>
        <Field label="Razón social" className="sm:col-span-2">
          <input value={f.legalName} onChange={(e) => setF({ ...f, legalName: e.target.value })} placeholder="Muebles del Sur SpA" disabled={!isAdmin} className={inputCls} />
        </Field>
      </div>
      <ErrorBox error={save.error} />
      {isAdmin && (
        <div className="flex items-center gap-3">
          <Button onClick={() => save.mutate()} loading={save.isPending}>
            Guardar
          </Button>
          {save.isSuccess && <span className="text-sm text-money-700">Guardado</span>}
        </div>
      )}
    </div>
  );
}

const MODES: { id: BusinessMode; title: string; icon: typeof Factory; text: string; points: string[] }[] = [
  {
    id: 'REVENDEDOR',
    title: 'Revendedor',
    icon: ShoppingCart,
    text: 'Compras productos a proveedores y los vendes en los retailers.',
    points: ['El costo de cada venta sale de la factura del proveedor', 'En Compras asignas cada factura a las ventas que cubre'],
  },
  {
    id: 'FABRICANTE',
    title: 'Fabricante',
    icon: Factory,
    text: 'Fabricas lo que vendes y se lo vendes directo a los retailers.',
    points: ['El costo sale de los insumos de cada producto (su receta)', 'Las ventas no esperan factura de proveedor'],
  },
];

/** Revendedor o fabricante: cambia de dónde sale el costo de cada venta */
function BusinessModePicker({ current }: { current: BusinessMode }) {
  const qc = useQueryClient();
  const { isAdmin } = useSession();
  const save = useMutation({
    mutationFn: (businessMode: BusinessMode) => api.saveCompany({ businessMode }),
    onSuccess: () => {
      for (const k of ['company', 'me', 'sales', 'home', 'products', 'onboarding']) qc.invalidateQueries({ queryKey: [k] });
    },
  });
  return (
    <div>
      <p className="mb-2 text-sm font-medium">¿Cómo trabaja tu empresa?</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {MODES.map((m) => {
          const active = (save.isPending ? save.variables : current) === m.id;
          const Icon = m.icon;
          return (
            <button
              key={m.id}
              type="button"
              disabled={!isAdmin || save.isPending}
              onClick={() => m.id !== current && save.mutate(m.id)}
              className={cn(
                'rounded-2xl border bg-white p-4 text-left transition',
                active ? 'border-brand-500 ring-2 ring-brand-500/20' : 'border-line hover:border-ink/20',
                !isAdmin && 'cursor-default',
              )}
            >
              <div className="flex items-center gap-2">
                <span className={cn('grid size-9 place-items-center rounded-full', active ? 'bg-brand-50 text-brand-600' : 'bg-stone-100 text-stone-500')}>
                  <Icon className="size-5" />
                </span>
                <span className="font-semibold">{m.title}</span>
                {active && <Pill tone="verde">{save.isPending ? 'Guardando…' : 'Tu modalidad'}</Pill>}
              </div>
              <p className="mt-2 text-sm text-muted">{m.text}</p>
              <ul className="mt-2 space-y-1 text-[13px]">
                {m.points.map((p) => (
                  <li key={p} className="flex gap-1.5">
                    <Check className="mt-0.5 size-3.5 shrink-0 text-brand-600" /> {p}
                  </li>
                ))}
              </ul>
            </button>
          );
        })}
      </div>
      <ErrorBox error={save.error} />
    </div>
  );
}

type SiiFields = {
  usuarioRut: string;
  sucursal: string;
  token: string;
  clave: string;
  simpleapiKey: string;
  nuboxUrl: string;
  nuboxToken: string;
  nuboxApiKey: string;
  nuboxUser: string;
  nuboxSerie: string;
  nuboxPassword: string;
};

/** Los proveedores con que Cuadra se conecta al SII y lo que permite cada uno */
const PROVIDERS: {
  id: SiiProvider;
  name: string;
  site: string;
  pitch: string;
  can: [string, boolean][];
}[] = [
  {
    id: 'APIGATEWAY',
    name: 'API Gateway',
    site: 'https://www.apigateway.cl',
    pitch: 'Lo más completo. Entra al SII con tu RUT y clave.',
    can: [
      ['Emitir boletas', true],
      ['Notas de crédito (se firman en el SII)', true],
      ['Traer facturas de proveedores', true],
      ['Comparar tus ventas con el SII', true],
      ['Facturas y guías de despacho', true],
    ],
  },
  {
    id: 'SIMPLEAPI',
    name: 'SimpleAPI',
    site: 'https://www.simpleapi.cl',
    pitch: 'Económico. Solo lee el Registro de Compras y Ventas.',
    can: [
      ['Emitir boletas', false],
      ['Notas de crédito', false],
      ['Traer facturas de proveedores', true],
      ['Comparar tus ventas con el SII', true],
      ['Facturas y guías de despacho', false],
    ],
  },
  {
    id: 'NUBOX_CLASICO',
    name: 'Nubox (usuario API)',
    site: 'https://www.nubox.com',
    pitch: 'Para planes de Nubox sin API de Integraciones. Entra con el usuario API.',
    can: [
      ['Emitir boletas', true],
      ['Notas de crédito (quedan emitidas)', true],
      ['Traer compras del SII (con tu clave)', true],
      ['Comparar ventas con el SII (con tu clave)', true],
      ['Emitir facturas (quedan emitidas)', true],
      ['Guías de despacho', false],
    ],
  },
  {
    id: 'NUBOX',
    name: 'Nubox',
    site: 'https://www.nubox.com',
    pitch: 'Nubox con API de Integraciones (token y API key). Emite y compara ventas.',
    can: [
      ['Emitir boletas', true],
      ['Notas de crédito (quedan emitidas)', true],
      ['Traer compras del SII (con tu clave)', true],
      ['Comparar tus ventas con el SII', true],
      ['Emitir facturas (quedan emitidas)', true],
      ['Guías de despacho', false],
    ],
  },
];

/** Conexión con el SII: el cliente elige API Gateway, SimpleAPI o Nubox */
export function SiiForm({ onSaved }: { onSaved?: () => void }) {
  const qc = useQueryClient();
  const { isAdmin, canEdit } = useSession();
  const cfg = useQuery({ queryKey: ['sii-config'], queryFn: api.siiConfig });
  const [provider, setProvider] = useState<SiiProvider>('APIGATEWAY');
  const [f, setF] = useState<SiiFields>({
    usuarioRut: '',
    sucursal: '',
    token: '',
    clave: '',
    simpleapiKey: '',
    nuboxUrl: '',
    nuboxToken: '',
    nuboxApiKey: '',
    nuboxUser: '',
    nuboxSerie: '',
    nuboxPassword: '',
  });
  useEffect(() => {
    if (!cfg.data) return;
    setProvider(cfg.data.provider);
    setF((x) => ({
      ...x,
      usuarioRut: cfg.data.usuarioRut ?? '',
      sucursal: cfg.data.sucursal ?? '',
      nuboxUrl: cfg.data.nuboxUrl ?? '',
      nuboxUser: cfg.data.nuboxUser ?? '',
      nuboxSerie: cfg.data.nuboxSerie ?? '',
    }));
  }, [cfg.data]);
  const secret = (k: keyof SiiFields) => (f[k] ? { [k]: f[k] } : {});
  const save = useMutation({
    mutationFn: () =>
      api.saveSiiConfig({
        provider,
        usuarioRut: f.usuarioRut,
        ...(provider === 'APIGATEWAY' || provider === 'NUBOX_CLASICO' ? { sucursal: f.sucursal } : {}),
        ...(provider === 'NUBOX' ? { nuboxUrl: f.nuboxUrl } : {}),
        ...(provider === 'NUBOX_CLASICO' ? { nuboxUser: f.nuboxUser, nuboxSerie: f.nuboxSerie } : {}),
        ...secret('nuboxPassword'),
        ...secret('token'),
        ...secret('clave'),
        ...secret('simpleapiKey'),
        ...secret('nuboxToken'),
        ...secret('nuboxApiKey'),
      }),
    onSuccess: () => {
      setF((x) => ({ ...x, token: '', clave: '', simpleapiKey: '', nuboxToken: '', nuboxApiKey: '', nuboxPassword: '' }));
      test.reset();
      for (const k of ['sii-config', 'sii-status', 'onboarding', 'home']) qc.invalidateQueries({ queryKey: [k] });
      onSaved?.();
    },
  });
  const test = useMutation({ mutationFn: api.testSii });
  if (cfg.isLoading) return <Loading />;
  const c = cfg.data!;
  const chosen = PROVIDERS.find((p) => p.id === provider)!;
  // Lo guardado corresponde al proveedor que se ve en pantalla
  const savedHere = c.provider === provider;
  const set = (k: keyof SiiFields) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const saved = (v: string | null, label = 'Guardado') => (v ? `${label} (${v}) · escribe para cambiarlo` : undefined);

  return (
    <div className="space-y-5">
      <div>
        <p className="mb-2 text-sm font-medium">¿Con quién te conectas al SII?</p>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {PROVIDERS.map((p) => {
            const active = p.id === provider;
            return (
              <button
                key={p.id}
                type="button"
                disabled={!isAdmin}
                onClick={() => {
                  setProvider(p.id);
                  test.reset();
                }}
                className={cn(
                  'rounded-2xl border bg-white p-4 text-left transition',
                  active ? 'border-brand-500 ring-2 ring-brand-500/20' : 'border-line hover:border-ink/20',
                  !isAdmin && 'cursor-default',
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold">{p.name}</span>
                  {c.provider === p.id && c.configured ? (
                    <Pill tone="verde">En uso</Pill>
                  ) : (
                    <span className={cn('size-4 rounded-full border-2', active ? 'border-brand-500 bg-brand-500' : 'border-line')} />
                  )}
                </div>
                <p className="mt-1 text-sm text-muted">{p.pitch}</p>
                <ul className="mt-3 space-y-1 text-[13px]">
                  {p.can.map(([label, ok]) => (
                    <li key={label} className={cn('flex items-center gap-1.5', ok ? 'text-ink' : 'text-muted line-through decoration-ink/20')}>
                      {ok ? <Check className="size-3.5 text-brand-600" /> : <X className="size-3.5 text-muted" />}
                      {label}
                    </li>
                  ))}
                </ul>
              </button>
            );
          })}
        </div>
      </div>

      <div className="rounded-xl bg-sky-50 p-4 text-sm leading-relaxed">
        {provider === 'APIGATEWAY' && (
          <>
            <p>Necesitas:</p>
            <ol className="mt-1 list-decimal space-y-0.5 pl-5">
              <li>
                Una cuenta en API Gateway con <b>Portal eBoleta</b>, <b>Portal MiPYME</b> y <b>Registro de Compra y Venta</b> activos.
              </li>
              <li>El token de conexión que te da API Gateway.</li>
              <li>Tu RUT personal y tu clave del SII (la persona que emite boletas por la empresa).</li>
            </ol>
          </>
        )}
        {provider === 'SIMPLEAPI' && (
          <>
            <p>Necesitas:</p>
            <ol className="mt-1 list-decimal space-y-0.5 pl-5">
              <li>
                Una API Key de SimpleAPI con el producto <b>SimpleAPI-RCV</b> (hay plan gratis de 500 consultas al mes).
              </li>
              <li>Tu RUT personal y tu clave del SII (alguien autorizado a ver el Registro de Compras y Ventas de la empresa).</li>
            </ol>
          </>
        )}
        {provider === 'NUBOX_CLASICO' && (
          <>
            <p>Necesitas el &quot;Usuario API&quot; de Nubox (perfil Producción):</p>
            <ol className="mt-1 list-decimal space-y-0.5 pl-5">
              <li>
                En Nubox: <b>Agregar usuario API</b> → <b>Generar usuario y contraseña</b> → <b>Guardar</b> (la contraseña no se vuelve a mostrar).
              </li>
              <li>Tu RUT personal (el funcionario que emite en Nubox) y el código de la sucursal (si tienes una sola, es 1).</li>
              <li>Prueba primero con una boleta y revísala en Nubox antes de emitir muchas.</li>
              <li>Opcional: tu clave del SII, para traer las facturas de proveedores y comparar las ventas directo del SII.</li>
            </ol>
          </>
        )}
        {provider === 'NUBOX' && (
          <>
            <p>Necesitas una cuenta de Nubox Factura y Administración. Ahí:</p>
            <ol className="mt-1 list-decimal space-y-0.5 pl-5">
              <li>
                Entra al engranaje → <b>Integraciones y API</b> → API → <b>Generar credenciales</b>.
              </li>
              <li>Copia el token (secret key) y la API key de la empresa.</li>
              <li>Si Nubox te dio una URL de la API, pégala abajo (si no, deja la que viene).</li>
            </ol>
          </>
        )}
        <a href={chosen.site} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 font-medium text-sky-700 hover:underline">
          Ir a {chosen.name} <ExternalLink className="size-3.5" />
        </a>
      </div>

      {!c.emisorRut && provider !== 'NUBOX' && <p className="rounded-xl bg-sun-50 p-3 text-sm text-sun-700">Primero completa el RUT de la empresa en “Empresa”.</p>}

      <div className="grid gap-4 sm:grid-cols-2">
        {provider === 'APIGATEWAY' && (
          <Field label="Token de API Gateway" hint={saved(c.token)}>
            <input type="password" autoComplete="new-password" value={f.token} onChange={set('token')} disabled={!isAdmin} className={inputCls} />
          </Field>
        )}
        {provider === 'SIMPLEAPI' && (
          <Field label="API Key de SimpleAPI" hint={saved(c.simpleapiKey, 'Guardada')}>
            <input type="password" autoComplete="new-password" value={f.simpleapiKey} onChange={set('simpleapiKey')} disabled={!isAdmin} className={inputCls} />
          </Field>
        )}
        {provider === 'NUBOX_CLASICO' && (
          <>
            <Field label="Usuario API de Nubox">
              <input value={f.nuboxUser} onChange={set('nuboxUser')} disabled={!isAdmin} className={inputCls} />
            </Field>
            <Field label="Contraseña del usuario API" hint={c.nuboxPassword ? 'Guardada · escribe para cambiarla' : 'Se guarda cifrada'}>
              <input type="password" autoComplete="new-password" value={f.nuboxPassword} onChange={set('nuboxPassword')} disabled={!isAdmin} className={inputCls} />
            </Field>
            <Field label="Tu RUT (el funcionario que emite en Nubox)">
              <input value={f.usuarioRut} onChange={set('usuarioRut')} placeholder="12.345.678-9" disabled={!isAdmin} className={inputCls} />
            </Field>
            <Field label="Código de sucursal" hint="Si tienes una sola sucursal en Nubox, es 1">
              <input value={f.sucursal} onChange={set('sucursal')} placeholder="1" disabled={!isAdmin} className={inputCls} />
            </Field>
            <Field label="N° de serie del sistema (opcional)" hint="Si lo dejas vacío, se toma el que entrega Nubox al conectar">
              <input value={f.nuboxSerie} onChange={set('nuboxSerie')} disabled={!isAdmin} className={inputCls} />
            </Field>
            <Field
              label="Tu clave del SII (opcional)"
              hint={c.clave ? 'Guardada · escribe para cambiarla' : 'Con tu RUT de arriba y esta clave, Cuadra trae las compras y compara las ventas directo del SII'}
            >
              <input type="password" autoComplete="new-password" value={f.clave} onChange={set('clave')} disabled={!isAdmin} className={inputCls} />
            </Field>
          </>
        )}
        {provider !== 'NUBOX' && provider !== 'NUBOX_CLASICO' && (
          <>
            <Field label="Tu RUT personal (el que usas en el SII)">
              <input value={f.usuarioRut} onChange={set('usuarioRut')} placeholder="12.345.678-9" disabled={!isAdmin} className={inputCls} />
            </Field>
            <Field label="Tu clave del SII" hint={c.clave ? 'Guardada · escribe para cambiarla' : 'Se guarda cifrada'}>
              <input type="password" autoComplete="new-password" value={f.clave} onChange={set('clave')} disabled={!isAdmin} className={inputCls} />
            </Field>
          </>
        )}
        {provider === 'APIGATEWAY' && (
          <Field label="Código de sucursal (opcional)" hint="Si lo dejas vacío, lo buscamos en el SII">
            <input value={f.sucursal} onChange={set('sucursal')} disabled={!isAdmin} className={inputCls} />
          </Field>
        )}
        {provider === 'NUBOX' && (
          <>
            <Field label="Token de Nubox (secret key)" hint={saved(c.nuboxToken)}>
              <input type="password" autoComplete="new-password" value={f.nuboxToken} onChange={set('nuboxToken')} disabled={!isAdmin} className={inputCls} />
            </Field>
            <Field label="API Key de la empresa en Nubox" hint={saved(c.nuboxApiKey, 'Guardada')}>
              <input type="password" autoComplete="new-password" value={f.nuboxApiKey} onChange={set('nuboxApiKey')} disabled={!isAdmin} className={inputCls} />
            </Field>
            <Field label="Tu RUT personal (opcional)" hint="Para traer las compras directo del SII">
              <input value={f.usuarioRut} onChange={set('usuarioRut')} placeholder="12.345.678-9" disabled={!isAdmin} className={inputCls} />
            </Field>
            <Field label="Tu clave del SII (opcional)" hint={c.clave ? 'Guardada · escribe para cambiarla' : 'Se guarda cifrada'}>
              <input type="password" autoComplete="new-password" value={f.clave} onChange={set('clave')} disabled={!isAdmin} className={inputCls} />
            </Field>
            <Field label="URL de la API de Nubox" hint="Viene lista; cámbiala solo si Nubox te dio otra" className="sm:col-span-2">
              <input value={f.nuboxUrl} onChange={set('nuboxUrl')} disabled={!isAdmin} className={inputCls} />
            </Field>
          </>
        )}
      </div>

      <ErrorBox error={save.error} />
      <div className="flex flex-wrap items-center gap-3">
        {isAdmin && (
          <Button onClick={() => save.mutate()} loading={save.isPending}>
            {savedHere ? 'Guardar' : `Usar ${chosen.name}`}
          </Button>
        )}
        {canEdit && savedHere && (
          <Button variant="secondary" onClick={() => test.mutate()} loading={test.isPending} disabled={!c.configured}>
            Probar conexión
          </Button>
        )}
        {savedHere ? (
          c.configured ? (
            <span className="text-sm text-money-700">Conectado con {c.providerName}</span>
          ) : (
            <span className="text-sm text-muted">Falta: {c.missing.join(', ')}</span>
          )
        ) : (
          <span className="text-sm text-muted">
            Hoy usas {c.providerName}. Al guardar, Cuadra pasa a usar {chosen.name}.
          </span>
        )}
      </div>
      {test.data && (
        <p className={`flex items-start gap-2 rounded-xl p-3 text-sm ${test.data.ok ? 'bg-money-50 text-money-700' : 'bg-berry-50 text-berry-700'}`}>
          {test.data.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <XCircle className="mt-0.5 size-4 shrink-0" />}
          {test.data.message}
        </p>
      )}
    </div>
  );
}
