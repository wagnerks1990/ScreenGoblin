import { useState, type FormEvent } from "react";
import { Button, Field } from "./components";

const utf8 = new TextEncoder();

function newPasswordError(
  currentPassword: string,
  password: string,
  confirmation: string,
) {
  if (Array.from(password).length < 16)
    return "New password must contain at least 16 characters.";
  if (utf8.encode(password).byteLength > 72)
    return "New password must be no more than 72 bytes when encoded as UTF-8.";
  if (password !== confirmation) return "New passwords do not match.";
  if (password === currentPassword)
    return "New password must differ from the bootstrap password.";
  return "";
}

export function BootstrapPasswordRotation({
  changeBefore,
  onRotate,
  onAbandon,
}: {
  changeBefore: string;
  onRotate: (currentPassword: string, newPassword: string) => Promise<void>;
  onAbandon: () => Promise<void>;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [abandoning, setAbandoning] = useState(false);

  const clearPasswords = () => {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmation("");
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const validationError = newPasswordError(
      currentPassword,
      newPassword,
      confirmation,
    );
    if (!currentPassword || validationError) {
      setError(
        !currentPassword
          ? "Enter the current bootstrap password."
          : validationError,
      );
      clearPasswords();
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      await onRotate(currentPassword, newPassword);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Password change could not be completed.",
      );
    } finally {
      clearPasswords();
      setSubmitting(false);
    }
  };

  const abandon = async () => {
    setAbandoning(true);
    setError("");
    clearPasswords();
    await onAbandon();
  };

  return (
    <main className="bootstrap-password-page">
      <form
        className="bootstrap-password-card"
        onSubmit={(event) => void submit(event)}
        aria-describedby="bootstrap-password-intro bootstrap-password-deadline"
      >
        <img
          src="/brand/ScreenGoblin_Horizontal_Transparent_Master.png"
          alt="ScreenGoblin"
        />
        <p className="eyebrow">Security action required</p>
        <h1>Change bootstrap password</h1>
        <p id="bootstrap-password-intro">
          This temporary account password must be replaced before the Console
          can open. Choose a unique password with at least 16 characters.
        </p>
        <p id="bootstrap-password-deadline" className="bootstrap-deadline">
          Complete this change before {new Date(changeBefore).toLocaleString()}.
        </p>
        <Field label="Current bootstrap password">
          <input
            aria-label="Current bootstrap password"
            autoFocus
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            disabled={submitting || abandoning}
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
        </Field>
        <Field label="New password">
          <input
            aria-label="New password"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            disabled={submitting || abandoning}
            onChange={(event) => setNewPassword(event.target.value)}
          />
          <small>16 or more characters and no more than 72 UTF-8 bytes.</small>
        </Field>
        <Field label="Confirm new password">
          <input
            aria-label="Confirm new password"
            type="password"
            autoComplete="new-password"
            value={confirmation}
            disabled={submitting || abandoning}
            onChange={(event) => setConfirmation(event.target.value)}
          />
        </Field>
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        <div className="bootstrap-password-actions">
          <Button
            type="button"
            variant="secondary"
            disabled={submitting || abandoning}
            onClick={() => void abandon()}
          >
            {abandoning ? "Returning…" : "Return to sign in"}
          </Button>
          <Button
            type="submit"
            disabled={
              submitting ||
              abandoning ||
              !currentPassword ||
              !newPassword ||
              !confirmation
            }
          >
            {submitting ? "Changing…" : "Change password"}
          </Button>
        </div>
      </form>
    </main>
  );
}
