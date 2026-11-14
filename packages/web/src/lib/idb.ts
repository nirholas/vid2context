/** A small promise wrapper over IndexedDB, enough for the app's two databases. */

export function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new DOMException('Transaction aborted', 'AbortError'));
  });
}

export function idbAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

const opened = new Map<string, Promise<IDBDatabase>>();

/** Open (and on first use create) a database. Connections are reused per name. */
export function openDb(
  name: string,
  version: number,
  upgrade: (db: IDBDatabase, tx: IDBTransaction) => void,
): Promise<IDBDatabase> {
  let p = opened.get(name);
  if (!p) {
    p = new Promise<IDBDatabase>((resolve, reject) => {
      if (!idbAvailable()) {
        reject(new DOMException('IndexedDB is not available in this browser', 'NotSupportedError'));
        return;
      }
      const req = indexedDB.open(name, version);
      req.onupgradeneeded = () => {
        if (req.transaction) upgrade(req.result, req.transaction);
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          db.close();
          opened.delete(name);
        };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new DOMException(`${name} is open in an older tab; close it and reload`, 'InvalidStateError'));
    });
    opened.set(name, p);
    p.catch(() => opened.delete(name));
  }
  return p;
}
