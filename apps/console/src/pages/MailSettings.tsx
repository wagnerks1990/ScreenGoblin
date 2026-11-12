import { useEffect, useState } from "react";
import { api, type MailOverview } from "../api";
import { Button, Field } from "../components";
const when = (value: string) =>
  Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString()
    : "Unknown time";
export function MailSettings() {
  const [data, setData] = useState<MailOverview>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [alerts, setAlerts] = useState(false);
  const [localPart, setLocalPart] = useState("support");
  const [inboxEnabled, setInboxEnabled] = useState(true);
  const [testKey, setTestKey] = useState(() => crypto.randomUUID());
  const apply = (result: MailOverview) => {
    setData(result);
    setAlerts(result.offlineAlertsEnabled);
    if (result.inbox) {
      setLocalPart(result.inbox.address.split("@")[0] ?? "support");
      setInboxEnabled(result.inbox.enabled);
    }
  };
  useEffect(() => {
    if (!api.hasLiveSession()) return;
    let active = true;
    void api
      .mailOverview()
      .then((result) => {
        if (active) apply(result);
      })
      .catch(() => {
        if (active) setError("Email settings could not be loaded. Try again.");
      });
    return () => {
      active = false;
    };
  }, []);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      apply(await api.mailOverview());
    } catch (problem) {
      setError(
        problem instanceof Error
          ? problem.message
          : "The email change was not confirmed",
      );
    } finally {
      setBusy(false);
    }
  };
  if (!api.hasLiveSession())
    return <p role="status">Sign in to manage email notifications.</p>;
  if (!data)
    return (
      <div>
        <p role={error ? "alert" : "status"}>
          {error || "Loading email settings…"}
        </p>
        <Button disabled={busy} onClick={() => void run(async () => undefined)}>
          Retry
        </Button>
      </div>
    );
  if (!data.configured)
    return (
      <div role="status">
        <h3>Email notifications are unavailable</h3>
        <p>Contact your administrator to configure email delivery.</p>
      </div>
    );
  return (
    <div className="mail-settings">
      <p>
        Sending address: <b>{data.from}</b>
      </p>
      {!data.workerHealthy && (
        <p role="alert">
          Email processing is delayed. Messages may remain queued.
        </p>
      )}
      <section aria-labelledby="mail-alerts-title">
        <h3 id="mail-alerts-title">Screen status alerts</h3>
        <p>
          Get an email when a previously connected screen stops reporting for{" "}
          {data.offlineMinutes} minutes, and another when it recovers. Repeated
          checks do not send repeated alerts.
        </p>
        <label className="mail-toggle">
          <input
            type="checkbox"
            checked={alerts}
            disabled={busy}
            onChange={(event) => setAlerts(event.target.checked)}
          />
          Email offline and recovery alerts to my sign-in address
        </label>
        <Button
          disabled={busy || alerts === data.offlineAlertsEnabled}
          onClick={() =>
            void run(async () => {
              await api.mailPreferences(alerts);
              setNotice("Alert preferences saved.");
            })
          }
        >
          Save alert preferences
        </Button>
        <p>
          These notifications are operational only and are not an
          emergency-notification service.
        </p>
      </section>
      <section aria-labelledby="mail-inbox-title">
        <h3 id="mail-inbox-title">Support mailbox</h3>
        <p>
          Message bodies and attachments stay in your Resend mailbox. Incoming
          mail cannot publish content or control screens.
        </p>
        <Field label="Mailbox name">
          <input
            pattern="[a-z0-9][a-z0-9-]{0,31}"
            maxLength={32}
            value={localPart}
            disabled={busy || !data.receivingConfigured}
            onChange={(event) => setLocalPart(event.target.value.toLowerCase())}
          />
        </Field>
        <p>
          Address: {localPart}@{data.from?.split("@")[1]}
        </p>
        <label className="mail-toggle">
          <input
            type="checkbox"
            checked={inboxEnabled}
            disabled={busy || !data.receivingConfigured}
            onChange={(event) => setInboxEnabled(event.target.checked)}
          />
          Show new-mail receipts for this workspace
        </label>
        <Button
          disabled={
            busy ||
            !data.receivingConfigured ||
            !/^[a-z0-9][a-z0-9-]{0,31}$/.test(localPart)
          }
          onClick={() =>
            void run(async () => {
              await api.mailInbox(localPart, inboxEnabled);
              setNotice("Support mailbox preferences saved.");
            })
          }
        >
          Save support mailbox
        </Button>
        <p>
          <a
            href="https://resend.com/emails"
            target="_blank"
            rel="noopener noreferrer"
          >
            Open Resend mailbox
          </a>
        </p>
        <ul>
          {data.received.map((message) => (
            <li key={message.id}>
              Message received · {when(message.receivedAt)}
            </li>
          ))}
        </ul>
        {data.received.length === 0 && <p>No received-message receipts yet.</p>}
      </section>
      <section aria-labelledby="mail-delivery-title">
        <h3 id="mail-delivery-title">Delivery history</h3>
        <p>
          “Accepted” means the provider accepted a message; it does not confirm
          delivery to an inbox.
        </p>
        <Button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await api.mailTest(testKey);
              setTestKey(crypto.randomUUID());
              setNotice(
                "Delivery test queued for your sign-in address. Check delivery history for its status.",
              );
            })
          }
        >
          Send a test to my account
        </Button>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => void run(async () => undefined)}
        >
          Refresh email status
        </Button>
        <table>
          <thead>
            <tr>
              <th>Message</th>
              <th>Delivery status</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {data.jobs.map((job) => (
              <tr key={job.id}>
                <td>{job.kind.toLowerCase().replaceAll("_", " ")}</td>
                <td>{job.status.toLowerCase()}</td>
                <td>{when(job.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.jobs.length === 0 && <p>No email deliveries yet.</p>}
      </section>
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}
