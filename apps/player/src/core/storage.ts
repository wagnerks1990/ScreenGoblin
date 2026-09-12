import type {
  Credentials,
  PendingProofPairing,
  PlayerManifest,
  PlayerStore,
} from "./types";

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

async function remove(key: string): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export class IndexedDbPlayerStore implements PlayerStore {
  getCredentials = () => read<Credentials>("credentials");
  putCredentials = (value: Credentials) => write([["credentials", value]]);
  getPendingPairing = () => read<PendingProofPairing>("pending-pairing");
  putPendingPairing = (value: PendingProofPairing) =>
    write([["pending-pairing", value]]);
  deletePendingPairing = () => remove("pending-pairing");

  async clearProvisionedState(): Promise<void> {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const state = tx.objectStore(STORE);
      state.delete("credentials");
      state.delete("active-manifest");
      state.delete("previous-manifest");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async completePairing(value: Credentials): Promise<void> {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const state = tx.objectStore(STORE);
      state.put(value, "credentials");
      state.delete("pending-pairing");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  getActiveManifest = () => read<PlayerManifest>("active-manifest");
  getPreviousManifest = () => read<PlayerManifest>("previous-manifest");

  async activateManifest(value: PlayerManifest): Promise<void> {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const state = tx.objectStore(STORE);
      const request = state.get("active-manifest");

      request.onsuccess = () => {
        const active = request.result as PlayerManifest | undefined;
        const sameRelease = active?.version === value.version;

        // One transaction changes the active marker and rollback baseline.
        // A withdrawn marker remains active in storage so reconnect/recovery
        // cannot mistake an intentional blank screen for missing state.
        state.put(value, "active-manifest");

        // Emergency content is an overlay, never part of the normal rollback
        // chain. Blank releases also preserve, rather than replace, the last
        // playable baseline. Reissued envelopes for one semantic release may
        // refresh validity metadata without rotating rollback history.
        if (
          !sameRelease &&
          active &&
          active.priority !== "emergency" &&
          !active.withdrawn
        ) {
          state.put(active, "previous-manifest");
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async rollback(
    expectedActiveVersion?: string,
  ): Promise<PlayerManifest | undefined> {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const state = tx.objectStore(STORE);
      const activeRequest = state.get("active-manifest");
      const previousRequest = state.get("previous-manifest");
      let resultingActive: PlayerManifest | undefined;

      const apply = () => {
        const active = activeRequest.result as PlayerManifest | undefined;
        if (
          expectedActiveVersion !== undefined &&
          active?.version !== expectedActiveVersion
        ) {
          // An older error/expiry callback lost a race with a successful sync.
          resultingActive = active;
          return;
        }
        const previous = previousRequest.result as PlayerManifest | undefined;
        resultingActive = previous;
        if (previous) state.put(previous, "active-manifest");
        else state.delete("active-manifest");
      };
      const maybeApply = () => {
        if (
          activeRequest.readyState === "done" &&
          previousRequest.readyState === "done"
        )
          apply();
      };
      activeRequest.onsuccess = maybeApply;
      previousRequest.onsuccess = maybeApply;
      tx.oncomplete = () => resolve(resultingActive);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
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
