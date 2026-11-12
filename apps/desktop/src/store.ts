import { create } from "zustand";
import {
  applyEvent,
  taskPhase,
  type DomainEvent,
  type IntentContext,
  type LiveDelta,
  type Project,
  type RepoInspection,
  type RpcResult,
  type TaskState,
  type TaskSummary,
} from "@graphcode/protocol";
import { connectionInfo, RuntimeClient, type ConnState } from "./rpc";

export type TaskTab = "objective" | "execution" | "understanding" | "review";
export type Screen = { name: "home" } | { name: "project"; projectId: string } | { name: "task"; taskId: string; tab: TaskTab };
export type Selection = IntentContext["selected"];
export type SystemStatus = RpcResult<"system.status">;

type State = {
  conn: ConnState;
  connDetail: string | null;
  status: SystemStatus | null;
  projects: Project[];
  inspections: Record<string, RepoInspection>;
  tasks: TaskSummary[];
  taskStates: Record<string, TaskState>;
  /** Live, non-persisted provider output keyed by `${runId}:${itemId}`. */
  deltas: Record<string, string>;
  screen: Screen;
  history: Screen[];
  selection: Selection;
  /** Review workspace focus: file + optional line. */
  focus: { path: string; line: number | null } | null;
  compareDecisionId: string | null;
  highlight: "risks" | "evidence" | "verification" | "map" | "concepts" | null;
  theme: "dark" | "light";
  speakAnswers: boolean;
  toast: { kind: "error" | "info"; text: string } | null;
};

const initialTheme = (localStorage.getItem("gc.theme") as State["theme"] | null) ?? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");

export const useApp = create<State>(() => ({
  conn: "connecting",
  connDetail: null,
  status: null,
  projects: [],
  inspections: {},
  tasks: [],
  taskStates: {},
  deltas: {},
  screen: JSON.parse(sessionStorage.getItem("gc.screen") ?? "null") ?? { name: "home" },
  history: [],
  selection: null,
  focus: null,
  compareDecisionId: null,
  highlight: null,
  theme: initialTheme,
  speakAnswers: localStorage.getItem("gc.speak") === "1",
  toast: null,
}));

const set = useApp.setState;
const get = useApp.getState;

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
function refreshTasksSoon() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void loadTasks();
  }, 250);
}

function onEvent(e: DomainEvent) {
  const cur = get().taskStates[e.taskId];
  if (cur || e.type === "task.created") {
    try {
      const next = applyEvent(cur ?? null, e);
      if (next !== cur) set((s) => ({ taskStates: { ...s.taskStates, [e.taskId]: next } }));
    } catch {
      void loadTask(e.taskId);
    }
    if (cur && e.seq > cur.lastSeq + 1) void loadTask(e.taskId); // gap: resync from the event log
  }
  if (e.type === "run.finished") {
    const st = get().taskStates[e.taskId];
    const run = st?.runs.find((r) => r.id === e.payload.runId);
    if (run?.kind === "question" && get().speakAnswers && e.payload.finalMessage) speak(e.payload.finalMessage);
  }
  refreshTasksSoon();
}

function onDelta(d: LiveDelta) {
  const key = `${d.runId}:${d.itemId}`;
  set((s) => {
    const prev = s.deltas[key] ?? "";
    const next = (prev + d.delta).slice(-40_000);
    return { deltas: { ...s.deltas, [key]: next } };
  });
}

export const client = new RuntimeClient(connectionInfo, {
  onState: (conn, detail) => {
    set({ conn, connDetail: detail ?? null });
    if (conn === "connected") void onConnected();
  },
  onEvent,
  onDelta,
});

async function onConnected() {
  try {
    const [status, projects] = await Promise.all([client.call("system.status", {}), client.call("project.list", {})]);
    set({ status, projects });
    await loadTasks();
    const sc = get().screen;
    if (sc.name === "task") await loadTask(sc.taskId);
    if (sc.name === "project") await inspectProject(sc.projectId);
  } catch (err) {
    notify(err);
  }
}

export async function refreshStatus() {
  set({ status: await client.call("system.status", {}) });
}

export async function loadTasks() {
  try {
    set({ tasks: await client.call("task.list", { projectId: null }) });
  } catch {
    /* disconnected; reload on reconnect */
  }
}

export async function loadTask(taskId: string) {
  const st = await client.call("task.get", { taskId });
  set((s) => ({ taskStates: { ...s.taskStates, [taskId]: st } }));
  return st;
}

export async function inspectProject(projectId: string) {
  const ins = await client.call("project.inspect", { projectId });
  set((s) => ({ inspections: { ...s.inspections, [projectId]: ins } }));
}

export async function openProject(path: string) {
  const { project, inspection } = await client.call("project.open", { path });
  set((s) => ({
    projects: [project, ...s.projects.filter((p) => p.id !== project.id)],
    inspections: { ...s.inspections, [project.id]: inspection },
  }));
  navigate({ name: "project", projectId: project.id });
}

export function defaultTab(st: TaskState | undefined): TaskTab {
  if (!st) return "execution";
  const p = taskPhase(st);
  if (p === "draft") return "objective";
  if (p === "review" || p === "integrated") return "review";
  return "execution";
}

export function navigate(screen: Screen) {
  const cur = get().screen;
  if (JSON.stringify(cur) === JSON.stringify(screen)) return;
  sessionStorage.setItem("gc.screen", JSON.stringify(screen));
  set((s) => ({ screen, history: [...s.history, cur].slice(-50), selection: screen.name === "task" && cur.name === "task" && cur.taskId === screen.taskId ? s.selection : null }));
  if (screen.name === "task" && !get().taskStates[screen.taskId]) void loadTask(screen.taskId).catch(notify);
  if (screen.name === "project" && !get().inspections[screen.projectId]) void inspectProject(screen.projectId).catch(notify);
}

export function openTask(taskId: string, tab?: TaskTab) {
  navigate({ name: "task", taskId, tab: tab ?? defaultTab(get().taskStates[taskId]) });
}

export function setTab(tab: TaskTab) {
  const sc = get().screen;
  if (sc.name === "task") navigate({ ...sc, tab });
}

export function back() {
  const h = get().history;
  const prev = h[h.length - 1];
  if (!prev) return;
  sessionStorage.setItem("gc.screen", JSON.stringify(prev));
  set({ screen: prev, history: h.slice(0, -1) });
}

export function select(selection: Selection) {
  set({ selection });
}

export function focusFile(path: string, line: number | null = null) {
  set({ focus: { path, line }, selection: { type: "change", id: path, label: path, path } });
  setTab("review");
}

export function currentTask(): TaskState | null {
  const sc = get().screen;
  return sc.name === "task" ? get().taskStates[sc.taskId] ?? null : null;
}

export function currentProjectId(): string | null {
  const sc = get().screen;
  if (sc.name === "project") return sc.projectId;
  if (sc.name === "task") return get().taskStates[sc.taskId]?.task.projectId ?? null;
  return null;
}

export function notify(err: unknown, kind: "error" | "info" = "error") {
  const text = err instanceof Error ? err.message : String(err);
  set({ toast: { kind, text } });
  setTimeout(() => get().toast?.text === text && set({ toast: null }), 7000);
}

export function toggleTheme() {
  const theme = get().theme === "dark" ? "light" : "dark";
  localStorage.setItem("gc.theme", theme);
  set({ theme });
}

export function toggleSpeak() {
  const v = !get().speakAnswers;
  localStorage.setItem("gc.speak", v ? "1" : "0");
  set({ speakAnswers: v });
}

export const ttsAvailable = () => typeof window !== "undefined" && "speechSynthesis" in window;

export function speak(text: string) {
  if (!ttsAvailable()) return;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(text.slice(0, 1200)));
}
