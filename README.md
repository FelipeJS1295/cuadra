# Cuadra

Sistema para empresas que venden en retailers (Falabella, Paris, Walmart, Hites…): cuánto vendiste,
cuánto te pagaron, quién te debe, cuánto le debes a tus proveedores, tu IVA del mes y cuánto ganaste.
Hecho para varias empresas (multi-empresa / SaaS): cada cliente ve solo sus datos.

## Requisitos

- **Node.js 22** o superior → https://nodejs.org
- **pnpm 10** → `npm install -g pnpm`
- **Docker Desktop** (para la base de datos PostgreSQL) → https://www.docker.com/products/docker-desktop

## Probar en local (5 pasos)

Desde la carpeta `cuadra` (en Windows usa PowerShell o la terminal de VS Code):

```bash
# 1. Configuración: copia el ejemplo (en PowerShell: copy .env.example .env)
cp .env.example .env

# 2. Dependencias
pnpm install

# 3. Base de datos (Postgres en Docker, puerto 5450)
pnpm db:up

# 4. Crea las tablas y carga una empresa de ejemplo con datos
pnpm db:setup

# 5. Levanta la API (puerto 4200) y la web (puerto 3200)
pnpm dev
```

Abre **http://localhost:3200**

| Usuario | Correo | Contraseña | Para qué |
|---|---|---|---|
| Empresa demo | `demo@cuadra.local` | `demo12345` | "Muebles Demo SpA" con 70 ventas, liquidaciones, boletas y facturas de proveedor |
| Administrador | `admin@cuadra.local` | `admin12345` | Ve todas las empresas (ícono de escudo arriba), cambia planes, entra a cualquiera |

También puedes crear una cuenta nueva en **Crear cuenta** para ver el recorrido de bienvenida desde cero.

### Comandos útiles

| Comando | Qué hace |
|---|---|
| `pnpm dev` | API + web en modo desarrollo |
| `pnpm db:up` / `pnpm db:down` | Prende / apaga Postgres |
| `pnpm db:migrate` | Aplica migraciones nuevas |
| `pnpm seed:demo` | Vuelve a cargar la empresa demo (borra y recrea solo esa empresa) |
| `pnpm --filter @cuadra/api user:password correo@x.cl nuevaClave` | Cambia la contraseña de un usuario |

Para empezar de cero: `docker compose down -v` (borra la base) y luego `pnpm db:up` + `pnpm db:setup`.

## Qué tiene

| Sección | Qué hace |
|---|---|
| **Inicio** | Cuánto vendiste, cuánto te pagaron, cuánto te deben, cuánto ganaste y qué tareas tienes pendientes |
| **Ventas** | Órdenes de todos los retailers (por archivo o llegadas solas por API, marcadas con «API»). Al abrir una, ves paso a paso: venta → boleta → pago del retailer → factura del proveedor |
| **Cobros** | Quién te debe, cuándo te deberían pagar, y los pagos que no cuadran (comisión distinta, cobros extra) |
| **Compras** | Facturas de proveedores: cuánto debes y a qué ventas corresponden. Se pueden traer del SII |
| **Impuestos** | IVA del mes explicado simple y notas de crédito por ventas canceladas |
| **Productos** | Lo que vendes y cuánto te cuesta (con eso se calcula la ganancia) |
| **Conexiones** | SII (API Gateway, SimpleAPI o Nubox, a elección de cada empresa) y retailers por API o por archivo |
| **Configuración** | Datos de la empresa, equipo (roles Dueño / Admin / Operador / Solo lectura) |

Cada pantalla tiene un "¿Cómo funciona?" que la explica en palabras simples.

## Cómo está hecho

```
cuadra/
├── apps/
│   ├── api/                 NestJS 12 + Drizzle ORM (puerto 4200)
│   │   ├── drizzle/         Migraciones SQL (0001_rls.sql = aislamiento entre empresas)
│   │   ├── scripts/         seed-demo.mjs, reset-password.mjs
│   │   └── src/
│   │       ├── auth/        Login, registro, sesiones, roles, cambio de empresa
│   │       ├── company/     Inicio, datos de la empresa, configuración SII, bienvenida
│   │       ├── admin/       Panel del administrador (todas las empresas)
│   │       ├── database/    Conexión y contexto de empresa por petición
│   │       └── sales, settlements, purchases, accounting, sii, retail-api, …
│   └── web/                 Next.js 16 + Tailwind 4 + TanStack Query (puerto 3200)
├── packages/shared/         Tipos compartidos
└── docker-compose.yml       PostgreSQL 16
```

**Aislamiento entre empresas.** Todas las tablas de negocio tienen `tenant_id` y una política de
*Row Level Security* de PostgreSQL. En cada petición la API abre una transacción, cambia al rol
`cuadra_app` (que no puede saltarse RLS) y fija `app.tenant_id`. Así, aunque una consulta olvide
filtrar por empresa, la base de datos nunca devuelve datos de otra.

**Claves.** Las credenciales de cada empresa (SII, APIs de retailers) se guardan
cifradas con AES-256-GCM usando una llave derivada de `AUTH_SECRET`. No cambies `AUTH_SECRET`
después de guardar claves.

## Límites conocidos (versión 0.1)

- **SII:** cada empresa elige su proveedor en Configuración → SII. Qué permite cada uno:

  | | API Gateway | SimpleAPI | Nubox |
  |---|---|---|---|
  | Emitir boletas | ✓ | — | ✓ |
  | Notas de crédito | ✓ (borrador que se firma en el SII) | — | ✓ (quedan emitidas) |
  | Traer facturas de proveedores | ✓ | ✓ | — |
  | PDF y productos de facturas de proveedores | ✓ | — | — |
  | Comparar ventas con el SII | ✓ | ✓ | ✓ |

  SimpleAPI y Nubox están hechos según su documentación pública y probados contra un simulador:
  falta probarlos con credenciales reales (en Nubox, revisar en certificación los códigos de motivo
  de las notas de crédito y si la boleta debe ir con precio neto o bruto).
- **Paris por API:** las rutas no están confirmadas con documentación oficial; se pueden ajustar en la conexión. Por archivo funciona.
- **Cobro a clientes:** no hay pasarela de pago integrada; el plan y el estado de cada empresa se cambian a mano desde el panel de administrador.
- **Correos:** no se envían correos (invitar a alguien al equipo crea el usuario con una contraseña temporal que se le comparte a mano).
