import { useEffect, useState } from "react";
import {
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import {
  LayoutDashboard,
  Images,
  ListVideo,
  CalendarDays,
  Monitor,
  Siren,
  Settings,
  Menu,
  Search,
  WifiOff,
} from "lucide-react";
import { Dashboard } from "./pages/Dashboard";
import { MediaVault } from "./pages/MediaVault";
import { Playlists } from "./pages/Playlists";
import { Schedules } from "./pages/Schedules";
import { Fleet } from "./pages/Fleet";
import { Emergency } from "./pages/Emergency";
import { SettingsPage } from "./pages/Settings";
import { Modal, Button, Field } from "./components";
import { api } from "./api";

const nav = [
  ["/dashboard", "Overview", LayoutDashboard],
  ["/media", "Media vault", Images],
  ["/playlists", "Playlists", ListVideo],
  ["/schedules", "Schedules", CalendarDays],
  ["/screens", "Screen fleet", Monitor],
] as const;

export function App() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [liveSession, setLiveSession] = useState(api.hasLiveSession());
  const [demoAllowed, setDemoAllowed] = useState(api.demoAllowed());
  const [sessionUser, setSessionUser] = useState(api.currentUser());
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutStatus, setLogoutStatus] = useState("");
  const location = useLocation();
  const canAdmin =
    (!liveSession && demoAllowed) ||
    ["OWNER", "ADMIN"].includes(sessionUser?.role ?? "");
  const dataMode = liveSession ? "live" : demoAllowed ? "demo" : "failed";
  useEffect(() => setMobileOpen(false), [location.pathname]);
  useEffect(() => {
    const refreshSession = () => {
      setLiveSession(api.hasLiveSession());
      setDemoAllowed(api.demoAllowed());
      setSessionUser(api.currentUser());
    };
    window.addEventListener("screengoblin:session-changed", refreshSession);
    return () =>
      window.removeEventListener(
        "screengoblin:session-changed",
        refreshSession,
      );
  }, []);
  const connectLive = async () => {
    setLoggingIn(true);
    setLoginError("");
    try {
      const session = await api.login(email, password);
      setLiveSession(true);
      setDemoAllowed(true);
      setSessionUser(session.user);
      setEmail("");
      setPassword("");
      setLogoutStatus("");
      setLoginOpen(false);
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "Login failed");
    } finally {
      setPassword("");
      setLoggingIn(false);
    }
  };
  const disconnectLive = async () => {
    setLoggingOut(true);
    setLogoutStatus("");
    const result = await api.logout();
    setLiveSession(false);
    setSessionUser(undefined);
    if (!result.revocationConfirmed)
      setLogoutStatus(
        "Server revocation was not confirmed. Local credentials were cleared; the session may remain usable until its one-hour expiry.",
      );
    setLoggingOut(false);
  };
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      {mobileOpen && (
        <button
          className="mobile-scrim"
          aria-label="Close navigation"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <aside className={`sidebar ${mobileOpen ? "is-open" : ""}`}>
        <div className="brand">
          <img
            src="/brand/ScreenGoblin_Horizontal_Transparent_Master.png"
            alt="ScreenGoblin"
          />
        </div>
        <nav aria-label="Primary navigation">
          <div className="nav-section-label">Workspace</div>
          {nav.map(([href, label, Icon]) => (
            <NavLink
              key={href}
              to={href}
              className={({ isActive }) =>
                `nav-link ${isActive ? "active" : ""}`
              }
            >
              <Icon size={19} />
              <span>{label}</span>
            </NavLink>
          ))}
          {canAdmin && (
            <>
              <div className="nav-section-label">Control</div>
              <NavLink
                to="/emergency"
                className={({ isActive }) =>
                  `nav-link nav-alert ${isActive ? "active" : ""}`
                }
              >
                <Siren size={19} />
                <span>Emergency center</span>
              </NavLink>
              <NavLink
                to="/settings"
                className={({ isActive }) =>
                  `nav-link ${isActive ? "active" : ""}`
                }
              >
                <Settings size={19} />
                <span>Settings</span>
              </NavLink>
            </>
          )}
        </nav>
        <div className="sidebar-foot">
          <div className="workspace-mark">CH</div>
          <div>
            <b>
              {liveSession
                ? "Connected workspace"
                : demoAllowed
                  ? "ScreenGoblin Demo"
                  : "Live session expired"}
            </b>
            <span>
              {liveSession
                ? sessionUser?.organizationId
                : demoAllowed
                  ? "Demonstration workspace"
                  : "Reconnect to load operational data"}
            </span>
          </div>
          <button
            type="button"
            aria-label="Workspace options unavailable"
            title="Workspace options are unavailable in this prototype"
            disabled
          >
            •••
          </button>
        </div>
      </aside>
      <div className="content-shell">
        <header className="topbar">
          <button
            className="menu-button"
            aria-label="Open navigation"
            onClick={() => setMobileOpen(true)}
          >
            <Menu size={21} />
          </button>
          <div className="global-search">
            <Search size={17} />
            <input
              aria-label="Global search unavailable"
              placeholder="Global search unavailable"
              title="Global search is unavailable in this prototype"
              disabled
            />
          </div>
          <div className="top-actions">
            <button
              className="demo-pill"
              disabled={loggingOut}
              onClick={() => {
                if (liveSession) {
                  void disconnectLive();
                } else {
                  setLoginOpen(true);
                }
              }}
            >
              <WifiOff size={14} />
              {loggingOut
                ? "Disconnecting…"
                : liveSession
                  ? "Disconnect live"
                  : demoAllowed
                    ? "Demo data · Connect live"
                    : "Reconnect live"}
            </button>
            {logoutStatus && (
              <p className="logout-status" role="status">
                {logoutStatus}
              </p>
            )}
            <button
              type="button"
              className="profile"
              aria-label="Profile menu unavailable"
              title="Profile menu is unavailable in this prototype"
              disabled
            >
              {(sessionUser?.name ?? "Demo Operator")
                .split(/\s+/)
                .map((part) => part[0])
                .join("")
                .slice(0, 2)
                .toUpperCase()}
            </button>
          </div>
        </header>
        <main id="main-content" tabIndex={-1}>
          <Routes>
            <Route path="/dashboard" element={<Dashboard key={dataMode} />} />
            <Route path="/media" element={<MediaVault key={dataMode} />} />
            <Route path="/playlists" element={<Playlists />} />
            <Route path="/schedules" element={<Schedules />} />
            <Route
              path="/screens"
              element={<Fleet key={dataMode} canManage={canAdmin} />}
            />
            <Route
              path="/emergency"
              element={
                canAdmin ? <Emergency /> : <Navigate to="/dashboard" replace />
              }
            />
            <Route
              path="/settings"
              element={
                canAdmin ? (
                  <SettingsPage />
                ) : (
                  <Navigate to="/dashboard" replace />
                )
              }
            />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </main>
      </div>
      <Modal
        open={loginOpen}
        onClose={() => {
          setPassword("");
          setLoginOpen(false);
        }}
        title="Connect to ScreenGoblin"
        onSubmit={(event) => {
          event.preventDefault();
          void connectLive();
        }}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setPassword("");
                setLoginOpen(false);
              }}
            >
              Keep demo mode
            </Button>
            <Button
              disabled={loggingIn || !email || password.length < 8}
              type="submit"
            >
              {loggingIn ? "Connecting…" : "Connect live"}
            </Button>
          </>
        }
      >
        <>
          <p className="modal-intro">
            Sign in with the administrator created during deployment.
            Credentials stay in this browser tab and are cleared when it closes.
          </p>
          <Field label="Email">
            <input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>
          <Field label="Password">
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          {loginError && (
            <p className="error-message" role="alert">
              {loginError}
            </p>
          )}
        </>
      </Modal>
    </div>
  );
}
