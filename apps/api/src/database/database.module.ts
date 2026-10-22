import { Global, Inject, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.js';
import { tenantStore } from './tenant-context.js';

export const PG_POOL = Symbol('PG_POOL');
/** Base "de la empresa": dentro de un pedido apunta a la transacción con RLS de esa empresa */
export const DRIZZLE = Symbol('DRIZZLE');
/** Base sin empresa (login, registro, superadmin). Úsala solo para tablas globales */
export const BASE_DB = Symbol('BASE_DB');

export type Database = NodePgDatabase<typeof schema>;

/**
 * Objeto que se comporta como la base de datos, pero en cada uso toma la transacción de la
 * empresa del pedido en curso (si la hay).
 */
function tenantAwareDb(base: Database): Database {
  return new Proxy({} as Database, {
    get(_target, prop) {
      const db = (tenantStore.getStore()?.tx ?? base) as unknown as Record<string | symbol, unknown>;
      const value = db[prop];
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(db) : value;
    },
  });
}

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new pg.Pool({
          connectionString: config.get<string>('DATABASE_URL', 'postgres://cuadra:cuadra@localhost:5450/cuadra'),
          max: 20,
        }),
    },
    {
      provide: BASE_DB,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): Database => drizzle(pool, { schema }),
    },
    {
      provide: DRIZZLE,
      inject: [BASE_DB],
      useFactory: (base: Database): Database => tenantAwareDb(base),
    },
  ],
  exports: [DRIZZLE, BASE_DB],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  async onApplicationShutdown() {
    await this.pool.end();
    Logger.log('Conexiones a Postgres cerradas', 'DatabaseModule');
  }
}
