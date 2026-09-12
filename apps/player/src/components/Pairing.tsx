import { useEffect, useRef, useState } from "react";
import { PlayerApi, PlayerApiFailure } from "../core/api";
import { hasNativeDeviceIdentity, rotateDeviceIdentity } from "../core/device";
import type { Credentials, PendingProofPairing } from "../core/types";
import type { PairingPendingApprovalResponse } from "@screengoblin/contracts";

interface Props {
  installationId: string;
  defaultApiUrl: string;
  onPaired: (credentials: Credentials) => void | Promise<void>;
  onIdentityChanged?: (installationId: string) => void;
  pendingPairing?: PendingProofPairing | undefined;
  onPendingPairing: (value: PendingProofPairing) => void | Promise<void>;
  onDiscardPendingPairing: () => void | Promise<void>;
}

export function Pairing({
  installationId,
  defaultApiUrl,
  onPaired,
  onIdentityChanged,
  pendingPairing,
  onPendingPairing,
  onDiscardPendingPairing,
}: Props) {
  const [apiUrl, setApiUrl] = useState(
    pendingPairing?.apiBaseUrl ?? defaultApiUrl,
  );
  const [currentInstallationId, setCurrentInstallationId] =
    useState(installationId);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [pending, setPending] = useState<
    PairingPendingApprovalResponse | undefined
  >(pendingPairing?.approval);
  const [replacementAcknowledged, setReplacementAcknowledged] = useState(false);
  const [working, setWorking] = useState(false);
  const [recoveryAvailable, setRecoveryAvailable] = useState(
    Boolean(pendingPairing),
  );
  const controller = useRef<AbortController | undefined>(undefined);
  const recoveryRef = useRef<PendingProofPairing | undefined>(pendingPairing);
  const resumedOnBoot = useRef(false);
  useEffect(() => () => controller.current?.abort(), []);
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

  const runPairing = async (recovery?: PendingProofPairing) => {
    setError(undefined);
    setNotice(undefined);
    setPending(recovery?.approval);
    setWorking(true);
    const request = new AbortController();
    controller.current = request;
    try {
      await onPaired(
        await (recovery
          ? new PlayerApi(recovery.apiBaseUrl).resumePairing(recovery, {
              signal: request.signal,
              onPending: async (approval, nextRecovery) => {
                await onPendingPairing(nextRecovery);
                recoveryRef.current = nextRecovery;
                setRecoveryAvailable(true);
                setPending(approval);
              },
            })
          : new PlayerApi(apiUrl).pair(code, currentInstallationId, {
              signal: request.signal,
              onProofPrepared: async (nextRecovery) => {
                await onPendingPairing(nextRecovery);
                recoveryRef.current = nextRecovery;
                setRecoveryAvailable(true);
              },
              onPending: async (approval, nextRecovery) => {
                await onPendingPairing(nextRecovery);
                recoveryRef.current = nextRecovery;
                setRecoveryAvailable(true);
                setPending(approval);
              },
            })),
      );
    } catch (reason) {
      if (request.signal.aborted)
        setNotice(
          "Approval wait paused. The saved proof will resume after restart or when requested.",
        );
      else
        setError(
          reason instanceof Error
            ? reason.message
            : "This screen could not be connected",
        );
      if (
        reason instanceof PlayerApiFailure &&
        recoveryRef.current &&
        (reason.kind === "timeout" ||
          (reason.kind === "http" &&
            [400, 401, 403, 404, 409, 410, 422].includes(reason.status ?? 0)))
      ) {
        await onDiscardPendingPairing();
        recoveryRef.current = undefined;
        setRecoveryAvailable(false);
        setPending(undefined);
      }
    } finally {
      if (controller.current === request) controller.current = undefined;
      setWorking(false);
    }
  };

  const connect = () => runPairing();

  useEffect(() => {
    if (!pendingPairing || resumedOnBoot.current) return;
    resumedOnBoot.current = true;
    void runPairing(pendingPairing);
    // A recovery record is immutable except for its pending envelope; starting
    // more than once would create parallel polls with the same proof.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingPairing?.finalBody]);

  const replaceIdentity = async () => {
    setError(undefined);
    setNotice(undefined);
    setPending(undefined);
    setWorking(true);
    try {
      const identity = await rotateDeviceIdentity();
      setCurrentInstallationId(identity.keyId);
      onIdentityChanged?.(identity.keyId);
      setCode("");
      setReplacementAcknowledged(false);
      setNotice(
        "A fresh device identity was created. Enter the targeted replacement code from an operator.",
      );
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The device identity could not be replaced",
      );
    } finally {
      setWorking(false);
    }
  };

  return (
    <main className="pairing-shell">
      <form
        className="pairing-card"
        aria-live="polite"
        onSubmit={(event) => {
          event.preventDefault();
          void connect();
        }}
      >
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
            disabled={recoveryAvailable}
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
            disabled={recoveryAvailable}
            onChange={(event) =>
              setCode(event.target.value.replace(/\D/g, "").slice(0, 6))
            }
            placeholder="000000"
          />
        </label>
        <button
          type="submit"
          disabled={
            recoveryAvailable ||
            working ||
            !secureServerAddress ||
            !/^\d{6}$/.test(code)
          }
        >
          {pending
            ? "Awaiting approval…"
            : working
              ? "Connecting…"
              : "Connect screen"}
        </button>
        {pending && (
          <section className="pairing-pending" role="status">
            <strong>Awaiting operator approval</strong>
            <span>Confirm this exact key fingerprint in the console:</span>
            <code>{pending.fingerprint}</code>
            <span>
              Approval expires {new Date(pending.expiresAt).toLocaleString()}.
            </span>
            <button type="button" onClick={() => controller.current?.abort()}>
              Pause approval wait
            </button>
          </section>
        )}
        {recoveryAvailable && !working && recoveryRef.current && (
          <button
            type="button"
            onClick={() => void runPairing(recoveryRef.current)}
          >
            Resume approval wait
          </button>
        )}
        {hasNativeDeviceIdentity() && !recoveryAvailable && !pending && (
          <section className="replacement-control">
            <label>
              <input
                type="checkbox"
                checked={replacementAcknowledged}
                disabled={working}
                onChange={(event) =>
                  setReplacementAcknowledged(event.target.checked)
                }
              />
              I have a targeted replacement code. This creates a new device
              identity.
            </label>
            <button
              className="secondary"
              type="button"
              disabled={working || !replacementAcknowledged}
              onClick={() => void replaceIdentity()}
            >
              Replace previous enrollment
            </button>
          </section>
        )}
        {notice && <p role="status">{notice}</p>}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <footer>
          Player ID {currentInstallationId.slice(0, 8).toUpperCase()}
        </footer>
      </form>
    </main>
  );
}
