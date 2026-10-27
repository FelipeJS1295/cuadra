'use client';

import { CameraOff, Loader2, ScanText } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

type Controls = { stop: () => void };

/** Lector de texto (OCR) en el navegador, con sus archivos servidos por Cuadra (/ocr) */
type OcrWorker = { recognize: (img: HTMLCanvasElement) => Promise<{ data: { text: string } }>; terminate: () => Promise<unknown> };
let ocrWorker: Promise<OcrWorker> | null = null;
function getOcr() {
  ocrWorker ??= import('tesseract.js').then(async ({ createWorker, PSM }) => {
    const w = await createWorker('eng', 1, { workerPath: '/ocr/worker.min.js', corePath: '/ocr', langPath: '/ocr', gzip: true });
    await w.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
    return w as unknown as OcrWorker;
  });
  ocrWorker.catch(() => (ocrWorker = null));
  return ocrWorker;
}

/** Lee el texto de una foto (OCR en el teléfono) */
export async function readTextFrom(frame: HTMLCanvasElement) {
  const { data } = await (await getOcr()).recognize(frame);
  return data.text;
}

/** Foto del cuadro actual de la cámara, en grises y con más contraste (el OCR lee mejor) */
function snapshot(v: HTMLVideoElement) {
  const c = document.createElement('canvas');
  c.width = v.videoWidth;
  c.height = v.videoHeight;
  const ctx = c.getContext('2d')!;
  ctx.filter = 'grayscale(1) contrast(1.4)';
  ctx.drawImage(v, 0, 0);
  return c;
}

/**
 * Lee códigos de barras y QR con la cámara trasera del teléfono (ZXing: funciona también en
 * iPhone). Al leer uno, vibra, se detiene y entrega el texto.
 * "Leer número" saca una foto y lee los números impresos (OCR), para etiquetas cuyo código de
 * barras no es el de la orden (ej. devoluciones de Walmart: la OC va en "REFERENCIA").
 * La cámara solo funciona en https (o en localhost).
 */
export function BarcodeScanner({
  onCode,
  onText,
}: {
  /** Código leído y la foto de ese momento (para leer los números si el código no es de una orden) */
  onCode: (code: string, frame: HTMLCanvasElement | null) => void;
  onText?: (text: string) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const done = useRef(false);
  const stopRef = useRef<() => void>(() => undefined);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(true);
  const [reading, setReading] = useState(false);

  // Precarga el lector de texto mientras la cámara está abierta
  useEffect(() => {
    if (onText) void getOcr().catch(() => undefined);
  }, [onText]);

  async function readText() {
    const v = video.current;
    if (!v?.videoWidth || reading) return;
    setReading(true);
    try {
      const text = await readTextFrom(snapshot(v));
      if (done.current) return;
      done.current = true;
      navigator.vibrate?.(120);
      stopRef.current();
      onText!(text);
    } catch (err) {
      setError(`No se pudo leer el texto: ${(err as Error).message}`);
    } finally {
      setReading(false);
    }
  }

  useEffect(() => {
    let controls: Controls | null = null;
    let cancelled = false;
    done.current = false;
    (async () => {
      if (typeof window !== 'undefined' && !window.isSecureContext) {
        setError('La cámara solo funciona con una conexión segura (https). Abre Cuadra desde erp.budly.cl.');
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('Este navegador no permite usar la cámara. Prueba con Chrome o Safari.');
        return;
      }
      try {
        const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([import('@zxing/browser'), import('@zxing/library')]);
        const hints = new Map();
        hints.set(DecodeHintType.POSSIBLE_FORMATS, [
          BarcodeFormat.CODE_128,
          BarcodeFormat.CODE_39,
          BarcodeFormat.CODE_93,
          BarcodeFormat.EAN_13,
          BarcodeFormat.EAN_8,
          BarcodeFormat.UPC_A,
          BarcodeFormat.ITF,
          BarcodeFormat.CODABAR,
          BarcodeFormat.QR_CODE,
          BarcodeFormat.DATA_MATRIX,
          BarcodeFormat.PDF_417,
        ]);
        hints.set(DecodeHintType.TRY_HARDER, true);
        const reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 120 });
        if (cancelled || !video.current) return;
        controls = await reader.decodeFromConstraints(
          { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } },
          video.current,
          (result) => {
            if (!result || done.current) return;
            done.current = true;
            navigator.vibrate?.(120);
            const frame = video.current?.videoWidth ? snapshot(video.current) : null;
            controls?.stop();
            onCode(result.getText().trim(), frame);
          },
        );
        if (cancelled) controls.stop();
        stopRef.current = () => controls?.stop();
        setStarting(false);
      } catch (err) {
        const name = (err as { name?: string }).name;
        setError(
          name === 'NotAllowedError'
            ? 'No diste permiso para usar la cámara. Actívalo en la configuración del navegador (ícono del candado junto a la dirección).'
            : name === 'NotFoundError'
              ? 'No se encontró una cámara en este equipo.'
              : `No se pudo abrir la cámara: ${(err as Error).message}`,
        );
      }
    })();
    return () => {
      cancelled = true;
      controls?.stop();
    };
  }, [onCode]);

  if (error)
    return (
      <div className="flex flex-col items-center gap-2 rounded-2xl border border-berry-100 bg-berry-50 px-4 py-6 text-center text-sm text-berry-700">
        <CameraOff className="size-6" />
        {error}
      </div>
    );

  return (
    <div className="relative overflow-hidden rounded-2xl bg-graphite-900">
      <video ref={video} className="aspect-[4/3] w-full object-cover" muted playsInline />
      {/* Guía para apuntar */}
      <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="relative h-[38%] w-[78%] rounded-xl border-2 border-white/85 shadow-[0_0_0_9999px_rgba(15,20,30,0.35)]">
          <span className="absolute inset-x-2 top-1/2 h-0.5 animate-pulse rounded-full bg-berry-500/90" />
        </div>
      </div>
      <p className="absolute inset-x-0 top-3 text-center text-xs font-medium text-white/90">Apunta al código de barras de la etiqueta</p>
      {onText && !starting && (
        <button
          type="button"
          onClick={readText}
          disabled={reading}
          className="absolute inset-x-6 bottom-3 flex items-center justify-center gap-2 rounded-xl bg-white/95 px-3 py-2.5 text-sm font-semibold text-ink shadow-lg active:scale-[0.98] disabled:opacity-80"
        >
          {reading ? <Loader2 className="size-4 animate-spin" /> : <ScanText className="size-4" />}
          {reading ? 'Leyendo números…' : 'Leer número de la etiqueta'}
        </button>
      )}
      {starting && (
        <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-white/80">
          <Loader2 className="size-4 animate-spin" /> Abriendo la cámara…
        </div>
      )}
    </div>
  );
}
