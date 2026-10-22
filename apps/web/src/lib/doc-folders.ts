/**
 * Guardar documentos directo en carpetas de Windows (Chrome / Edge).
 *
 * Usa la "File System Access API": la primera vez el usuario elige la carpeta base
 * (ej: Documentos) y el navegador la recuerda. Dentro se crean solas las subcarpetas:
 *   Documentos\Boletas 2026\Boletas Walmart\Octubre\4782627004176.pdf
 *
 * En navegadores sin esta función (Firefox, celular) se descarga cada archivo con
 * la ruta en el nombre: "Boletas 2026 - Walmart - Octubre - 4782627004176.pdf".
 */

const MONTHS = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

// Tipos mínimos (TypeScript aún no trae todos los de esta API)
type PermissionMode = { mode: 'readwrite' };
type DirHandle = FileSystemDirectoryHandle & {
  queryPermission?: (d: PermissionMode) => Promise<PermissionState>;
  requestPermission?: (d: PermissionMode) => Promise<PermissionState>;
};
type PickerWindow = Window & {
  showDirectoryPicker?: (o?: { id?: string; mode?: 'readwrite'; startIn?: string }) => Promise<DirHandle>;
};

/** ¿El navegador puede guardar directo en carpetas? (Chrome y Edge de escritorio) */
export const canSaveToFolders = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window;

/** Carpetas de un documento según su fecha y retailer */
export function documentFolders(kind: string, retailer: string, date: string | null): string[] {
  const d = date ?? new Date().toISOString().slice(0, 10);
  const [year, month] = d.split('-').map(Number);
  return [`${kind} ${year}`, `${kind} ${retailer}`, MONTHS[month - 1]];
}

/** Nombre de archivo sin caracteres que Windows no acepta */
export const safeFileName = (name: string) => name.replace(/[\\/:*?"<>|]+/g, '_').trim();

// ---------- Recordar la carpeta elegida (IndexedDB guarda el "handle") ----------

const DB_NAME = 'erp-carpetas';
const STORE = 'handles';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idb<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = run(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  });
}

const KEY = 'base';

/** Carpeta base guardada (sin pedir nada al usuario). null si nunca se eligió */
export async function savedBaseFolder(): Promise<DirHandle | null> {
  if (!canSaveToFolders()) return null;
  try {
    return (await idb<DirHandle | undefined>('readonly', (s) => s.get(KEY))) ?? null;
  } catch {
    return null;
  }
}

/** Elegir (o cambiar) la carpeta base. Debe llamarse desde un clic */
export async function chooseBaseFolder(): Promise<DirHandle> {
  const handle = await (window as PickerWindow).showDirectoryPicker!({ id: 'documentos-erp', mode: 'readwrite', startIn: 'documents' });
  await idb('readwrite', (s) => s.put(handle, KEY));
  return handle;
}

/**
 * Carpeta base lista para escribir: usa la guardada (pidiendo permiso si hace falta)
 * o pide elegir una. Debe llamarse directo desde un clic (el navegador lo exige).
 */
export async function getBaseFolder(): Promise<DirHandle> {
  const saved = await savedBaseFolder();
  if (saved) {
    const opts: PermissionMode = { mode: 'readwrite' };
    if ((await saved.queryPermission?.(opts)) === 'granted') return saved;
    if ((await saved.requestPermission?.(opts)) === 'granted') return saved;
  }
  return chooseBaseFolder();
}

/** Guarda un archivo dentro de base/carpeta1/carpeta2/…, creando las carpetas que falten */
export async function saveInFolders(base: DirHandle, folders: string[], fileName: string, data: Blob) {
  let dir: FileSystemDirectoryHandle = base;
  for (const name of folders) dir = await dir.getDirectoryHandle(safeFileName(name), { create: true });
  const file = await dir.getFileHandle(safeFileName(fileName), { create: true });
  const writable = await file.createWritable();
  await writable.write(data);
  await writable.close();
}

/** Plan B (sin acceso a carpetas): descarga normal con la ruta en el nombre */
export function downloadWithPathName(folders: string[], fileName: string, data: Blob) {
  // ["Boletas 2026", "Boletas Walmart", "Octubre"] -> "Boletas 2026 - Walmart - Octubre - 123.pdf"
  if (folders.length === 0) return triggerDownload(safeFileName(fileName), data);
  const [first = '', ...rest] = folders;
  const kind = first.split(' ')[0];
  const name = safeFileName([first, ...rest.map((f) => f.replace(new RegExp(`^${kind} `), '')), fileName].join(' - '));
  triggerDownload(name, data);
}

function triggerDownload(name: string, data: Blob) {
  const url = URL.createObjectURL(data);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
