import type { Credentials, PlayerManifest, PlayerStore } from "./types";

const DATABASE = "screengoblin-player";
const STORE = "state";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function read<T>(key: string): Promise<T | undefined> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}

async function write(entries: Array<[string, unknown]>): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    for (const [key, value] of entries) tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export class IndexedDbPlayerStore implements PlayerStore {
  getCredentials = () => read<Credentials>("credentials");
  putCredentials = (value: Credentials) => write([["credentials", value]]);
  getActiveManifest = () => read<PlayerManifest>("active-manifest");
  getPreviousManifest = () => read<PlayerManifest>("previous-manifest");

  async activateManifest(value: PlayerManifest): Promise<void> {
    const active = await this.getActiveManifest();
    const entries: Array<[string, unknown]> = [["active-manifest", value]];
    // Emergency content is an overlay, never part of the normal rollback
    // chain. Repeated emergency polls must preserve the last verified normal
    // release, and returning to normal must not make a cleared alert rollbackable.
    if (active && active.priority !== "emergency")
      entries.push(["previous-manifest", active]);
    await write(entries);
  }

  async rollback(): Promise<PlayerManifest | undefined> {
    const previous = await this.getPreviousManifest();
    if (previous) await write([["active-manifest", previous]]);
    return previous;
  }

  async clear(): Promise<void> {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}
