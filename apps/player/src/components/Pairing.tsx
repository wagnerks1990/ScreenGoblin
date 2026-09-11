import { useState } from "react";
import { PlayerApi } from "../core/api";
import type { Credentials } from "../core/types";

interface Props {
  installationId: string;
  defaultApiUrl: string;
  onPaired: (credentials: Credentials) => void;
}

export function Pairing({ installationId, defaultApiUrl, onPaired }: Props) {
  const [apiUrl, setApiUrl] = useState(defaultApiUrl);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);
  const secureServerAddress = (() => {
    try {
      const value = new URL(apiUrl);
      return (
        value.protocol === "https:" ||
        (value.protocol === "http:" &&
          ["localhost", "127.0.0.1", "::1"].includes(value.hostname))
      );
    } catch {
      return false;
    }
  })();

  const connect = async () => {
    setError(undefined);
    setWorking(true);
    try {
      onPaired(await new PlayerApi(apiUrl).pair(code, installationId));
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "This screen could not be connected",
      );
    } finally {
      setWorking(false);
    }
  };

  return (
    <main className="pairing-shell">
      <section className="pairing-card" aria-live="polite">
        <img
          className="pairing-logo"
          src="/brand/logo.png"
          alt="ScreenGoblin"
        />
        <h1>Connect this screen</h1>
        <p>
          In the ScreenGoblin console, create a pairing code under Screens, then
          enter it here.
        </p>
        <label>
          Server address
          <input
            autoFocus
            value={apiUrl}
            onChange={(event) => setApiUrl(event.target.value)}
            placeholder="https://signage.example.org"
          />
        </label>
        <label>
          Six-digit pairing code
          <input
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            value={code}
            onChange={(event) =>
              setCode(event.target.value.replace(/\D/g, "").slice(0, 6))
            }
            placeholder="000000"
          />
        </label>
        <button
          onClick={connect}
          disabled={working || !secureServerAddress || !/^\d{6}$/.test(code)}
        >
          {working ? "Connecting…" : "Connect screen"}
        </button>
        {error && <p className="error">{error}</p>}
        <footer>Player ID {installationId.slice(0, 8).toUpperCase()}</footer>
      </section>
    </main>
  );
}
