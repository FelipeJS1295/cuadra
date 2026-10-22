import { BadGatewayException, BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../database/database.module.js';
import { dispatchGuides } from '../database/schema/index.js';
import { ApiGatewayClient, SiiRejectedError, SiiUnknownError } from './api-gateway.client.js';
import { siiRut } from './rut.js';

const cut = (text: string, max: number) => text.replace(/\s+/g, ' ').trim().slice(0, max);

export interface GuideInput {
  guideDate: string;
  transferType: number;
  receptorRut: string;
  receptorName: string;
  receptorActivity: string | null;
  address: string | null;
  commune: string | null;
  items: { name: string; quantity: number; price: number }[];
  reference: string | null;
  notes: string | null;
}

/** Motivos de traslado del SII (IndTraslado) */
export const TRANSFER_TYPES: Record<number, string> = {
  1: 'Venta',
  2: 'Venta por efectuar',
  3: 'Consignación',
  5: 'Traslado interno',
  6: 'Otros traslados (no venta)',
  7: 'Guía de devolución',
};

/** Guías de despacho (52): se arman como borrador en el Portal MIPYME y se firman allá */
@Injectable()
export class GuidesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly gateway: ApiGatewayClient,
  ) {}

  async list() {
    const rows = await this.db.select().from(dispatchGuides).orderBy(desc(dispatchGuides.guideDate), desc(dispatchGuides.createdAt));
    return rows.map((g) => ({
      id: g.id,
      guideDate: g.guideDate,
      transferType: g.transferType,
      transferLabel: TRANSFER_TYPES[g.transferType] ?? String(g.transferType),
      receptorRut: g.receptorRut,
      receptorName: g.receptorName,
      receptorActivity: g.receptorActivity,
      address: g.address,
      commune: g.commune,
      items: g.items as GuideInput['items'],
      totalGross: Math.round(Number(g.totalGross)),
      reference: g.reference,
      status: g.status,
      draftCode: g.draftCode,
      folio: g.folio,
      issuedAt: g.issuedAt,
      hasPdf: Boolean(g.mipymeCode),
      notes: g.notes,
    }));
  }

  async create(input: GuideInput, userId: string | null) {
    const rut = siiRut(input.receptorRut);
    if (!rut) throw new BadRequestException('RUT del destinatario inválido');
    if (!TRANSFER_TYPES[input.transferType]) throw new BadRequestException('Motivo de traslado inválido');
    const total = input.items.reduce((n, i) => n + Math.round(i.price) * i.quantity, 0);
    const { rut: emisor } = await this.gateway.config();
    const dte = {
      Encabezado: {
        IdDoc: { TipoDTE: 52, FchEmis: input.guideDate, IndTraslado: input.transferType, ...(total > 0 ? { MntBruto: 1 } : {}) },
        Emisor: { RUTEmisor: emisor },
        Receptor: {
          RUTRecep: rut,
          RznSocRecep: cut(input.receptorName, 100),
          ...(input.receptorActivity ? { GiroRecep: cut(input.receptorActivity, 40) } : {}),
          ...(input.address ? { DirRecep: cut(input.address, 70) } : {}),
          ...(input.commune ? { CmnaRecep: cut(input.commune, 20) } : {}),
        },
      },
      Detalle: input.items.map((i) => ({
        NmbItem: cut(i.name, 80),
        QtyItem: i.quantity,
        ...(i.price > 0 ? { PrcItem: Math.round(i.price) } : {}),
      })),
    };
    let draft: { draftCode: string; raw: unknown };
    try {
      draft = await this.gateway.crearBorrador(dte);
    } catch (err) {
      if (err instanceof SiiRejectedError || err instanceof SiiUnknownError) {
        throw new BadGatewayException(`El Portal MIPYME rechazó la guía: ${err.message}`);
      }
      throw err;
    }
    const [row] = await this.db
      .insert(dispatchGuides)
      .values({
        guideDate: input.guideDate,
        transferType: input.transferType,
        receptorRut: rut,
        receptorName: input.receptorName,
        receptorActivity: input.receptorActivity,
        address: input.address,
        commune: input.commune,
        items: input.items,
        totalGross: String(total),
        reference: input.reference,
        notes: input.notes,
        status: 'BORRADOR',
        draftCode: draft.draftCode,
        siiResponse: draft.raw,
        createdBy: userId,
      })
      .returning({ id: dispatchGuides.id });
    return { id: row.id, draftCode: draft.draftCode };
  }

  /** Anotar a mano el folio (si no se encontró sola al revisar el portal) */
  async confirm(id: string, folio: string, issuedAt: string) {
    const [row] = await this.db
      .update(dispatchGuides)
      .set({ status: 'EMITIDA', folio, issuedAt })
      .where(eq(dispatchGuides.id, id))
      .returning({ id: dispatchGuides.id });
    if (!row) throw new NotFoundException('La guía no existe');
    return { ok: true };
  }

  async remove(id: string) {
    const [g] = await this.db.select().from(dispatchGuides).where(eq(dispatchGuides.id, id));
    if (!g) throw new NotFoundException('La guía no existe');
    if (g.status === 'EMITIDA') throw new BadRequestException(`La guía N° ${g.folio} ya está emitida en el SII: no se puede quitar`);
    let portal: 'ELIMINADO' | 'NO_SE_PUDO' | null = null;
    if (g.draftCode) {
      portal = 'ELIMINADO';
      await this.gateway.eliminarBorrador(g.draftCode).catch(() => (portal = 'NO_SE_PUDO'));
    }
    await this.db.delete(dispatchGuides).where(eq(dispatchGuides.id, id));
    return { deleted: true, portal };
  }
}
