import { useEffect, useRef } from "react";

// Sci-fi HUD orb for the voice console, drawn on a canvas: tick-marked outer
// ring, counter-rotating arc segments, a dashed ring, orbiting particles, a
// glowing pulsing core, a radar sweep while thinking/researching, and a
// circular waveform while listening/speaking. Colour shifts per phase
// (cyan calm → emerald listening → cyan thinking → amber researching →
// bright cyan speaking). Purely visual — pointer-events are off so the mic
// button above it stays clickable.

type OrbPhase = "idle" | "listening" | "thinking" | "speaking" | "error";
type Pal = { core: string; glow: string; dim: number };
type Particle = { a: number; r: number; s: number; sz: number; ph: number };

const PAL: Record<string, Pal> = {
  idle: { core: "#22d3ee", glow: "52,211,238", dim: 0.55 },
  listening: { core: "#34d399", glow: "52,211,153", dim: 1 },
  thinking: { core: "#38bdf8", glow: "56,189,248", dim: 1 },
  researching: { core: "#fbbf24", glow: "251,191,36", dim: 1 },
  speaking: { core: "#67e8f9", glow: "103,232,249", dim: 1 },
  error: { core: "#fb7185", glow: "251,113,133", dim: 0.7 },
};

// Pre-parsed RGB palette so the draw loop can smoothly crossfade colours
// between states instead of snapping.
type PalRGB = { core: [number, number, number]; glow: [number, number, number]; dim: number };
const hexToRgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const PAL_RGB: Record<string, PalRGB> = Object.fromEntries(
  Object.entries(PAL).map(([k, v]) => [
    k,
    { core: hexToRgb(v.core), glow: v.glow.split(",").map(Number) as [number, number, number], dim: v.dim },
  ]),
);

export function VoiceOrbCanvas({
  phase,
  researching,
  getLevel,
}: {
  phase: OrbPhase;
  researching: boolean;
  getLevel?: () => number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const phaseRef = useRef<OrbPhase>(phase);
  const researchRef = useRef<boolean>(researching);
  const getLevelRef = useRef<(() => number) | undefined>(getLevel);
  phaseRef.current = phase;
  researchRef.current = researching;
  getLevelRef.current = getLevel;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let W = 0;
    let H = 0;
    let DPR = 1;
    let level = 0;
    let lastPhase: OrbPhase = phaseRef.current;
    let lastIdlePing = typeof performance !== "undefined" ? performance.now() : 0;
    const cur = {
      core: [...PAL_RGB.idle.core] as [number, number, number],
      glow: [...PAL_RGB.idle.glow] as [number, number, number],
      dim: PAL_RGB.idle.dim,
    };
    const bursts: number[] = []; // start-times of expanding activation rings
    const parts: Particle[] = Array.from({ length: 30 }, () => ({
      a: Math.random() * Math.PI * 2,
      r: 0.5 + Math.random() * 0.46,
      s: (0.15 + Math.random() * 0.5) * (Math.random() < 0.5 ? -1 : 1),
      sz: 0.6 + Math.random() * 1.6,
      ph: Math.random() * Math.PI * 2,
    }));

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      DPR = Math.min(window.devicePixelRatio || 1, 2);
      W = Math.max(1, Math.round(r.width * DPR));
      H = Math.max(1, Math.round(r.height * DPR));
      canvas.width = W;
      canvas.height = H;
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    // Honor prefers-reduced-motion: calm the motion-heavy effects.
    const mq =
      typeof window !== "undefined" && window.matchMedia
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;
    let reduced = mq?.matches ?? false;
    const onMq = () => {
      reduced = mq?.matches ?? false;
    };
    mq?.addEventListener?.("change", onMq);

    const hexA = (hex: string, a: number) => {
      const n = parseInt(hex.slice(1), 16);
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
    };
    const ring = (cx: number, cy: number, rad: number, rgb: string, alpha: number, lw: number) => {
      ctx.beginPath();
      ctx.arc(cx, cy, rad, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${rgb},${alpha})`;
      ctx.lineWidth = lw;
      ctx.stroke();
    };

    const draw = (now: number) => {
      // Skip rendering when the orb isn't visible (the hidden desktop/mobile
      // breakpoint has display:none → offsetParent null; a backgrounded tab is
      // document.hidden). Keeps the loop alive cheaply and resumes on show —
      // saves CPU/battery on the always-on dashboard.
      if (canvas.offsetParent === null || document.hidden) {
        raf = requestAnimationFrame(draw);
        return;
      }
      const t = now / 1000;
      const rawPhase = phaseRef.current;
      if (rawPhase !== lastPhase) {
        if (!reduced && (rawPhase === "speaking" || rawPhase === "listening")) bursts.push(now);
        lastPhase = rawPhase;
      }
      // gentle "ready" heartbeat while idle — a subtle ripple every few seconds
      if (rawPhase === "idle" && !reduced && now - lastIdlePing > 4600) {
        bursts.push(now);
        lastIdlePing = now;
      }
      const isResearch = researchRef.current && rawPhase === "thinking";
      const key = isResearch ? "researching" : rawPhase;
      // Ease the live palette toward the target so state changes crossfade.
      const tgt = PAL_RGB[key] || PAL_RGB.idle;
      const L = 0.1;
      for (let i = 0; i < 3; i++) {
        cur.core[i] += (tgt.core[i] - cur.core[i]) * L;
        cur.glow[i] += (tgt.glow[i] - cur.glow[i]) * L;
      }
      cur.dim += (tgt.dim - cur.dim) * L;
      const hx = (v: number) => Math.round(v).toString(16).padStart(2, "0");
      const p: Pal = {
        core: `#${hx(cur.core[0])}${hx(cur.core[1])}${hx(cur.core[2])}`,
        glow: `${Math.round(cur.glow[0])},${Math.round(cur.glow[1])},${Math.round(cur.glow[2])}`,
        dim: cur.dim,
      };
      const active = rawPhase !== "idle" && rawPhase !== "error";
      const think = rawPhase === "thinking";
      const wave = rawPhase === "listening" || rawPhase === "speaking";
      const real = getLevelRef.current ? getLevelRef.current() : 0;
      let target: number;
      if (rawPhase === "speaking") {
        target = Math.max(0.12, real); // driven by JARVIS's real voice
      } else if (rawPhase === "listening") {
        const sim = 0.26 + 0.18 * (0.5 + 0.5 * Math.sin(t * 6));
        target = Math.max(sim, real * 1.25); // reacts to the user's voice; gentle base otherwise
      } else target = active ? 0.18 : 0.05;
      level += (target - level) * 0.2;

      ctx.clearRect(0, 0, W, H);
      const cx = W / 2;
      const cy = H / 2;
      const R = Math.min(W, H) * 0.44;
      const pulse = 0.5 + 0.5 * Math.sin(t * (isResearch ? 3.2 : 1.6));

      // background glow
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.15);
      g.addColorStop(0, `rgba(${p.glow},${(0.16 + 0.1 * pulse) * p.dim})`);
      g.addColorStop(0.45, `rgba(${p.glow},${0.05 * p.dim})`);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.15, 0, Math.PI * 2);
      ctx.fill();

      ctx.save();

      // outer HUD ring + tick marks
      ring(cx, cy, R, p.glow, 0.28 * p.dim, 1 * DPR);
      for (let i = 0; i < 72; i++) {
        const ang = (i / 72) * Math.PI * 2 + t * 0.02;
        const long = i % 6 === 0;
        const r1 = R * (long ? 0.955 : 0.972);
        const r2 = R;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1);
        ctx.lineTo(cx + Math.cos(ang) * r2, cy + Math.sin(ang) * r2);
        ctx.strokeStyle = `rgba(${p.glow},${(long ? 0.5 : 0.22) * p.dim})`;
        ctx.lineWidth = (long ? 1.4 : 0.8) * DPR;
        ctx.stroke();
      }

      // rotating arc segments
      ctx.shadowBlur = 8 * DPR;
      ctx.shadowColor = hexA(p.core, 0.6);
      const arcs = [
        { r: 0.9, sp: 0.35, st: 0.2, len: 1.4, w: 2.2 },
        { r: 0.78, sp: -0.55, st: 2.4, len: 1.0, w: 1.6 },
        { r: 0.63, sp: 0.8, st: 4.0, len: 0.7, w: 1.4 },
      ];
      ctx.lineCap = "round";
      for (const a of arcs) {
        const base = t * a.sp * (isResearch ? 1.8 : 1);
        ctx.beginPath();
        ctx.arc(cx, cy, R * a.r, base + a.st, base + a.st + a.len);
        ctx.strokeStyle = `rgba(${p.glow},${0.75 * p.dim})`;
        ctx.lineWidth = a.w * DPR;
        ctx.stroke();
      }
      ctx.shadowBlur = 0;

      // dashed rotating ring
      ctx.setLineDash([2 * DPR, 7 * DPR]);
      ctx.lineDashOffset = -t * 20 * DPR;
      ring(cx, cy, R * 0.71, p.glow, 0.35 * p.dim, 1 * DPR);
      ctx.setLineDash([]);

      // orbiting particles
      const pspeed = isResearch ? 2.2 : active ? 1 : 0.4;
      for (const pt of parts) {
        const ang = pt.a + t * pt.s * pspeed;
        const rr = R * pt.r;
        const x = cx + Math.cos(ang) * rr;
        const y = cy + Math.sin(ang) * rr;
        const tw = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(t * 2.5 * pspeed + pt.ph));
        ctx.beginPath();
        ctx.arc(x, y, pt.sz * DPR * (active ? 1 : 0.8), 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${p.glow},${tw * 0.8 * p.dim})`;
        ctx.fill();
      }

      // radar sweep while thinking / researching
      if (think && !reduced) {
        const sweepAng = t * (isResearch ? 2.6 : 1.4);
        const steps = 42;
        for (let i = 0; i < steps; i++) {
          const a0 = sweepAng - i * 0.03;
          const al = (1 - i / steps) * 0.16 * p.dim;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(cx + Math.cos(a0) * R * 0.9, cy + Math.sin(a0) * R * 0.9);
          ctx.strokeStyle = `rgba(${p.glow},${al})`;
          ctx.lineWidth = 2 * DPR;
          ctx.stroke();
        }
        // data-ingest: particles spiral inward to the core (JARVIS processing)
        const ING = 14;
        for (let i = 0; i < ING; i++) {
          const prog = (t * (isResearch ? 0.95 : 0.62) + i / ING) % 1;
          const rad = R * (0.92 - prog * 0.66);
          const ang = (i / ING) * Math.PI * 2 + prog * (isResearch ? 3.4 : 2.6);
          const a = Math.sin(prog * Math.PI) * 0.75 * p.dim;
          ctx.beginPath();
          ctx.arc(cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad, 1.5 * DPR, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${p.glow},${a})`;
          ctx.fill();
        }
      }

      // circular waveform while listening / speaking
      if (wave) {
        const bars = 72;
        const rw = R * 0.5;
        ctx.beginPath();
        for (let i = 0; i <= bars; i++) {
          const ang = (i / bars) * Math.PI * 2;
          const h =
            rw +
            (Math.sin(i * 0.7 + t * 6) * 0.5 + 0.5) * R * 0.14 * level +
            Math.sin(i * 2.3 - t * 4) * R * 0.03 * level;
          const x = cx + Math.cos(ang) * h;
          const y = cy + Math.sin(ang) * h;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.strokeStyle = `rgba(${p.glow},0.7)`;
        ctx.lineWidth = 1.6 * DPR;
        ctx.shadowBlur = 10 * DPR;
        ctx.shadowColor = hexA(p.core, 0.7);
        ctx.stroke();
        ctx.shadowBlur = 0;
      }

      // core
      const coreR = R * (0.3 + 0.03 * pulse + 0.05 * level);
      const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
      cg.addColorStop(0, `rgba(255,255,255,${Math.min(1, 0.5 + 0.4 * level) * p.dim})`);
      cg.addColorStop(0.35, hexA(p.core, 0.9 * p.dim));
      cg.addColorStop(1, `rgba(${p.glow},0)`);
      ctx.shadowBlur = 30 * DPR;
      ctx.shadowColor = hexA(p.core, 0.8);
      ctx.beginPath();
      ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
      ctx.fillStyle = cg;
      ctx.fill();
      ring(cx, cy, coreR * 1.25, p.glow, 0.4 * p.dim, 1 * DPR);

      // activation pulse — expanding ring on entering listening/speaking
      for (let i = bursts.length - 1; i >= 0; i--) {
        const age = (now - bursts[i]) / 900;
        if (age >= 1) {
          bursts.splice(i, 1);
          continue;
        }
        const eased = 1 - (1 - age) * (1 - age); // ease-out
        ring(cx, cy, R * (0.28 + eased * 0.98), p.glow, (1 - age) * 0.55 * p.dim, 2 * DPR);
      }
      ctx.restore();

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      mq?.removeEventListener?.("change", onMq);
    };
  }, []);

  return <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />;
}

export default VoiceOrbCanvas;
