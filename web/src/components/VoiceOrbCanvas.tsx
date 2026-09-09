import { useEffect, useRef } from "react";

// Sci-fi HUD orb for the voice console, drawn on a canvas as a genuine 3D
// sphere: a lit, shaded globe with depth-sorted latitude/longitude wireframe
// (front bright, back dim → reads as solid + rotating), a directional
// specular highlight, a back-lit rim, orbiters that pass in front of and
// behind the sphere (depth-occluded), a reactive equator "energy ring" while
// listening/speaking, and a data-ingest spiral while thinking. Colour shifts
// per phase (cyan calm → emerald listening → cyan thinking → amber researching
// → bright cyan speaking). Purely visual — pointer-events are off so the mic
// button above it stays clickable.

type OrbPhase = "idle" | "listening" | "thinking" | "speaking" | "error";
type Pal = { core: string; glow: string; dim: number };
// A 3D orbiter: node (ascending node around Y), inc (orbit inclination),
// orad (orbit radius factor), s (angular speed), ph (phase), sz (base size).
type Orbiter = { node: number; inc: number; orad: number; s: number; ph: number; sz: number };

const PAL: Record<string, Pal> = {
  idle: { core: "#22d3ee", glow: "52,211,238", dim: 0.74 },
  listening: { core: "#34d399", glow: "52,211,153", dim: 1 },
  thinking: { core: "#38bdf8", glow: "56,189,248", dim: 1 },
  researching: { core: "#fbbf24", glow: "251,191,36", dim: 1 },
  speaking: { core: "#67e8f9", glow: "103,232,249", dim: 1 },
  error: { core: "#fb7185", glow: "251,113,133", dim: 0.8 },
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

// Fixed scene orientation + light. The globe spins about Y; the whole scene is
// tilted about X so we look slightly down onto it. Light comes from the
// upper-left-front and is FIXED in screen space (it does not rotate with the
// globe), which is what makes the shading read as a solid lit ball.
const VIEW_TILT = 0.42;
const LIGHT: [number, number, number] = (() => {
  const v: [number, number, number] = [-0.5, -0.62, 0.6];
  const m = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / m, v[1] / m, v[2] / m];
})();

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
    let spin = 0;
    let lastNow = typeof performance !== "undefined" ? performance.now() : 0;
    let lastPhase: OrbPhase = phaseRef.current;
    let lastIdlePing = lastNow;
    const cur = {
      core: [...PAL_RGB.idle.core] as [number, number, number],
      glow: [...PAL_RGB.idle.glow] as [number, number, number],
      dim: PAL_RGB.idle.dim,
    };
    const bursts: number[] = []; // start-times of expanding activation rings
    const orbiters: Orbiter[] = Array.from({ length: 16 }, () => ({
      node: Math.random() * Math.PI * 2,
      inc: (Math.random() - 0.5) * 1.7,
      orad: 1.12 + Math.random() * 0.34,
      s: (0.3 + Math.random() * 0.6) * (Math.random() < 0.5 ? -1 : 1),
      ph: Math.random() * Math.PI * 2,
      sz: 0.9 + Math.random() * 1.7,
    }));

    // Sample angles for the wireframe loops (reused every frame).
    const SAMPLES = 46;
    const ANG: number[] = Array.from({ length: SAMPLES + 1 }, (_, i) => (i / SAMPLES) * Math.PI * 2);
    const LATS = [-58, -29, 0, 29, 58].map((d) => (d * Math.PI) / 180); // parallels
    const LONS = [0, 30, 60, 90, 120, 150].map((d) => (d * Math.PI) / 180); // meridians

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

    const cosT = Math.cos(VIEW_TILT);
    const sinT = Math.sin(VIEW_TILT);

    // Rotate a unit-sphere point by the current spin (about Y) then the fixed
    // view tilt (about X). Returns [screenX-offset, screenY-offset, depthZ] in
    // unit space (multiply by R for pixels). depthZ>0 faces the viewer.
    const project = (x: number, y: number, z: number, sp: number): [number, number, number] => {
      const cs = Math.cos(sp);
      const sn = Math.sin(sp);
      const x1 = x * cs + z * sn;
      const z1 = -x * sn + z * cs;
      const y2 = y * cosT - z1 * sinT;
      const z2 = y * sinT + z1 * cosT;
      return [x1, y2, z2];
    };

    const draw = (now: number) => {
      // Skip rendering when the orb isn't visible (hidden breakpoint →
      // offsetParent null; backgrounded tab → document.hidden). Keeps the loop
      // alive cheaply and resumes on show.
      if (canvas.offsetParent === null || document.hidden) {
        lastNow = now;
        raf = requestAnimationFrame(draw);
        return;
      }
      const dt = Math.min(0.05, Math.max(0, (now - lastNow) / 1000));
      lastNow = now;
      const t = now / 1000;
      const rawPhase = phaseRef.current;
      if (rawPhase !== lastPhase) {
        if (!reduced && (rawPhase === "speaking" || rawPhase === "listening")) bursts.push(now);
        lastPhase = rawPhase;
      }
      if (rawPhase === "idle" && !reduced && now - lastIdlePing > 4600) {
        bursts.push(now);
        lastIdlePing = now;
      }
      const isResearch = researchRef.current && rawPhase === "thinking";
      const key = isResearch ? "researching" : rawPhase;
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
        target = Math.max(0.12, real);
      } else if (rawPhase === "listening") {
        const sim = 0.26 + 0.18 * (0.5 + 0.5 * Math.sin(t * 6));
        target = Math.max(sim, real * 1.25);
      } else target = active ? 0.18 : 0.05;
      level += (target - level) * 0.2;

      // advance the globe spin (frame-rate independent)
      const spinSpeed = reduced ? 0.05 : isResearch ? 0.62 : think ? 0.36 : active ? 0.24 : 0.13;
      spin += dt * spinSpeed;

      ctx.clearRect(0, 0, W, H);
      const cx = W / 2;
      const cy = H / 2;
      const R = Math.min(W, H) * 0.4 * (1 + 0.02 * Math.sin(t * 1.6) + 0.04 * level);
      const pulse = 0.5 + 0.5 * Math.sin(t * (isResearch ? 3.2 : 1.6));
      const lightAng = Math.atan2(-LIGHT[1], -LIGHT[0]); // screen angle of the shadow side

      // ── atmospheric glow ─────────────────────────────────────────────
      const g = ctx.createRadialGradient(cx, cy, R * 0.6, cx, cy, R * 1.7);
      g.addColorStop(0, `rgba(${p.glow},${(0.2 + 0.12 * pulse) * p.dim})`);
      g.addColorStop(0.5, `rgba(${p.glow},${0.06 * p.dim})`);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.7, 0, Math.PI * 2);
      ctx.fill();

      // ── subtle outer HUD frame (flat, frames the sphere) ─────────────
      ctx.strokeStyle = `rgba(${p.glow},${0.18 * p.dim})`;
      ctx.lineWidth = 1 * DPR;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.28, 0, Math.PI * 2);
      ctx.stroke();
      for (let i = 0; i < 60; i++) {
        const ang = (i / 60) * Math.PI * 2 - t * 0.04;
        const long = i % 5 === 0;
        const r1 = R * 1.28;
        const r2 = R * (long ? 1.33 : 1.31);
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1);
        ctx.lineTo(cx + Math.cos(ang) * r2, cy + Math.sin(ang) * r2);
        ctx.strokeStyle = `rgba(${p.glow},${(long ? 0.4 : 0.16) * p.dim})`;
        ctx.lineWidth = (long ? 1.3 : 0.7) * DPR;
        ctx.stroke();
      }
      // two counter-rotating containment arcs
      ctx.lineCap = "round";
      for (const a of [
        { r: 1.4, sp: 0.28, st: 0.2, len: 1.5, w: 2 },
        { r: 1.46, sp: -0.42, st: 3.1, len: 0.9, w: 1.4 },
      ]) {
        const base = t * a.sp * (isResearch ? 1.8 : 1);
        ctx.beginPath();
        ctx.arc(cx, cy, R * a.r, base + a.st, base + a.st + a.len);
        ctx.strokeStyle = `rgba(${p.glow},${0.55 * p.dim})`;
        ctx.lineWidth = a.w * DPR;
        ctx.stroke();
      }

      // ── orbiters BEHIND the sphere (depth < 0) ───────────────────────
      const drawOrbiter = (o: Orbiter, back: boolean) => {
        const w = o.ph + t * o.s * (isResearch ? 2 : active ? 1.15 : 0.55);
        // point on orbit circle, tilted by inclination then node, in world space
        const bx = Math.cos(w) * o.orad;
        const bz = Math.sin(w) * o.orad;
        const ci = Math.cos(o.inc);
        const si = Math.sin(o.inc);
        const wy = bz * si;
        const wz = bz * ci;
        const cn = Math.cos(o.node);
        const sn2 = Math.sin(o.node);
        const wx = bx * cn + wz * sn2;
        const wz2 = -bx * sn2 + wz * cn;
        const [px, py, pz] = project(wx, wy, wz2, 0);
        if (back ? pz >= 0 : pz < 0) return;
        const sx = cx + px * R;
        const sy = cy + py * R;
        // occlusion: a back orbiter inside the silhouette is hidden by the ball
        const rr = Math.hypot(px, py);
        if (pz < 0 && rr < 0.99) return;
        const depth = (pz + 1) / 2; // 0 back … 1 front
        const sz = o.sz * DPR * (0.55 + 0.75 * depth);
        const a = (0.25 + 0.7 * depth) * p.dim;
        ctx.beginPath();
        ctx.arc(sx, sy, sz, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${p.glow},${a})`;
        if (depth > 0.6) {
          ctx.shadowBlur = 6 * DPR;
          ctx.shadowColor = hexA(p.core, 0.7);
        }
        ctx.fill();
        ctx.shadowBlur = 0;
      };
      for (const o of orbiters) drawOrbiter(o, true);

      // ── sphere body: directional shading (lit upper-left) ────────────
      const litx = cx + LIGHT[0] * R * 0.55;
      const lity = cy + LIGHT[1] * R * 0.55;
      const body = ctx.createRadialGradient(litx, lity, R * 0.04, cx, cy, R * 1.02);
      body.addColorStop(0, `rgba(255,255,255,${0.9 * p.dim})`);
      body.addColorStop(0.16, hexA(p.core, 0.92 * p.dim));
      body.addColorStop(0.5, `rgba(${p.glow},${0.36 * p.dim})`);
      body.addColorStop(0.86, `rgba(${p.glow},${0.12 * p.dim})`);
      body.addColorStop(1, `rgba(2,9,14,${0.66 * p.dim})`);
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fillStyle = body;
      ctx.fill();

      // ── wireframe globe (front hemisphere, depth-shaded) ─────────────
      const rgb = p.glow;
      ctx.lineCap = "round";
      const seg = (x0: number, y0: number, x1: number, y1: number, a: number, lw: number) => {
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.strokeStyle = `rgba(${rgb},${a})`;
        ctx.lineWidth = lw;
        ctx.stroke();
      };
      ctx.shadowBlur = 5 * DPR;
      ctx.shadowColor = hexA(p.core, 0.5);
      // parallels
      for (const lat of LATS) {
        const cphi = Math.cos(lat);
        const sphi = Math.sin(lat);
        let prev: [number, number, number] | null = null;
        for (let i = 0; i <= SAMPLES; i++) {
          const th = ANG[i];
          const pt = project(cphi * Math.cos(th), sphi, cphi * Math.sin(th), spin);
          if (prev) {
            const z = (pt[2] + prev[2]) / 2;
            if (z > -0.12) {
              const a = (0.08 + 0.5 * Math.max(0, z)) * p.dim;
              seg(cx + prev[0] * R, cy + prev[1] * R, cx + pt[0] * R, cy + pt[1] * R, a, (lat === 0 ? 1.5 : 1) * DPR);
            }
          }
          prev = pt;
        }
      }
      // meridians (full great circles through the poles)
      for (const lon of LONS) {
        const clon = Math.cos(lon);
        const slon = Math.sin(lon);
        let prev: [number, number, number] | null = null;
        for (let i = 0; i <= SAMPLES; i++) {
          const b = ANG[i];
          const sb = Math.sin(b);
          const pt = project(sb * clon, Math.cos(b), sb * slon, spin);
          if (prev) {
            const z = (pt[2] + prev[2]) / 2;
            if (z > -0.12) {
              const a = (0.07 + 0.46 * Math.max(0, z)) * p.dim;
              seg(cx + prev[0] * R, cy + prev[1] * R, cx + pt[0] * R, cy + pt[1] * R, a, 1 * DPR);
            }
          }
          prev = pt;
        }
      }
      ctx.shadowBlur = 0;

      // ── reactive equator energy ring while listening / speaking ──────
      if (wave) {
        ctx.beginPath();
        let started = false;
        for (let i = 0; i <= SAMPLES; i++) {
          const th = ANG[i];
          const bulge = 1 + (Math.sin(th * 6 + t * 7) * 0.5 + 0.5) * 0.12 * level + Math.sin(th * 3 - t * 5) * 0.03 * level;
          const pt = project(Math.cos(th) * bulge, 0, Math.sin(th) * bulge, spin);
          const sx = cx + pt[0] * R;
          const sy = cy + pt[1] * R;
          if (pt[2] > -0.05) {
            if (!started) {
              ctx.moveTo(sx, sy);
              started = true;
            } else ctx.lineTo(sx, sy);
          } else started = false;
        }
        ctx.strokeStyle = `rgba(${rgb},${0.8 * p.dim})`;
        ctx.lineWidth = 1.8 * DPR;
        ctx.shadowBlur = 10 * DPR;
        ctx.shadowColor = hexA(p.core, 0.8);
        ctx.stroke();
        ctx.shadowBlur = 0;
      }

      // ── data-ingest spiral while thinking / researching ──────────────
      if (think && !reduced) {
        const ING = 16;
        for (let i = 0; i < ING; i++) {
          const prog = (t * (isResearch ? 0.95 : 0.62) + i / ING) % 1;
          const rad = 1.25 - prog * 1.05;
          const ang = (i / ING) * Math.PI * 2 + prog * (isResearch ? 3.4 : 2.6);
          const pt = project(Math.cos(ang) * rad, (0.5 - prog) * 0.5, Math.sin(ang) * rad, spin);
          const a = Math.sin(prog * Math.PI) * 0.7 * p.dim * (pt[2] > 0 ? 1 : 0.4);
          ctx.beginPath();
          ctx.arc(cx + pt[0] * R, cy + pt[1] * R, 1.6 * DPR, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${rgb},${a})`;
          ctx.fill();
        }
      }

      // ── specular highlight ───────────────────────────────────────────
      const spec = ctx.createRadialGradient(litx, lity, 0, litx, lity, R * 0.42);
      spec.addColorStop(0, `rgba(255,255,255,${0.5 * p.dim})`);
      spec.addColorStop(1, "rgba(255,255,255,0)");
      ctx.beginPath();
      ctx.arc(litx, lity, R * 0.42, 0, Math.PI * 2);
      ctx.fillStyle = spec;
      ctx.fill();

      // ── back-lit rim (fresnel crescent on the shadow edge) ───────────
      ctx.beginPath();
      ctx.arc(cx, cy, R * 0.985, lightAng - 1.15, lightAng + 1.15);
      ctx.strokeStyle = `rgba(${rgb},${0.55 * p.dim})`;
      ctx.lineWidth = 2 * DPR;
      ctx.shadowBlur = 12 * DPR;
      ctx.shadowColor = hexA(p.core, 0.85);
      ctx.stroke();
      ctx.shadowBlur = 0;
      // crisp terminator/limb line all the way round
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${rgb},${0.32 * p.dim})`;
      ctx.lineWidth = 1 * DPR;
      ctx.stroke();

      // ── orbiters IN FRONT of the sphere (depth >= 0) ─────────────────
      for (const o of orbiters) drawOrbiter(o, false);

      // ── activation pulse — expanding ring on entering listening/speaking
      for (let i = bursts.length - 1; i >= 0; i--) {
        const age = (now - bursts[i]) / 900;
        if (age >= 1) {
          bursts.splice(i, 1);
          continue;
        }
        const eased = 1 - (1 - age) * (1 - age);
        ctx.beginPath();
        ctx.arc(cx, cy, R * (1 + eased * 0.4), 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${rgb},${(1 - age) * 0.5 * p.dim})`;
        ctx.lineWidth = 2 * DPR;
        ctx.stroke();
      }

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
