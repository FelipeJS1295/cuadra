import { falabella } from './falabella.js';
import { mercadolibre } from './mercadolibre.js';
import { paris } from './paris.js';
import { ripley } from './ripley.js';
import type { RetailProvider } from './types.js';
import { walmart } from './walmart.js';

export const PROVIDERS: RetailProvider[] = [falabella, paris, walmart, ripley, mercadolibre];
export const providerByCode = (code: string) => PROVIDERS.find((p) => p.code === code.toUpperCase()) ?? null;
