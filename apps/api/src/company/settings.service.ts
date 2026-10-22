import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { BASE_DB, DRIZZLE, type Database } from '../database/database.module.js';
import { tenants, tenantSettings } from '../database/schema/index.js';
import { currentTenantId } from '../database/tenant-context.js';
import { decryptSecrets, encryptSecrets, mask } from '../common/secrets.js';
import { siiRut } from '../sii/rut.js';
import { PROVIDER_NAMES, SII_PROVIDERS, type SiiProviderKind } from '../sii/providers/types.js';

/** Datos no secretos de la conexión con el SII (API Gateway) */
export interface SiiSettings {
  /** Con qué proveedor se conecta al SII (por defecto API Gateway) */
  provider?: SiiProviderKind;
  /** Nubox: URL de la API que entrega Nubox junto con las credenciales */
  nuboxUrl?: string;
  /** SimpleAPI: URL base (por si cambia) */
  simpleapiUrl?: string;
  /** RUT de la persona que entra al SII (usuario autorizado de la empresa) */
  usuarioRut?: string;
  /** Código de sucursal en eBoleta (opcional: si no, se consulta) */
  sucursal?: string;
  apigatewayUrl?: string;
}

/** Configuración de la empresa actual (datos y claves cifradas) */
@Injectable()
export class SettingsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(BASE_DB) private readonly base: Database,
  ) {}

  tenantId() {
    const id = currentTenantId();
    if (!id) throw new Error('No hay empresa en este contexto');
    return id;
  }

  async tenant() {
    const [t] = await this.base.select().from(tenants).where(eq(tenants.id, this.tenantId()));
    return t;
  }

  private async row() {
    const [r] = await this.db.select().from(tenantSettings);
    return r ?? null;
  }

  async sii() {
    const [t, r] = await Promise.all([this.tenant(), this.row()]);
    const data = ((r?.data ?? {}) as { sii?: SiiSettings }).sii ?? {};
    const secrets = decryptSecrets(r?.secrets ?? null);
    const provider: SiiProviderKind = data.provider && SII_PROVIDERS.includes(data.provider) ? data.provider : 'APIGATEWAY';
    return {
      provider,
      emisorRut: siiRut(t?.taxId),
      emisorName: t?.legalName ?? t?.name ?? null,
      usuarioRut: siiRut(data.usuarioRut),
      sucursal: data.sucursal ?? null,
      apigatewayUrl: (data.apigatewayUrl || 'https://app.apigateway.cl/api/v2').replace(/\/+$/, ''),
      token: secrets.apigatewayToken ?? null,
      clave: secrets.siiClave ?? null,
      simpleapiUrl: (data.simpleapiUrl || 'https://servicios.simpleapi.cl/api').replace(/\/+$/, ''),
      simpleapiKey: secrets.simpleapiKey ?? null,
      nuboxUrl: (data.nuboxUrl || 'https://api.pyme.nubox.com/nbxpymapi-environment-pyme').replace(/\/+$/, '').replace(/\/v1$/, ''),
      nuboxToken: secrets.nuboxToken ?? null,
      nuboxApiKey: secrets.nuboxApiKey ?? null,
    };
  }

  /** Qué datos faltan para usar el proveedor elegido */
  siiMissing(s: Awaited<ReturnType<SettingsService['sii']>>): string[] {
    const need: [unknown, string][] =
      s.provider === 'APIGATEWAY'
        ? [
            [s.token, 'Token de API Gateway'],
            [s.emisorRut, 'RUT de la empresa'],
            [s.usuarioRut, 'RUT de la persona que entra al SII'],
            [s.clave, 'Clave del SII'],
          ]
        : s.provider === 'SIMPLEAPI'
          ? [
              [s.simpleapiKey, 'API Key de SimpleAPI'],
              [s.emisorRut, 'RUT de la empresa'],
              [s.usuarioRut, 'RUT de la persona que entra al SII'],
              [s.clave, 'Clave del SII'],
            ]
          : [
              [s.nuboxToken, 'Token de partner de Nubox'],
              [s.nuboxApiKey, 'API Key de la empresa en Nubox'],
            ];
    return need.filter(([v]) => !v).map(([, label]) => label);
  }

  /** Lo que se puede mostrar en pantalla (claves enmascaradas) */
  async siiPublic() {
    const s = await this.sii();
    return {
      provider: s.provider,
      providerName: PROVIDER_NAMES[s.provider],
      simpleapiKey: mask(s.simpleapiKey ?? undefined),
      nuboxUrl: s.nuboxUrl,
      nuboxToken: mask(s.nuboxToken ?? undefined),
      nuboxApiKey: mask(s.nuboxApiKey ?? undefined),
      emisorRut: s.emisorRut,
      usuarioRut: s.usuarioRut,
      sucursal: s.sucursal,
      apigatewayUrl: s.apigatewayUrl,
      token: mask(s.token ?? undefined),
      clave: s.clave ? '••••••' : null,
      configured: this.siiMissing(s).length === 0,
      missing: this.siiMissing(s),
    };
  }

  async saveSii(input: {
    provider?: SiiProviderKind | null;
    usuarioRut?: string | null;
    sucursal?: string | null;
    apigatewayUrl?: string | null;
    token?: string | null;
    clave?: string | null;
    simpleapiKey?: string | null;
    nuboxUrl?: string | null;
    nuboxToken?: string | null;
    nuboxApiKey?: string | null;
  }) {
    const r = await this.row();
    const data = (r?.data ?? {}) as Record<string, unknown>;
    const sii = { ...((data.sii ?? {}) as SiiSettings) };
    if (input.usuarioRut !== undefined) sii.usuarioRut = siiRut(input.usuarioRut) ?? undefined;
    if (input.sucursal !== undefined) sii.sucursal = input.sucursal || undefined;
    if (input.apigatewayUrl !== undefined) sii.apigatewayUrl = input.apigatewayUrl || undefined;
    if (input.provider) sii.provider = input.provider;
    if (input.nuboxUrl !== undefined) sii.nuboxUrl = input.nuboxUrl || undefined;
    const secrets = decryptSecrets(r?.secrets ?? null);
    if (input.token) secrets.apigatewayToken = input.token.trim();
    if (input.clave) secrets.siiClave = input.clave;
    if (input.simpleapiKey) secrets.simpleapiKey = input.simpleapiKey.trim();
    if (input.nuboxToken) secrets.nuboxToken = input.nuboxToken.trim().replace(/^Bearer\s+/i, '');
    if (input.nuboxApiKey) secrets.nuboxApiKey = input.nuboxApiKey.trim();
    const values = { data: { ...data, sii }, secrets: encryptSecrets(secrets) };
    await this.db.insert(tenantSettings).values(values).onConflictDoUpdate({ target: tenantSettings.tenantId, set: values });
  }

  async company() {
    const t = await this.tenant();
    return { id: t.id, name: t.name, legalName: t.legalName, taxId: t.taxId, plan: t.plan, status: t.status, trialEndsAt: t.trialEndsAt, onboarding: t.onboarding as Record<string, string> };
  }

  async saveCompany(input: { name?: string; legalName?: string | null; taxId?: string | null }) {
    await this.base
      .update(tenants)
      .set({
        ...(input.name ? { name: input.name } : {}),
        ...(input.legalName !== undefined ? { legalName: input.legalName } : {}),
        ...(input.taxId !== undefined ? { taxId: siiRut(input.taxId) } : {}),
      })
      .where(eq(tenants.id, this.tenantId()));
  }

  /** Marca un paso del asistente de inicio como hecho o saltado */
  async markOnboarding(step: string, value: 'HECHO' | 'SALTADO' | null) {
    const t = await this.tenant();
    const onboarding = { ...(t.onboarding as Record<string, string>) };
    if (value) onboarding[step] = value;
    else delete onboarding[step];
    await this.base.update(tenants).set({ onboarding }).where(eq(tenants.id, t.id));
  }
}
