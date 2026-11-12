import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Button, Field } from "./components";
import { api } from "./api";
export function PasswordRecovery({
  confirm,
  enabled,
}: {
  confirm: boolean;
  enabled: boolean | undefined;
}) {
  const [token, setToken] = useState(() =>
    confirm
      ? (new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "")
      : "",
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (confirm && window.location.hash)
      window.history.replaceState(
        window.history.state,
        "",
        window.location.pathname,
      );
  }, [confirm]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (confirm) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
        setError("This reset link is invalid. Request a new email.");
        return;
      }
      if (
        Array.from(password).length < 16 ||
        new TextEncoder().encode(password).byteLength > 72
      ) {
        setError("Use at least 16 characters and at most 72 UTF-8 bytes.");
        return;
      }
      if (password !== confirmation) {
        setError("The passwords do not match.");
        return;
      }
    }
    setBusy(true);
    try {
      if (confirm) {
        await api.confirmPasswordReset(token, password);
        setToken("");
        setMessage("Password changed. Sign in again with your new password.");
      } else {
        setMessage((await api.requestPasswordReset(email)).message);
      }
    } catch (problem) {
      setError(
        problem instanceof Error
          ? problem.message
          : "Account recovery is unavailable",
      );
    } finally {
      setPassword("");
      setConfirmation("");
      setBusy(false);
    }
  };
  return (
    <main className="bootstrap-password-page">
      <form
        className="bootstrap-password-card"
        aria-labelledby="recovery-title"
        onSubmit={(event) => void submit(event)}
      >
        <img
          src="/brand/ScreenGoblin_Horizontal_Transparent_Master.png"
          alt="ScreenGoblin"
        />
        <p className="eyebrow">Account recovery</p>
        <h1 id="recovery-title">
          {confirm ? "Choose a new password" : "Reset your password"}
        </h1>
        {enabled === undefined ? (
          <p role="status">Checking account recovery…</p>
        ) : !enabled ? (
          <p role="status">
            Email recovery is unavailable. Contact your administrator.
          </p>
        ) : message ? (
          <p role="status">{message}</p>
        ) : (
          <>
            <p>
              {confirm
                ? "Choose a different password with at least 16 characters. Existing sessions will be signed out."
                : "Enter your sign-in email. If your account is eligible, you will receive a one-use reset link."}
            </p>
            {confirm ? (
              <>
                <Field label="New password">
                  <input
                    type="password"
                    autoComplete="new-password"
                    required
                    value={password}
                    disabled={busy}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </Field>
                <Field label="Confirm new password">
                  <input
                    type="password"
                    autoComplete="new-password"
                    required
                    value={confirmation}
                    disabled={busy}
                    onChange={(e) => setConfirmation(e.target.value)}
                  />
                </Field>
              </>
            ) : (
              <Field label="Email">
                <input
                  type="email"
                  autoComplete="username"
                  required
                  value={email}
                  disabled={busy}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </Field>
            )}
            {error && (
              <p className="error-message" role="alert">
                {error}
              </p>
            )}
            <div className="bootstrap-password-actions">
              <Button type="submit" disabled={busy}>
                {busy
                  ? "Working…"
                  : confirm
                    ? "Change password"
                    : "Email reset link"}
              </Button>
            </div>
          </>
        )}
        <p>
          <Link to="/">Return to sign in</Link>
        </p>
      </form>
    </main>
  );
}
