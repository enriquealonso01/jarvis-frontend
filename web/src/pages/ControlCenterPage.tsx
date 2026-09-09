import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AudioLines,
  Bell,
  Bot,
  CalendarClock,
  CornerDownRight,
  Cpu,
  Menu,
  Mic,
  Receipt,
  RefreshCw,
  Send,
  SquareTerminal,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { usePageHeader } from "@/contexts/usePageHeader";
import {
  api,
  type ControlActivityResponse,
  type ControlAttentionAlert,
  type ControlAttentionResponse,
  type ControlAutomation,
  type ControlAutomationsResponse,
  type ControlKnowledgeGraphResponse,
  type ControlSpendResponse,
  type ControlVitalsResponse,
  type ControlVoiceTranscriptsResponse,
  type ControlZaiUsageResponse,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { VoiceConsole } from "@/components/VoiceConsole";
import { KnowledgeMap, type MapRepo } from "@/components/KnowledgeMap";
import "./control-center.css";

const DCOLOR: Record<string, string> = {
  system: "#a78bfa",
  krendora: "#22d3ee",
  ticketflipping: "#fbbf24",
  personal: "#34d399",
};
const DOMAINS = [
  { id: "all", label: "All", color: "var(--fg)" },
  { id: "system", label: "System", color: DCOLOR.system },
  { id: "krendora", label: "Krendora", color: DCOLOR.krendora },
  { id: "ticketflipping", label: "Ticketflipping", color: DCOLOR.ticketflipping },
  { id: "personal", label: "Personal", color: DCOLOR.personal },
];
// Fallback constellation until the graphify aggregate is built (grounded set).
const FALLBACK_REPOS: MapRepo[] = [
  { name: "JARVIS Core", domain: "system", nodes: 412, edges: 980, top: "dispatcher" },
  { name: "dispatcher", domain: "system", nodes: 31, edges: 68, top: "queue" },
  { name: "whatsapp-reader", domain: "system", nodes: 54, edges: 120, top: "baileys" },
  { name: "aidp-automation", domain: "krendora", nodes: 180, edges: 430, top: "ig-poster" },
  { name: "account-studio", domain: "krendora", nodes: 88, edges: 150, top: "assets" },
  { name: "tftboxext", domain: "ticketflipping", nodes: 640, edges: 1520, top: "heatmap" },
  { name: "tfteventalerts", domain: "ticketflipping", nodes: 300, edges: 720, top: "flare" },
  { name: "broker-copilot", domain: "ticketflipping", nodes: 210, edges: 560, top: "langflow" },
  { name: "tmapi", domain: "ticketflipping", nodes: 260, edges: 610, top: "scrapers" },
  { name: "home-budget", domain: "personal", nodes: 70, edges: 140, top: "supabase" },
  { name: "home-finances", domain: "personal", nodes: 64, edges: 120, top: "ledger" },
  { name: "HeRoseFromDeath", domain: "personal", nodes: 120, edges: 240, top: "app" },
  { name: "enriquecodes", domain: "personal", nodes: 90, edges: 160, top: "portfolio" },
  { name: "offer", domain: "personal", nodes: 40, edges: 70, top: "landing" },
  { name: "tongeMaster", domain: "personal", nodes: 55, edges: 95, top: "trainer" },
];

interface Task {
  id: string;
  goal: string;
  kind: string;
  dom: string;
  state: string;
  pct: number | null;
  ago: number;
  now: string;
}

type ChatMsg =
  | { r: "you" | "a"; text: string }
  | { r: "call"; name: string; args: string }
  | { r: "tool"; name: string; text: string };

const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const MONS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const p2 = (n: number) => (n < 10 ? "0" : "") + n;
const agoLabel = (s: number) =>
  s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
const nextLabel = (s: number) => {
  if (s < 60) return `in ${s < 0 ? 0 : Math.round(s)}s`;
  if (s < 3600) return `in ${Math.floor(s / 60)}m`;
  if (s < 86400) return `in ${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `in ${Math.floor(s / 86400)}d`;
};
const resetLabel = (s: number) => {
  if (s <= 0) return "resetting";
  const d = Math.floor(s / 86400),
    h = Math.floor((s % 86400) / 3600),
    m = Math.floor((s % 3600) / 60);
  if (d > 0) return `resets in ${d}d ${h}h`;
  if (h > 0) return `resets in ${h}h ${m}m`;
  return `resets in ${m}m`;
};

function domOf(s: string): string {
  const l = s.toLowerCase();
  if (/tftbox|flare|tmapi|broker|copilot|ticket|axs|stubhub|scrap|heatmap|vivid|seatgeek/.test(l)) return "ticketflipping";
  if (/aidp|krendora|instagram|\big\b|reshare|dsers|autods/.test(l)) return "krendora";
  if (/home-budget|home-finance|herose|portfolio|enriquecodes|offer|tonge/.test(l)) return "personal";
  return "system";
}
function normState(s: string): string {
  const l = (s || "").toLowerCase();
  if (["delivered", "done", "completed", "complete", "finished"].includes(l)) return "done";
  if (["error", "failed", "cancelled", "canceled"].includes(l)) return "err";
  if (["idle", "waiting", "paused"].includes(l)) return "idle";
  return "running";
}

type LoadState = {
  status: any;
  model: any;
  spend: ControlSpendResponse | null;
  activity: ControlActivityResponse | null;
  zai: ControlZaiUsageResponse | null;
  vitals: ControlVitalsResponse | null;
  automations: ControlAutomationsResponse | null;
  attention: ControlAttentionResponse | null;
  graph: ControlKnowledgeGraphResponse | null;
  voice: ControlVoiceTranscriptsResponse | null;
};

export default function ControlCenterPage() {
  const { setTitle, setImmersive } = usePageHeader();
  const [d, setD] = useState<LoadState>({
    status: null,
    model: null,
    spend: null,
    activity: null,
    zai: null,
    vitals: null,
    automations: null,
    attention: null,
    graph: null,
    voice: null,
  });
  // The map is always shown; the voice orb now lives in its own dock (bottom-right).
  const [mode] = useState<"map" | "voice">("map");
  const [activeDom, setActiveDom] = useState("all");
  const [hoverDom, setHoverDom] = useState<string | null>(null);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [booted, setBooted] = useState(false);
  const [, setTick] = useState(0);
  const lastSync = useRef(Date.now());
  const [selTask, setSelTask] = useState<Task | null>(null);
  const [wt, setWt] = useState<{ task: Task; x: number; y: number } | null>(null);
  const autosAt = useRef(Date.now());
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [histLoading, setHistLoading] = useState(false);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const cpuHist = useRef<number[]>([]);
  const sparkRef = useRef<HTMLCanvasElement | null>(null);

  const load = async () => {
    const [status, model, spend, activity, zai, vitals, automations, attention, graph, voice] =
      await Promise.allSettled([
        api.getStatus(),
        api.getModelInfo(),
        api.getControlSpend(),
        api.getControlActivity(),
        api.getControlZaiUsage(),
        api.getControlVitals(),
        api.getControlAutomations(),
        api.getControlAttention(),
        api.getControlKnowledgeGraph(),
        api.getControlVoiceTranscripts(),
      ]);
    const val = (r: PromiseSettledResult<any>) => (r.status === "fulfilled" ? r.value : null);
    setD({
      status: val(status),
      model: val(model),
      spend: val(spend),
      activity: val(activity),
      zai: val(zai),
      vitals: val(vitals),
      automations: val(automations),
      attention: val(attention),
      graph: val(graph),
      voice: val(voice),
    });
    lastSync.current = Date.now();
    autosAt.current = Date.now();
  };

  useEffect(() => {
    setTitle("JARVIS Control Center");
    setImmersive(true);
    load();
    const id = window.setInterval(load, 20000);
    const clk = window.setInterval(() => setTick((t) => t + 1), 1000);
    // faster CPU sample for a live sparkline
    const vp = window.setInterval(async () => {
      try {
        const v = await api.getControlVitals();
        if (typeof v.cpu_pct === "number") {
          cpuHist.current.push(v.cpu_pct);
          if (cpuHist.current.length > 44) cpuHist.current.shift();
        }
        setD((prev) => ({ ...prev, vitals: v }));
        drawSpark();
      } catch {
        /* ignore */
      }
    }, 3000);
    return () => {
      window.clearInterval(id);
      window.clearInterval(clk);
      window.clearInterval(vp);
      setImmersive(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // boot sequence (once per session)
  useEffect(() => {
    let seen = false;
    try {
      seen = !!sessionStorage.getItem("jarvis_booted");
      sessionStorage.setItem("jarvis_booted", "1");
    } catch {
      /* ignore */
    }
    if (seen) {
      setBooted(true);
      return;
    }
    const t = window.setTimeout(() => setBooted(true), 1700);
    return () => window.clearTimeout(t);
  }, []);

  function drawSpark() {
    const c = sparkRef.current;
    if (!c) return;
    const g = c.getContext("2d");
    if (!g) return;
    const b = c.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (c.width !== b.width * dpr) {
      c.width = b.width * dpr;
      c.height = b.height * dpr;
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = b.width,
      H = b.height;
    g.clearRect(0, 0, W, H);
    const data = cpuHist.current;
    if (data.length < 2) return;
    g.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = (i / (data.length - 1)) * W,
        y = H - (data[i] / 100) * (H - 2) - 1;
      i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
    }
    const last = data[data.length - 1];
    const ly = H - (last / 100) * (H - 2) - 1;
    g.strokeStyle = "rgba(34,211,238,.85)";
    g.lineWidth = 1;
    g.stroke();
    g.lineTo(W, H);
    g.lineTo(0, H);
    g.closePath();
    g.fillStyle = "rgba(34,211,238,.10)";
    g.fill();
    g.fillStyle = "#22d3ee";
    g.beginPath();
    g.arc(W - 1, ly, 1.6, 0, Math.PI * 2);
    g.fill();
  }

  // ---- derived data ----
  const repos: MapRepo[] = useMemo(() => {
    if (d.graph && d.graph.available && d.graph.repos?.length) return d.graph.repos as MapRepo[];
    return FALLBACK_REPOS;
  }, [d.graph]);

  const tasks: Task[] = useMemo(() => {
    const out: Task[] = [];
    const act = d.activity;
    if (act) {
      for (const dg of (act.delegations as any[]) || []) {
        out.push({
          id: dg.id ?? `d-${out.length}`,
          goal: dg.goal ?? "task",
          kind: dg.kind === "agent" ? "agent" : dg.self ? "voice" : "agent",
          dom: domOf(dg.goal ?? ""),
          state: normState(dg.state),
          pct: dg.progress != null ? Math.round(dg.progress * 100) : null,
          ago: Math.max(0, Math.floor(dg.ago_seconds ?? 0)),
          now: dg.note || dg.state || "working",
        });
      }
      for (const s of (act.sessions as any[]) || []) {
        out.push({
          id: s.id ?? `s-${out.length}`,
          goal: s.title ?? "session",
          kind: s.source === "whatsapp" ? "voice" : "session",
          dom: domOf(s.title ?? ""),
          state: s.active ? "running" : "idle",
          pct: null,
          ago: Math.max(0, Math.floor(s.ago_seconds ?? 0)),
          now: `${s.source ?? "session"} · ${s.model || "model"} · ${s.messages ?? 0} msg`,
        });
      }
    }
    const RANK: Record<string, number> = { running: 0, err: 1, idle: 2, done: 3 };
    out.sort((a, b) => (RANK[a.state] ?? 9) - (RANK[b.state] ?? 9) || a.ago - b.ago);
    return out;
  }, [d.activity]);

  const filteredTasks = useMemo(
    () => tasks.filter((t) => activeDom === "all" || t.dom === activeDom),
    [tasks, activeDom],
  );

  const repoActivity = useMemo(() => {
    const m: Record<string, "running" | "err"> = {};
    for (const t of tasks) {
      if (t.state !== "running" && t.state !== "err") continue;
      const hit = repos.find((r) => t.goal.toLowerCase().includes(r.name.toLowerCase().split(" ")[0]));
      if (hit) {
        if (t.state === "err") m[hit.name] = "err";
        else if (m[hit.name] !== "err") m[hit.name] = "running";
      }
    }
    return m;
  }, [tasks, repos]);

  const alerts: ControlAttentionAlert[] = d.attention?.alerts ?? [];
  const critCount = d.attention?.critical ?? 0;
  const autos: ControlAutomation[] = d.automations?.items ?? [];
  const voiceTurns = d.voice?.available ? d.voice.turns : [];
  const gatewayRunning = Boolean(d.status?.gateway_running);
  const liveCount = filteredTasks.filter((t) => t.state === "running").length;
  const modelName = d.model?.model ?? d.model?.name ?? d.status?.model ?? "glm-5.3-flash";
  const vit = d.vitals;
  const zaiWindows = d.zai?.available ? d.zai.windows : [];
  const now = new Date();
  const syncedS = Math.floor((Date.now() - lastSync.current) / 1000);

  const mapTotals = repos.reduce((a, r) => a + (r.nodes || 0), 0);

  // ---- keyboard shortcuts ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Escape always dismisses overlays, even from within an input/textarea.
      if (e.key === "Escape") {
        setAlertsOpen(false);
        setSelTask(null);
        setDrawerOpen(false);
        return;
      }
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "a") setAlertsOpen((o) => !o);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Keep the conversation pinned to the latest message.
  useEffect(() => {
    const el = chatScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat, chatBusy, histLoading]);

  async function openTask(t: Task) {
    setSelTask(t);
    setChat([]);
    setHistLoading(true);
    try {
      const h = await api.getControlWorkHistory(t.id);
      const msgs: ChatMsg[] = [];
      for (const m of h.messages || []) {
        if (m.role === "user") {
          if (m.text) msgs.push({ r: "you", text: m.text });
        } else if (m.role === "tool") {
          msgs.push({ r: "tool", name: m.tool_name || "tool", text: m.text || "" });
        } else {
          if (m.text) msgs.push({ r: "a", text: m.text });
          for (const c of m.tool_calls || []) msgs.push({ r: "call", name: c.name, args: c.args });
        }
      }
      setChat(msgs.length ? msgs : [{ r: "a", text: `On “${t.goal}” — ${t.now}.` }]);
    } catch {
      setChat([{ r: "a", text: `On “${t.goal}” — ${t.now}.` }]);
    } finally {
      setHistLoading(false);
    }
  }
  async function sendChat() {
    const v = chatInput.trim();
    if (!v || !selTask || chatBusy) return;
    setChat((c) => [...c, { r: "you", text: v }]);
    setChatInput("");
    setChatBusy(true);
    const task = selTask;
    try {
      const res = await api.postControlWorkChat(task.id, v);
      setChat((c) => [...c, { r: "a", text: res.reply || "…" }]);
    } catch {
      setChat((c) => [...c, { r: "a", text: "I couldn't reach that thread — try again in a moment." }]);
    } finally {
      setChatBusy(false);
    }
  }

  const kindIcon = (k: string) =>
    k === "agent" ? <Bot className="kd" /> : k === "voice" ? <Mic className="kd" /> : <SquareTerminal className="kd" />;

  const mapHint =
    mode === "voice"
      ? "tap the orb to talk"
      : `drag to orbit · ${repos.length} repos · ${mapTotals.toLocaleString()} nodes indexed`;

  return (
    <div className={cn("cc", mode === "voice" && "voice", booted && "booted")}>
      <KnowledgeMap
        repos={repos}
        mode={mode}
        activeDom={activeDom}
        hoverDom={hoverDom}
        repoActivity={repoActivity}
        onHubClick={(dom) => setActiveDom((cur) => (cur === dom ? "all" : dom))}
        onOpenRepo={() => {}}
      />

      {/* Decorative centre node — the heart of the knowledge map. Pure UI, no
          interaction, so drag-to-orbit works even over the centre. */}
      <div className="mapcenter" aria-hidden="true">
        <span className="mc-ring" />
        <span className="mc-core">JARVIS</span>
      </div>
      <div className="stage-cap">
        <div className="phase">
          JARVIS · <b>knowledge map</b>
        </div>
        <div className="hint">{mapHint}</div>
      </div>

      {/* Top bar */}
      <header className="topbar">
        <button className="iconbtn" title="Menu" aria-label="Menu" onClick={() => setDrawerOpen(true)}>
          <Menu size={16} />
        </button>
        <div className="brand">
          <span className="dot" />
          <b>JARVIS</b>
          <small>Control Center</small>
        </div>
        <div className="spacer" />
        <div className="clock">
          <b>
            {p2(now.getHours())}:{p2(now.getMinutes())}:{p2(now.getSeconds())}
          </b>
          <span>
            {DAYS[now.getDay()]} {p2(now.getDate())} {MONS[now.getMonth()]}
          </span>
        </div>
        <span className={cn("pill", gatewayRunning ? "ok" : "bad")}>
          <span className="d pulse" />
          Gateway
        </span>
        <span className="pill ok" title="Desktop bridge">
          <span className="d" />
          Desktop
        </span>
        <button
          className={cn("iconbtn alertbtn", critCount > 0 && "crit has")}
          title="Attention"
          aria-label="Attention"
          onClick={() => setAlertsOpen((o) => !o)}
        >
          <Bell size={15} />
          {alerts.length > 0 && <span className="badge">{alerts.length}</span>}
        </button>
        <span className="synced">{syncedS < 3 ? "live" : `synced ${syncedS < 60 ? syncedS + "s" : Math.floor(syncedS / 60) + "m"} ago`}</span>
        <button className="iconbtn" title="Refresh" aria-label="Refresh" onClick={load}>
          <RefreshCw size={15} />
        </button>
      </header>

      {/* Domain filters */}
      <div className="filters glass">
        {DOMAINS.map((dm) => {
          const count = dm.id === "all" ? tasks.length : tasks.filter((t) => t.dom === dm.id).length;
          return (
            <button
              key={dm.id}
              className={cn("chip", activeDom === dm.id && "on")}
              onClick={() => setActiveDom(dm.id)}
            >
              {dm.id !== "all" && <span className="c" style={{ background: dm.color }} />}
              {dm.label} <span className="n">{count}</span>
            </button>
          );
        })}
      </div>

      {/* Left rail */}
      <div className="panel-left">
        <section className="card glass">
          <div className="model">
            <div style={{ minWidth: 0 }}>
              <div className="name" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {modelName}
              </div>
              <div className="prov">Coding plan · everyday</div>
            </div>
            <span className="pill ok" style={{ flex: "0 0 auto" }}>
              <span className="d" />
              Online
            </span>
          </div>
        </section>

        <section className="card glass">
          <div className="row-between">
            <h3>
              <Zap className="ico" size={14} /> LLM usage
            </h3>
          </div>
          <div className="usage-status">
            <span className="beacon" />
            <span className="big">{d.zai && d.zai.available === false ? "Suspended" : "Working"}</span>
          </div>
          {zaiWindows.map((w: any) => {
            const pct = Math.max(0, Math.min(100, w.percent ?? 0));
            const col = pct >= 90 ? "var(--rose)" : pct >= 70 ? "var(--amber)" : "var(--cyan)";
            return (
              <div className="cap" key={w.key}>
                <div className="lab">
                  <span style={{ textTransform: "capitalize" }}>{w.label}</span>
                  <span className="tnum">{resetLabel((w.reset_in_seconds ?? 0) - (Date.now() - lastSync.current) / 1000)}</span>
                </div>
                <div className="bar">
                  <i style={{ width: `${Math.max(2, pct)}%`, background: col }} />
                </div>
              </div>
            );
          })}
          {zaiWindows.length === 0 && <div style={{ fontSize: 10, color: "var(--fg-faint)" }}>usage unavailable</div>}
        </section>

        <section className="card glass">
          <div className="row-between" style={{ marginBottom: 9 }}>
            <h3>
              <Receipt className="ico" size={14} /> Expenses
            </h3>
            {d.spend?.expenses && (
              <span className="exp-total">
                ${(d.spend?.expenses?.monthly_total_usd ?? 0).toFixed(2)}
                <span>/mo</span>
              </span>
            )}
          </div>
          {(d.spend?.expenses?.items ?? []).map((e: any) => (
            <div className="exp-item" key={e.label}>
              <div>
                <div className="l">{e.label}</div>
                {e.eur != null && <div className="sub">€{e.eur.toFixed(2)} · box</div>}
              </div>
              <div className="v">${e.usd.toFixed(2)}</div>
            </div>
          ))}
          {d.spend?.usage?.available && (
            <div className="exp-item">
              <div>
                <div className="l">Fireworks</div>
                <div className="sub">metered backup</div>
              </div>
              <div className="v">${(d.spend?.usage?.total_usd ?? 0).toFixed(2)}</div>
            </div>
          )}
        </section>

        <section className="card glass">
          <div className="row-between">
            <h3>
              <Cpu className="ico" size={14} /> Core vitals
            </h3>
            <span className="vmeta">
              {vit?.nproc ?? 8} vCPU · {vit?.mem_total_mb ? Math.round(vit.mem_total_mb / 1024) : 15} GiB
            </span>
          </div>
          <div className="vrow">
            <span className="vk">CPU</span>
            <canvas className="vspark" ref={sparkRef} />
            <span className="vv">{vit?.cpu_pct != null ? Math.round(vit.cpu_pct) : "—"}%</span>
          </div>
          <div className="vrow">
            <span className="vk">MEM</span>
            <div className="vbar">
              <i style={{ width: `${vit?.mem_total_mb ? (vit.mem_used_mb! / vit.mem_total_mb) * 100 : 0}%` }} />
            </div>
            <span className="vv">
              {vit?.mem_used_mb != null ? (vit.mem_used_mb / 1024).toFixed(1) : "—"} / {vit?.mem_total_mb ? Math.round(vit.mem_total_mb / 1024) : 15}G
            </span>
          </div>
          <div className="vrow">
            <span className="vk">DISK</span>
            <div className="vbar">
              <i style={{ width: `${vit?.disk_total_gb ? (vit.disk_used_gb! / vit.disk_total_gb) * 100 : 0}%`, background: "var(--emerald)" }} />
            </div>
            <span className="vv">
              {vit?.disk_used_gb ?? "—"} / {vit?.disk_total_gb ?? "—"}G
            </span>
          </div>
          <div className="vfoot">
            <span>uptime {vit?.uptime_seconds ? agoLabel(vit.uptime_seconds) : "—"}</span>
            <span>load {vit?.load ? vit.load[0].toFixed(2) : "—"}</span>
          </div>
        </section>

        <section className="card glass" id="autoCard">
          <div className="row-between">
            <h3>
              <CalendarClock className="ico" size={14} /> Automations
            </h3>
            <span className="vmeta">
              {d.automations?.active ?? 0} active
              {(d.automations?.failing ?? 0) > 0 && <span style={{ color: "var(--rose)" }}> · {d.automations!.failing} failing</span>}
            </span>
          </div>
          <div className="sched-list">
            {autos.map((s, i) => {
              const elapsed = (Date.now() - autosAt.current) / 1000;
              const remaining = s.next_seconds != null ? s.next_seconds - elapsed : null;
              const right =
                s.status === "active" ? (remaining != null ? nextLabel(remaining) : s.cadence) : s.status === "failing" ? "failing" : "paused";
              return (
                <div className={cn("sched-row", s.status === "paused" && "off")} key={s.name + i}>
                  <span className="sc-dot" style={{ background: DCOLOR[s.domain] || "var(--fg)" }} title={s.domain} />
                  <div className="sc-mid">
                    <div className="sc-name">{s.name}</div>
                    <div className="sc-cad">{s.cadence}</div>
                  </div>
                  <div className={cn("sc-next", `st-${s.status}`)}>
                    <span className={cn("sc-sdot", `st-${s.status}`)} title={s.status} />
                    {right}
                  </div>
                </div>
              );
            })}
            {autos.length === 0 && <div style={{ fontSize: 10, color: "var(--fg-faint)", padding: "8px 4px" }}>no automations configured</div>}
          </div>
        </section>
      </div>

      {/* Voice transcripts — right of the automations block */}
      <section className="voicefeed glass">
        <div className="vf-h">
          <h3>
            <AudioLines className="ico" size={14} /> Voice transcript
          </h3>
          <span className={cn("pill", voiceTurns.length ? "ok" : "")}>
            <span className="d" />
            {voiceTurns.length ? "latest" : "idle"}
          </span>
        </div>
        <div className="vf-scroll">
          {voiceTurns.map((tn, i) => (
            <div className={cn("vf-turn", tn.role === "assistant" ? "j" : "u")} key={i}>
              <div className="vf-who">{tn.role === "assistant" ? "JARVIS" : "You"}</div>
              <div className="vf-text">{tn.text}</div>
            </div>
          ))}
          {voiceTurns.length === 0 && (
            <div className="vf-empty">No recent voice conversation. Tap the orb and speak.</div>
          )}
        </div>
      </section>

      {/* Current Work */}
      <section className="panel-right glass">
        <div className="hd">
          <h3>
            <Activity className="ico" size={15} /> Current Work
          </h3>
          <span className="pill ok">
            <span className="d pulse" />
            {liveCount} live
          </span>
        </div>
        <div className="scroll">
          {filteredTasks.map((t) => {
            const sc = t.state;
            const showBar = t.state !== "idle";
            const pct = t.pct;
            const barW = pct != null ? Math.max(5, pct) : t.state === "running" ? 42 : t.state === "done" ? 100 : 8;
            const stLabel = t.state === "err" ? "failed" : t.state === "idle" ? "idle" : t.state === "done" ? "done" : pct != null ? `${pct}%` : "live";
            return (
              <div
                className="task"
                key={t.id}
                onMouseEnter={(e) => {
                  setHoverDom(t.dom);
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setWt({ task: t, x: r.left - 12, y: r.top });
                }}
                onMouseLeave={() => {
                  setHoverDom(null);
                  setWt(null);
                }}
                onClick={() => openTask(t)}
              >
                <span className="lstripe" style={{ background: DCOLOR[t.dom] }} />
                <div className="mid">
                  <div className="goal">
                    {kindIcon(t.kind)}
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{t.goal}</span>
                  </div>
                  <div className="meta">
                    <span className={cn("sdot", `bg-${sc}`)} />
                    {t.kind} · {t.now}
                  </div>
                  {showBar && (
                    <div className="pbar">
                      {t.state === "running" ? (
                        <i className="live" style={{ width: `${barW}%` }} />
                      ) : (
                        <i style={{ width: `${barW}%`, background: t.state === "err" ? "var(--rose)" : t.state === "done" ? "var(--emerald)" : "var(--cyan)" }} />
                      )}
                    </div>
                  )}
                </div>
                <div className="right">
                  <span className="ago tnum">{agoLabel(t.ago)}</span>
                  <span className={cn("st", sc)}>{stLabel}</span>
                </div>
              </div>
            );
          })}
          {filteredTasks.length === 0 && (
            <div style={{ padding: 22, textAlign: "center", color: "var(--fg-faint)", fontSize: 12 }}>No work in this domain.</div>
          )}
        </div>
      </section>

      {/* Voice dock — the talking orb, under Current Work (bottom-right) */}
      <section className="voicedock glass">
        <VoiceConsole gatewayRunning={gatewayRunning} workCount={liveCount} />
      </section>

      {/* Current Work hover tooltip */}
      {wt && (
        <div
          className="tip worktip"
          style={{ left: wt.x, top: wt.y, opacity: 1, transform: "translateX(-100%)" }}
        >
          <div className="wt-h">
            <span className="wt-t">{wt.task.goal}</span>
            <span className={cn("st", wt.task.state)}>
              {wt.task.state === "err"
                ? "failed"
                : wt.task.state === "done"
                  ? "done"
                  : wt.task.state === "idle"
                    ? "idle"
                    : wt.task.pct != null
                      ? `${wt.task.pct}%`
                      : "live"}
            </span>
          </div>
          <div className="wt-now">
            <span className="lab">Now</span>
            <span className="val">{wt.task.now}</span>
          </div>
          <div className="wt-foot">
            <span>
              {wt.task.kind} · {wt.task.dom}
            </span>
            <span>updated {agoLabel(wt.task.ago)} ago</span>
          </div>
        </div>
      )}

      {/* Attention popover */}
      {alertsOpen && (
        <div className="alerts-pop glass">
          <div className="ap-h">
            Attention <span>{alerts.length}</span>
          </div>
          <div className="ap-list">
            {alerts.map((a, i) => (
              <button
                className={cn("ap-row", a.severity === "crit" ? "crit" : "info")}
                key={i}
                onClick={() => {
                  setAlertsOpen(false);
                  if (a.kind === "automation") {
                    const el = document.getElementById("autoCard");
                    if (el) {
                      el.classList.add("flash");
                      setTimeout(() => el.classList.remove("flash"), 1200);
                    }
                  } else {
                    const t = tasks.find((x) => x.goal === a.title);
                    if (t) openTask(t);
                  }
                }}
              >
                <span className="ap-dot" />
                <div>
                  <div className="ap-t">{a.title}</div>
                  <div className="ap-m">{a.msg}</div>
                </div>
              </button>
            ))}
            {alerts.length === 0 && <div className="ap-empty">All clear — nothing needs attention.</div>}
          </div>
        </div>
      )}

      {/* Per-task chat */}
      {selTask && (
        <section className="chatpanel glass">
          <div className="ch-h">
            <span className={cn("sdot", `bg-${selTask.state}`)} />
            <div className="tt">
              <div className="g">{selTask.goal}</div>
              <div className="s">
                {selTask.kind} · {selTask.dom}
              </div>
            </div>
            <button className="iconbtn" aria-label="Close" onClick={() => setSelTask(null)}>
              <X size={14} />
            </button>
          </div>
          <div className="ch-msgs" ref={chatScrollRef}>
            {histLoading && chat.length === 0 && (
              <div className="ch-loading">
                <span className="dots">
                  <i />
                  <i />
                  <i />
                </span>
                loading conversation…
              </div>
            )}
            {chat.map((m, i) => {
              if (m.r === "call") {
                return (
                  <div className="toolcall" key={i}>
                    <Wrench className="tc-ico" size={12} />
                    <span className="tc-name">{m.name}</span>
                    {m.args && <span className="tc-args">{m.args}</span>}
                  </div>
                );
              }
              if (m.r === "tool") {
                return (
                  <div className="toolresult" key={i}>
                    <div className="tr-h">
                      <CornerDownRight size={11} />
                      {m.name}
                    </div>
                    <div className="tr-body">{m.text}</div>
                  </div>
                );
              }
              return (
                <div className={cn("msg", m.r === "a" ? "agent" : "you")} key={i}>
                  <div className="who">{m.r === "a" ? <><span className="o" />JARVIS</> : "You"}</div>
                  {m.text}
                </div>
              );
            })}
            {chatBusy && (
              <div className="msg agent thinking">
                <div className="who">
                  <span className="o" />JARVIS
                </div>
                <span className="dots">
                  <i />
                  <i />
                  <i />
                </span>
              </div>
            )}
          </div>
          <div className="ch-in">
            <textarea
              rows={1}
              placeholder="Reply to this thread…"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendChat();
                }
              }}
            />
            <button className="send" aria-label="Send" onClick={sendChat} disabled={chatBusy}>
              <Send size={17} />
            </button>
          </div>
        </section>
      )}

      {/* Boot */}
      {!booted && (
        <div id="boot" onClick={() => setBooted(true)}>
          <div className="boot-ring" />
          <div className="boot-word">J·A·R·V·I·S</div>
          <div className="boot-sub">Mounting knowledge map…</div>
          <div className="boot-bar">
            <i style={{ width: "70%" }} />
          </div>
          <div className="boot-skip">click to skip</div>
        </div>
      )}

      {/* Drawer */}
      <div className={cn("scrim", drawerOpen && "on")} onClick={() => setDrawerOpen(false)} />
      <nav className={cn("drawer", drawerOpen && "on")} aria-label="Navigation">
        <div className="dh">
          <div className="brand">
            <span className="dot" />
            <b>JARVIS</b>
          </div>
          <button className="iconbtn" aria-label="Close" onClick={() => setDrawerOpen(false)}>
            <X size={15} />
          </button>
        </div>
        <div className="nav">
          {[
            ["Control Center", "/control"],
            ["Chat", "/chat"],
            ["Sessions", "/sessions"],
            ["Models", "/models"],
            ["Skills", "/skills"],
            ["Cron", "/cron"],
            ["Channels", "/channels"],
            ["Files", "/files"],
            ["Config", "/config"],
            ["System", "/system"],
          ].map(([label, href]) => (
            <a key={label} href={href} className={label === "Control Center" ? "on" : ""}>
              {label}
            </a>
          ))}
        </div>
      </nav>

      {/* FX */}
      <div className="fx-scan" />
      <div className="fx-vig" />
    </div>
  );
}
