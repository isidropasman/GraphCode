import { useEffect, useRef, useState } from "react";
import { activeRun, routeUtterance, type IntentContext, type RoutedIntent, type ViewKind } from "@graphcode/protocol";
import { back, client, currentProjectId, currentTask, focusFile, navigate, notify, openTask, setTab, useApp, type TaskTab } from "../store";

const VIEW_TO_TAB: Record<ViewKind, { tab: TaskTab; highlight: ReturnType<typeof useApp.getState>["highlight"] }> = {
  objective: { tab: "objective", highlight: null },
  execution: { tab: "execution", highlight: null },
  "semantic-diff": { tab: "review", highlight: null },
  code: { tab: "review", highlight: null },
  "decision-comparison": { tab: "understanding", highlight: null },
  risk: { tab: "review", highlight: "risks" },
  evidence: { tab: "review", highlight: "evidence" },
  "system-map": { tab: "understanding", highlight: "map" },
  "concept-explainer": { tab: "understanding", highlight: "concepts" },
};

function buildContext(): IntentContext {
  const st = currentTask();
  const s = useApp.getState();
  return {
    hasTask: !!st,
    runActive: !!(st && activeRun(st)),
    selected: s.selection,
    decisions: st?.understanding?.decisions.map((d) => ({ id: d.id, question: d.question, alternatives: d.alternatives.map((a) => a.label) })) ?? [],
    changedFiles: st?.snapshot?.changes.map((c) => c.path) ?? [],
    concepts: st?.understanding?.concepts.map((c) => ({ id: c.id, term: c.term })) ?? [],
  };
}

function describe(r: RoutedIntent): string {
  const i = r.intent;
  switch (i.type) {
    case "objective.create": return "Create a new task and start Codex";
    case "agent.instruct": return "Send this instruction to Codex";
    case "view.show": return `Show ${i.view.replace("-", " ")}`;
    case "view.focus": return `Focus ${i.objectType}`;
    case "decision.explain": return "Ask Codex why (read-only)";
    case "decision.compare": return "Compare the alternatives";
    case "concept.explain": return `Explain “${i.term}” (read-only)`;
    case "evidence.show": return "Show evidence";
    case "code.open": return i.path ? `Open ${i.path}` : "Open code";
    case "verification.run": return "Run the verification command";
    case "question.ask": return "Ask Codex (read-only)";
    case "navigation.back": return "Go back";
    case "blocked": return i.reason;
    case "unrecognized": return "Not understood. Edit and try again, or type a question.";
  }
}

async function execute(r: RoutedIntent, source: "text" | "voice") {
  const i = r.intent;
  const st = currentTask();
  const s = useApp.getState();
  const ctx = { objectType: s.selection?.type ?? (st ? ("task" as const) : null), objectId: s.selection?.id ?? null, view: s.screen.name === "task" ? s.screen.tab : s.screen.name };
  switch (i.type) {
    case "objective.create": {
      const projectId = currentProjectId();
      if (!projectId) throw new Error("Open a repository first.");
      const task = await client.call("task.create", { projectId, objective: { text: i.text, constraints: [], source }, start: true });
      openTask(task.id, "execution");
      return;
    }
    case "agent.instruct":
      if (!st) throw new Error("Open a task first.");
      await client.call("run.instruct", { taskId: st.task.id, text: i.text, source });
      setTab("execution");
      return;
    case "view.show": {
      const m = VIEW_TO_TAB[i.view];
      useApp.setState({ highlight: m.highlight });
      setTab(m.tab);
      return;
    }
    case "decision.compare":
      useApp.setState({ compareDecisionId: i.decisionId, selection: i.decisionId ? { type: "decision", id: i.decisionId } : s.selection });
      setTab("understanding");
      return;
    case "view.focus":
      useApp.setState({ selection: { type: i.objectType, id: i.objectId } });
      return;
    case "evidence.show":
      useApp.setState({ highlight: "evidence" });
      setTab("review");
      return;
    case "code.open":
      if (i.path) focusFile(i.path);
      else setTab("review");
      return;
    case "decision.explain":
    case "concept.explain":
    case "question.ask": {
      if (!st) throw new Error("Open a task to ask about its result.");
      const context = i.type === "decision.explain" && i.decisionId ? { ...ctx, objectType: "decision" as const, objectId: i.decisionId } : i.type === "concept.explain" ? { ...ctx, objectType: "concept" as const, objectId: st.understanding?.concepts.find((c) => c.term === i.term)?.id ?? null } : ctx;
      await client.call("question.ask", { taskId: st.task.id, text: i.text, source, context });
      setTab("understanding");
      return;
    }
    case "verification.run": {
      if (!st) throw new Error("Open a task first.");
      const [cand] = await client.call("verification.candidates", { taskId: st.task.id });
      if (!cand) throw new Error("No verification command is declared. Enter one in Review → Verification.");
      useApp.setState({ highlight: "verification" });
      setTab("review");
      await client.call("verification.run", { taskId: st.task.id, command: cand.command });
      return;
    }
    case "navigation.back":
      back();
      return;
    case "blocked":
    case "unrecognized":
      return;
  }
}

type Mode = "idle" | "recording" | "transcribing" | "review";

export function VoiceBar() {
  const voice = useApp((s) => s.status?.voice);
  const selection = useApp((s) => s.selection);
  useApp((s) => s.screen);
  const [mode, setMode] = useState<Mode>("idle");
  const [text, setText] = useState("");
  const [source, setSource] = useState<"text" | "voice">("text");
  const [level, setLevel] = useState(0);
  const rec = useRef<{ mr: MediaRecorder; chunks: Blob[]; stream: MediaStream; raf: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const routed = text.trim() ? routeUtterance(text, buildContext()) : null;

  const start = async () => {
    if (!voice?.configured || rec.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      const actx = new AudioContext();
      const an = actx.createAnalyser();
      actx.createMediaStreamSource(stream).connect(an);
      const buf = new Uint8Array(an.fftSize);
      const tick = () => {
        an.getByteTimeDomainData(buf);
        let peak = 0;
        for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
        setLevel(peak / 128);
        if (rec.current) rec.current.raf = requestAnimationFrame(tick);
      };
      rec.current = { mr, chunks, stream, raf: 0 };
      rec.current.raf = requestAnimationFrame(tick);
      mr.start();
      setMode("recording");
    } catch (err) {
      notify(`Microphone unavailable: ${(err as Error).message}`);
    }
  };

  const stop = async () => {
    const r = rec.current;
    if (!r) return;
    rec.current = null;
    cancelAnimationFrame(r.raf);
    const done = new Promise((res) => (r.mr.onstop = res));
    r.mr.stop();
    await done;
    r.stream.getTracks().forEach((t) => t.stop());
    setLevel(0);
    const blob = new Blob(r.chunks, { type: r.mr.mimeType || "audio/webm" });
    if (blob.size < 2000) {
      setMode("idle");
      return;
    }
    setMode("transcribing");
    try {
      const b64 = await new Promise<string>((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result).split(",")[1] ?? "");
        fr.onerror = () => rej(fr.error);
        fr.readAsDataURL(blob);
      });
      const { text } = await client.call("voice.transcribe", { audioBase64: b64, mimeType: blob.type });
      setText(text);
      setSource("voice");
      const r2 = routeUtterance(text, buildContext());
      // Navigation is safe to act on immediately; everything else waits for the user to confirm the editable transcript.
      if (r2.risk === "navigation") {
        await execute(r2, "voice");
        setMode("review");
      } else {
        setMode("review");
        setTimeout(() => input.current?.focus(), 0);
      }
    } catch (err) {
      notify(err);
      setMode("idle");
    }
  };

  useEffect(() => {
    const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || !!t.closest(".monaco-editor"));
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && e.ctrlKey && !e.repeat) {
        e.preventDefault();
        void start();
      } else if (e.key === "`" && !typing(e.target) && !e.repeat) {
        e.preventDefault();
        void start();
      }
    };
    const up = (e: KeyboardEvent) => {
      if ((e.code === "Space" || e.key === "`" || e.key === "Control") && rec.current) void stop();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  });

  const run = async () => {
    if (!routed || routed.risk === "blocked" || routed.intent.type === "unrecognized") return;
    try {
      await execute(routed, source);
      setText("");
      setSource("text");
      setMode("idle");
    } catch (err) {
      notify(err);
    }
  };

  return (
    <footer className={`voicebar mode-${mode}`}>
      <button
        className={`mic ${mode === "recording" ? "rec" : ""}`}
        disabled={!voice?.configured || mode === "transcribing"}
        onPointerDown={() => void start()}
        onPointerUp={() => void stop()}
        onPointerLeave={() => mode === "recording" && void stop()}
        title={voice?.configured ? "Hold to talk (or hold ` / Ctrl+Space)" : voice?.reason ?? "Voice not configured"}
        aria-label="Hold to talk"
        style={{ boxShadow: mode === "recording" ? `0 0 0 ${4 + level * 18}px rgba(239,68,68,.25)` : undefined }}
      >
        {mode === "recording" ? "● REC" : mode === "transcribing" ? "…" : "🎙"}
      </button>
      <form className="voice-form" onSubmit={(e) => { e.preventDefault(); void run(); }}>
        <input
          ref={input}
          value={text}
          onChange={(e) => { setText(e.target.value); if (mode === "idle") setSource("text"); }}
          placeholder={mode === "recording" ? "Listening… release to transcribe" : mode === "transcribing" ? "Transcribing…" : selection ? `Say or type a command about “${selection.label ?? selection.id}”` : "Say or type: “show what changed”, “why did you choose…”, “run the tests”…"}
          aria-label="Voice transcript or typed command"
        />
        {routed && (
          <span className={`intent intent-${routed.risk}`}>
            {source === "voice" && <span className="muted">transcript · </span>}
            {describe(routed)}
          </span>
        )}
        {routed && routed.risk !== "blocked" && routed.intent.type !== "unrecognized" && (
          <button className={routed.requiresConfirmation ? "primary" : ""} type="submit">
            {routed.requiresConfirmation ? "Confirm" : routed.risk === "question" ? "Ask" : "Go"}
          </button>
        )}
        {text && <button type="button" onClick={() => { setText(""); setMode("idle"); }}>Clear</button>}
      </form>
      {selection && <span className="sel small" title="Voice commands like “explain this” target the selection">◎ {selection.label ?? selection.id}</span>}
    </footer>
  );
}
