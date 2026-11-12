import { useEffect } from "react";
import { taskPhase } from "@graphcode/protocol";
import { VoiceBar } from "./components/VoiceBar";
import { PhaseBadge } from "./components/ui";
import { back, navigate, openTask, refreshStatus, toggleSpeak, toggleTheme, ttsAvailable, useApp } from "./store";
import { Home } from "./views/Home";
import { ProjectView } from "./views/ProjectView";
import { TaskView } from "./views/TaskView";

function StatusChips() {
  const { conn, connDetail, status } = useApp();
  const codex = status?.codex;
  const codexState = !codex ? "unknown" : !codex.available ? "error" : codex.requiresAuth && !codex.account ? "warn" : "ok";
  const codexTitle = !codex
    ? "Not connected"
    : codex.error ?? (codex.account ? `Signed in: ${codex.account.label ?? codex.account.type}` : codex.requiresAuth ? "Codex is installed but not signed in. Run `codex login` or start the runtime with OPENAI_API_KEY." : "Ready");
  return (
    <div className="chips">
      <span className={`chip chip-${conn === "connected" ? "ok" : conn === "connecting" ? "warn" : "error"}`} title={connDetail ?? undefined}>
        Runtime {conn === "connected" ? status?.runtimeVersion ?? "" : conn}
      </span>
      <span className={`chip chip-${codexState}`} title={`${codexTitle} (click to re-check)`} onClick={() => void refreshStatus()}>
        Codex {codex?.version ?? ""} {codexState === "warn" ? "· not signed in" : codexState === "error" ? "· unavailable" : ""}
      </span>
      <span className={`chip chip-${status?.voice.configured ? "ok" : "warn"}`} title={status?.voice.reason ?? status?.voice.provider ?? undefined}>
        Voice {status?.voice.configured ? "ready" : "· not configured"}
      </span>
    </div>
  );
}

function Breadcrumbs() {
  const { screen, projects, taskStates } = useApp();
  const st = screen.name === "task" ? taskStates[screen.taskId] : undefined;
  const projectId = screen.name === "project" ? screen.projectId : st?.task.projectId;
  const project = projects.find((p) => p.id === projectId);
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      <button className="link" onClick={() => navigate({ name: "home" })}>
        Projects
      </button>
      {project && (
        <>
          <span>/</span>
          <button className="link" onClick={() => navigate({ name: "project", projectId: project.id })}>
            {project.name}
          </button>
        </>
      )}
      {st && (
        <>
          <span>/</span>
          <span className="crumb-task">{st.task.title}</span>
          <PhaseBadge phase={taskPhase(st)} />
        </>
      )}
    </nav>
  );
}

function Sidebar() {
  const { tasks, screen, projects } = useApp();
  const projectId = screen.name === "project" ? screen.projectId : screen.name === "task" ? tasks.find((t) => t.id === screen.taskId)?.projectId : null;
  const list = tasks.filter((t) => !projectId || t.projectId === projectId);
  return (
    <aside className="sidebar">
      <div className="sidebar-title">{projectId ? projects.find((p) => p.id === projectId)?.name : "All tasks"}</div>
      {list.length === 0 && <p className="muted small">No tasks yet.</p>}
      <ul>
        {list.map((t) => (
          <li key={t.id}>
            <button className={`task-link ${screen.name === "task" && screen.taskId === t.id ? "active" : ""}`} onClick={() => openTask(t.id)}>
              <span className={`dot dot-${t.phase}`} aria-hidden />
              <span className="task-link-title">{t.title}</span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

export function App() {
  const { screen, theme, toast, history, speakAnswers, conn, connDetail } = useApp();
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && e.key === "ArrowLeft") back();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <button className="icon" onClick={back} disabled={!history.length} title="Back (Alt+←)" aria-label="Back">
            ←
          </button>
          <strong>GraphCode</strong>
        </div>
        <Breadcrumbs />
        <StatusChips />
        <div className="topbar-actions">
          {ttsAvailable() && (
            <button className={`toggle ${speakAnswers ? "on" : ""}`} onClick={toggleSpeak} title="Read answers aloud (text-to-speech)">
              Speak answers
            </button>
          )}
          <button className="icon" onClick={toggleTheme} title="Toggle theme" aria-label="Toggle theme">
            {theme === "dark" ? "☀" : "☾"}
          </button>
        </div>
      </header>
      {conn !== "connected" && (
        <div className="banner banner-warn" role="status">
          {conn === "connecting" ? "Connecting to the local GraphCode runtime…" : `Runtime not connected. ${connDetail ?? ""} Retrying.`}
        </div>
      )}
      <div className="body">
        {screen.name !== "home" && <Sidebar />}
        <main className="main">
          {screen.name === "home" && <Home />}
          {screen.name === "project" && <ProjectView projectId={screen.projectId} />}
          {screen.name === "task" && <TaskView taskId={screen.taskId} tab={screen.tab} />}
        </main>
      </div>
      <VoiceBar />
      {toast && (
        <div className={`toast toast-${toast.kind}`} role="alert" onClick={() => useApp.setState({ toast: null })}>
          {toast.text}
        </div>
      )}
    </div>
  );
}
