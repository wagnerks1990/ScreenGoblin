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
  Bell,
  Plus,
  Sparkles,
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
  const [createOpen, setCreateOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [liveSession, setLiveSession] = useState(api.hasLiveSession());
  const [sessionUser, setSessionUser] = useState(api.currentUser());
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);
  const location = useLocation();
  const canAdmin =
    !liveSession || ["OWNER", "ADMIN"].includes(sessionUser?.role ?? "");
  const canPublish =
    !liveSession ||
    ["OWNER", "ADMIN", "PUBLISHER"].includes(sessionUser?.role ?? "");
  useEffect(() => setMobileOpen(false), [location.pathname]);
  useEffect(() => {
    const refreshSession = () => {
      setLiveSession(api.hasLiveSession());
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
      setSessionUser(session.user);
      setEmail("");
      setPassword("");
      setLoginOpen(false);
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "Login failed");
    } finally {
      setPassword("");
      setLoggingIn(false);
    }
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
              {label === "Screen fleet" && <em>2</em>}
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
            <b>{liveSession ? "Connected workspace" : "ScreenGoblin Demo"}</b>
            <span>
              {liveSession
                ? sessionUser?.organizationId
                : "Demonstration workspace"}
            </span>
          </div>
          <button aria-label="Workspace options">•••</button>
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
              aria-label="Global search"
              placeholder="Search screens, media, or playlists…"
            />
            <kbd>⌘ K</kbd>
          </div>
          <div className="top-actions">
            <button
              className="demo-pill"
              onClick={() => {
                if (liveSession) {
                  api.logout();
                  setLiveSession(false);
                  setSessionUser(undefined);
                } else {
                  setLoginOpen(true);
                }
              }}
            >
              <WifiOff size={14} />
              {liveSession ? "Disconnect live" : "Demo data · Connect live"}
            </button>
            <button className="icon-button" aria-label="Notifications">
              <Bell size={19} />
              <i />
            </button>
            <button className="profile" aria-label="Open profile menu">
              {(sessionUser?.name ?? "Demo Operator")
                .split(/\s+/)
                .map((part) => part[0])
                .join("")
                .slice(0, 2)
                .toUpperCase()}
            </button>
          </div>
        </header>
        <main id="main-content">
          <Routes>
            <Route
              path="/dashboard"
              element={
                <Dashboard
                  key={liveSession ? "live" : "demo"}
                  onCreate={() => setCreateOpen(true)}
                  canCreate={canPublish}
                />
              }
            />
            <Route
              path="/media"
              element={<MediaVault key={liveSession ? "live" : "demo"} />}
            />
            <Route path="/playlists" element={<Playlists />} />
            <Route path="/schedules" element={<Schedules />} />
            <Route
              path="/screens"
              element={
                <Fleet
                  key={liveSession ? "live" : "demo"}
                  canManage={canAdmin}
                />
              }
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
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create announcement"
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => setCreateOpen(false)}
              icon={<Sparkles size={17} />}
            >
              Open studio
            </Button>
          </>
        }
      >
        <div className="creation-grid">
          <button>
            <span className="creation-icon green">
              <Sparkles />
            </span>
            <b>Start from template</b>
            <small>Use an approved district layout</small>
          </button>
          <button>
            <span className="creation-icon amber">
              <Siren />
            </span>
            <b>Priority message</b>
            <small>Publish an important notice</small>
          </button>
        </div>
        <Field label="Quick start">
          <div className="input-with-button">
            <input placeholder="What do you need to announce?" />
            <button aria-label="Create from prompt">
              <Plus size={18} />
            </button>
          </div>
        </Field>
      </Modal>
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
