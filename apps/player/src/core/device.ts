export async function installationId(): Promise<string> {
  const key = "sg-installation-id";
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return id;
}

export async function freeStorageBytes(): Promise<number> {
  const estimate = await navigator.storage?.estimate?.();
  return Math.max(0, (estimate?.quota ?? 0) - (estimate?.usage ?? 0));
}

export function networkType(): string {
  const connection = (
    navigator as Navigator & { connection?: { effectiveType?: string } }
  ).connection;
  return connection?.effectiveType ?? (navigator.onLine ? "online" : "offline");
}

export function enterFullscreen(): void {
  document.documentElement.requestFullscreen?.().catch(() => undefined);
}
