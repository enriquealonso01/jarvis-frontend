import { useEffect, useRef } from "react";

// 3D knowledge map (ported from the JARVIS Control Center mockup engine).
// Hand-rolled canvas 2.5D: perspective-projected repo constellation grouped by
// domain, a rotating wireframe globe + orbiters around the (separately drawn)
// centre orb, depth fog, drag-to-orbit, hover reticle, hub-click-to-filter, and
// live activity pulses. Matches the voice orb's aesthetic; no 3D library.

export interface MapRepo {
  name: string;
  domain: string;
  nodes: number;
  edges: number;
  top?: string;
  concepts?: string[];
}

type Activity = Record<string, "running" | "err">;

const DCOLOR: Record<string, string> = {
  system: "#a78bfa",
  krendora: "#22d3ee",
  ticketflipping: "#fbbf24",
  personal: "#34d399",
};
const DORDER = ["system", "krendora", "ticketflipping", "personal"];
const TAU = Math.PI * 2;
const RHUB = 192,
  CAGE_R = 152,
  ROUTER = 272,
  CAMZ = 520;

function mulberry32(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const norm = (v: number[]) => {
  const m = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / m, v[1] / m, v[2] / m];
};
const cross = (a: number[], b: number[]) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const hexTri = (h: string) => {
  h = h.replace("#", "");
  const n = parseInt(h, 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
};
const HUBDIR: Record<string, number[]> = {
  system: [0, 1, 0],
  ticketflipping: [0.94, -0.34, 0],
  krendora: [-0.47, -0.34, 0.82],
  personal: [-0.47, -0.34, -0.82],
};

interface Node {
  x: number;
  y: number;
  z: number;
  type: "core" | "hub" | "repo" | "sat";
  dom?: string;
  col?: string;
  repo?: MapRepo;
  base?: number;
  _p?: number[];
}

export interface KnowledgeMapProps {
  repos: MapRepo[];
  mode: "map" | "voice";
  activeDom: string;
  hoverDom: string | null;
  repoActivity: Activity;
  onHubClick: (dom: string) => void;
  onOpenRepo: (repo: MapRepo | null) => void;
}

export function KnowledgeMap(props: KnowledgeMapProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const detailRef = useRef<HTMLDivElement | null>(null);
  const p = useRef(props);
  p.current = props;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const g = canvas.getContext("2d");
    if (!g) return;
    const maptip = tipRef.current!;
    const nodedetail = detailRef.current!;
    let MW = 0,
      MH = 0,
      MDPR = 1;
    let raf = 0;

    // ---- build the constellation from the current repos ----
    let nodes: Node[] = [];
    let edges: { a: number; b: number; dom?: string; w: number }[] = [];
    let stars: { x: number; y: number; z: number; tw: number }[] = [];
    let orbiters: {
      u: number[];
      v: number[];
      r: number;
      sp: number;
      ph: number;
      col: string;
      sz: number;
      trail: number[][];
    }[] = [];
    const rng = mulberry32(20260908);

    function build() {
      nodes = [];
      edges = [];
      nodes.push({ x: 0, y: 0, z: 0, type: "core" });
      const repos = p.current.repos;
      DORDER.forEach((dom) => {
        const d = norm(HUBDIR[dom]);
        const hub: Node = {
          x: d[0] * RHUB,
          y: d[1] * RHUB,
          z: d[2] * RHUB,
          type: "hub",
          dom,
          col: DCOLOR[dom],
        };
        const hi = nodes.push(hub) - 1;
        edges.push({ a: 0, b: hi, dom, w: 1 });
        const up = Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
        const u = norm(cross(d, up)),
          v = norm(cross(d, u));
        const reps = repos.filter((r) => r.domain === dom);
        reps.forEach((r, i) => {
          const ang = (i / Math.max(1, reps.length)) * TAU + rng() * 0.6,
            rad = 48 + rng() * 30,
            jit = (rng() - 0.5) * 60;
          const px = hub.x + u[0] * Math.cos(ang) * rad + v[0] * Math.sin(ang) * rad + d[0] * jit;
          const py = hub.y + u[1] * Math.cos(ang) * rad + v[1] * Math.sin(ang) * rad + d[1] * jit;
          const pz = hub.z + u[2] * Math.cos(ang) * rad + v[2] * Math.sin(ang) * rad + d[2] * jit;
          const rn: Node = {
            x: px,
            y: py,
            z: pz,
            type: "repo",
            dom,
            col: DCOLOR[dom],
            repo: r,
            base: 3 + Math.min(6, r.nodes / 95),
          };
          const ri = nodes.push(rn) - 1;
          edges.push({ a: hi, b: ri, dom, w: 0.5 });
          const sats = Math.max(3, Math.min(7, Math.round(r.nodes / 110)));
          for (let s = 0; s < sats; s++) {
            const sr = 11 + rng() * 13,
              sa = rng() * TAU,
              sb = Math.acos(2 * rng() - 1);
            const sx = px + sr * Math.sin(sb) * Math.cos(sa),
              sy = py + sr * Math.cos(sb),
              sz = pz + sr * Math.sin(sb) * Math.sin(sa);
            const si =
              nodes.push({ x: sx, y: sy, z: sz, type: "sat", dom, col: DCOLOR[dom], base: 1.25 }) - 1;
            edges.push({ a: ri, b: si, dom, w: 0.25 });
          }
        });
      });
      if (!stars.length) {
        for (let i = 0; i < 440; i++) {
          const u2 = 2 * rng() - 1,
            th = rng() * TAU,
            rr = 560 + rng() * 520,
            ss = Math.sqrt(1 - u2 * u2);
          stars.push({ x: rr * ss * Math.cos(th), y: rr * ss * Math.sin(th), z: rr * u2, tw: rng() * TAU });
        }
        const seed = mulberry32(7);
        for (let i = 0; i < 13; i++) {
          const d = norm([seed() * 2 - 1, seed() * 2 - 1, seed() * 2 - 1]);
          const up = Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
          orbiters.push({
            u: norm(cross(d, up)),
            v: norm(cross(d, norm(cross(d, up)))),
            r: 58 + seed() * 92,
            sp: (0.4 + seed() * 0.8) * (seed() < 0.5 ? -1 : 1),
            ph: seed() * TAU,
            col: seed() < 0.42 ? "34,211,238" : "255,230,203",
            sz: 1.5 + seed() * 1.9,
            trail: [],
          });
        }
      }
    }
    build();
    let lastRepoCount = p.current.repos.length;

    const CAGE_LON = [
      { u: [1, 0, 0], v: [0, 1, 0] },
      { u: [0, 0, 1], v: [0, 1, 0] },
      { u: norm([1, 0, 1]), v: [0, 1, 0] },
      { u: norm([1, 0, -1]), v: [0, 1, 0] },
    ];
    const CAGE_LAT = [-0.58, -0.3, 0.3, 0.58];

    let yaw = 0.6,
      pitch = -0.2,
      dragging = false,
      pointerDown = false,
      lastX = 0,
      lastY = 0,
      downX = 0,
      downY = 0,
      velY = 0,
      mmx = -999,
      mmy = -999;
    let focal = 1,
      cx = 0,
      cyc = 0,
      cosY = 1,
      sinY = 0,
      cosX = 1,
      sinX = 0;
    let hoverPause = false;
    let pinned: Node | null = null;
    const reduceMo =
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    function resize() {
      const b = canvas!.getBoundingClientRect();
      MDPR = Math.min(window.devicePixelRatio || 1, 2);
      canvas!.width = b.width * MDPR;
      canvas!.height = b.height * MDPR;
      g!.setTransform(MDPR, 0, 0, MDPR, 0, 0);
      MW = b.width;
      MH = b.height;
    }
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    const rot = (x: number, y: number, z: number) => {
      const x1 = x * cosY + z * sinY,
        z1 = -x * sinY + z * cosY;
      const y2 = y * cosX - z1 * sinX,
        z2 = y * sinX + z1 * cosX;
      return [x1, y2, z2];
    };
    const prj = (rx: number, ry: number, rz: number) => {
      const sc = focal / (rz + CAMZ);
      return [cx + rx * sc, cyc + ry * sc, rz, sc];
    };
    const fog = (z: number) => Math.max(0.08, Math.min(1, (z + ROUTER + 130) / (2 * (ROUTER + 130))));
    const starFog = (z: number) => Math.max(0.05, Math.min(1, (z + 1090) / 2180));

    function hitNode(px: number, py: number): Node | null {
      if (px < 0) return null;
      let best: Node | null = null,
        bd = 1e9;
      for (let i = 1; i < nodes.length; i++) {
        const n = nodes[i];
        if (n.type !== "repo" || !n._p) continue;
        const dd = (px - n._p[0]) * (px - n._p[0]) + (py - n._p[1]) * (py - n._p[1]);
        const rad = Math.max(2, (n.base || 3) * n._p[3]) + 12;
        if (dd < rad * rad && dd < bd) {
          bd = dd;
          best = n;
        }
      }
      return best;
    }
    function hitHub(px: number, py: number): Node | null {
      if (px < 0) return null;
      let best: Node | null = null,
        bd = 1e9;
      for (let i = 1; i < nodes.length; i++) {
        const n = nodes[i];
        if (n.type !== "hub" || !n._p) continue;
        const dd = (px - n._p[0]) * (px - n._p[0]) + (py - n._p[1]) * (py - n._p[1]);
        if (dd < 26 * 26 && dd < bd) {
          bd = dd;
          best = n;
        }
      }
      return best;
    }
    function conceptsFor(r: MapRepo): string[] {
      if (r.concepts && r.concepts.length) return r.concepts;
      return [r.top || "core"];
    }
    function openDetail(n: Node) {
      pinned = n;
      const r = n.repo!;
      maptip.style.opacity = "0";
      nodedetail.innerHTML =
        `<div class="t"><span class="c" style="background:${n.col}"></span>${r.name}</div>` +
        `<div class="row"><span>nodes</span><span>${r.nodes}</span></div>` +
        `<div class="row"><span>edges</span><span>${r.edges}</span></div>` +
        `<div class="row"><span>god node</span><span style="color:${n.col}">${r.top || "—"}</span></div>` +
        `<div class="lbl">Key concepts</div><div class="concepts">${conceptsFor(r)
          .map((c) => `<span class="cc-pill">${c}</span>`)
          .join("")}</div>`;
      nodedetail.hidden = false;
      p.current.onOpenRepo(r);
    }
    function closeDetail() {
      pinned = null;
      nodedetail.hidden = true;
      p.current.onOpenRepo(null);
    }

    const onDown = (e: PointerEvent) => {
      pointerDown = true;
      downX = lastX = e.clientX;
      downY = lastY = e.clientY;
      canvas!.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      const b = canvas!.getBoundingClientRect();
      mmx = e.clientX - b.left;
      mmy = e.clientY - b.top;
      if (pointerDown) {
        if (!dragging && Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 4) {
          dragging = true;
          canvas!.classList.add("drag");
        }
        if (dragging) {
          const dx = e.clientX - lastX,
            dy = e.clientY - lastY;
          lastX = e.clientX;
          lastY = e.clientY;
          yaw += dx * 0.006;
          velY = dx * 0.006;
          pitch = Math.max(-1.2, Math.min(1.2, pitch + dy * 0.005));
        }
      }
    };
    const endPointer = (click: boolean, px?: number, py?: number) => {
      if (pointerDown && !dragging && click) {
        const X = px == null ? mmx : px,
          Y = py == null ? mmy : py;
        const hit = hitNode(X, Y);
        if (hit) openDetail(hit);
        else {
          const hub = hitHub(X, Y);
          if (hub && hub.dom) {
            p.current.onHubClick(hub.dom);
            closeDetail();
          } else closeDetail();
        }
      }
      pointerDown = false;
      dragging = false;
      canvas!.classList.remove("drag");
    };
    const onUp = (e: PointerEvent) => {
      const b = canvas!.getBoundingClientRect();
      endPointer(true, e.clientX - b.left, e.clientY - b.top);
    };
    const onLeave = () => {
      mmx = -999;
      mmy = -999;
    };
    const onWinUp = () => endPointer(false);
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointerleave", onLeave);
    window.addEventListener("pointerup", onWinUp);

    function drawRing(
      r: number,
      u: number[],
      v: number[],
      col: string,
      alpha: number,
      lw: number,
      spin: number,
      ctr?: number[],
    ) {
      const c = ctr || [0, 0, 0];
      const c1 = Math.cos(spin || 0),
        s1 = Math.sin(spin || 0);
      const uu = [u[0] * c1 + u[2] * s1, u[1], -u[0] * s1 + u[2] * c1],
        vv = [v[0] * c1 + v[2] * s1, v[1], -v[0] * s1 + v[2] * c1];
      let prev: number[] | null = null;
      const N = 64;
      for (let i = 0; i <= N; i++) {
        const th = (i / N) * TAU,
          cc = Math.cos(th),
          ss = Math.sin(th);
        const R = rot(
          c[0] + uu[0] * cc * r + vv[0] * ss * r,
          c[1] + uu[1] * cc * r + vv[1] * ss * r,
          c[2] + uu[2] * cc * r + vv[2] * ss * r,
        );
        const P = prj(R[0], R[1], R[2]);
        if (prev) {
          const a = alpha * fog((prev[2] + P[2]) / 2);
          g!.strokeStyle = `rgba(${col},${a})`;
          g!.lineWidth = lw;
          g!.beginPath();
          g!.moveTo(prev[0], prev[1]);
          g!.lineTo(P[0], P[1]);
          g!.stroke();
        }
        prev = P;
      }
    }

    function draw(now: number) {
      if (p.current.repos.length !== lastRepoCount) {
        lastRepoCount = p.current.repos.length;
        build();
      }
      const t = now / 1000;
      g!.clearRect(0, 0, MW, MH);
      if (p.current.mode !== "map" || canvas!.offsetParent === null) {
        raf = requestAnimationFrame(draw);
        return;
      }
      cx = MW / 2;
      cyc = MH / 2 - 4;
      focal = Math.min(MW, MH) * 1.0;
      if (!dragging && !hoverPause && !pinned && !reduceMo) {
        yaw += 0.0026;
        if (Math.abs(velY) > 0.0001) {
          velY *= 0.93;
          yaw += velY;
        }
      }
      cosY = Math.cos(yaw);
      sinY = Math.sin(yaw);
      cosX = Math.cos(pitch);
      sinX = Math.sin(pitch);
      const activeDom = p.current.activeDom;
      const hoverDom = p.current.hoverDom;
      const focusDom = activeDom !== "all" ? activeDom : hoverDom || "all";
      const REPOACT = p.current.repoActivity;
      // starfield
      for (let s = 0; s < stars.length; s++) {
        const st = stars[s],
          Rs = rot(st.x, st.y, st.z);
        if (Rs[2] + CAMZ <= 1) continue;
        const Ps = prj(Rs[0], Rs[1], Rs[2]);
        const sf = starFog(Rs[2]),
          a = (0.1 + 0.5 * sf) * (0.6 + 0.4 * Math.sin(t * 0.7 + st.tw)),
          sz = sf > 0.7 ? 1.7 : sf > 0.4 ? 1.1 : 0.7;
        g!.fillStyle = `rgba(190,220,225,${a})`;
        g!.fillRect(Ps[0], Ps[1], sz, sz);
      }
      // boundary sphere
      const OUTERGC = [
        { u: [1, 0, 0], v: [0, 1, 0] },
        { u: [0, 1, 0], v: [0, 0, 1] },
        { u: [1, 0, 0], v: [0, 0, 1] },
        { u: norm([1, 0, 1]), v: [0, 1, 0] },
      ];
      for (let o = 0; o < OUTERGC.length; o++)
        drawRing(ROUTER, OUTERGC[o].u, OUTERGC[o].v, "255,230,203", 0.05, 1, 0);
      // project nodes
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i],
          Rn = rot(n.x, n.y, n.z);
        n._p = prj(Rn[0], Rn[1], Rn[2]);
      }
      // core glow
      const cg = g!.createRadialGradient(cx, cyc, 0, cx, cyc, 160);
      cg.addColorStop(0, "rgba(34,211,238,.22)");
      cg.addColorStop(0.5, "rgba(34,211,238,.06)");
      cg.addColorStop(1, "rgba(34,211,238,0)");
      g!.fillStyle = cg;
      g!.beginPath();
      g!.arc(cx, cyc, 160, 0, TAU);
      g!.fill();
      // globe cage
      const spin = t * 0.24;
      for (let lo = 0; lo < CAGE_LON.length; lo++)
        drawRing(CAGE_R, CAGE_LON[lo].u, CAGE_LON[lo].v, "34,211,238", 0.15, 1, spin);
      for (let la = 0; la < CAGE_LAT.length; la++) {
        const yc = CAGE_LAT[la] * CAGE_R,
          rr = Math.sqrt(Math.max(0, CAGE_R * CAGE_R - yc * yc));
        drawRing(rr, [1, 0, 0], [0, 0, 1], "34,211,238", 0.12, 1, spin, [0, yc, 0]);
      }
      // orbiters (single canvas, behind orb)
      for (let i = 0; i < orbiters.length; i++) {
        const o = orbiters[i],
          th = t * o.sp + o.ph,
          c = Math.cos(th),
          s = Math.sin(th);
        const R = rot(o.u[0] * c * o.r + o.v[0] * s * o.r, o.u[1] * c * o.r + o.v[1] * s * o.r, o.u[2] * c * o.r + o.v[2] * s * o.r);
        const P = prj(R[0], R[1], R[2]);
        const f = fog(R[2]),
          sc = P[3];
        o.trail.push([P[0], P[1]]);
        if (o.trail.length > 8) o.trail.shift();
        for (let tI = 1; tI < o.trail.length; tI++) {
          const A = o.trail[tI - 1],
            B = o.trail[tI],
            ta = (tI / o.trail.length) * 0.4 * f;
          g!.strokeStyle = `rgba(${o.col},${ta})`;
          g!.lineWidth = 1;
          g!.beginPath();
          g!.moveTo(A[0], A[1]);
          g!.lineTo(B[0], B[1]);
          g!.stroke();
        }
        const rr = Math.max(1.2, o.sz * sc);
        g!.shadowBlur = 10;
        g!.shadowColor = `rgba(${o.col},0.9)`;
        g!.fillStyle = `rgba(${o.col},${0.85 * Math.max(0.4, f)})`;
        g!.beginPath();
        g!.arc(P[0], P[1], rr, 0, TAU);
        g!.fill();
        g!.shadowBlur = 0;
      }
      // edges
      for (let e = 0; e < edges.length; e++) {
        const ed = edges[e],
          A = nodes[ed.a]._p!,
          B = nodes[ed.b]._p!;
        const dim = focusDom !== "all" && ed.dom && ed.dom !== focusDom ? 0.12 : 1,
          col = ed.dom ? DCOLOR[ed.dom] : "#22d3ee",
          f = fog((A[2] + B[2]) / 2);
        const grd = g!.createLinearGradient(A[0], A[1], B[0], B[1]);
        grd.addColorStop(0, `rgba(${hexTri(col)},${0.05 * dim * f})`);
        grd.addColorStop(1, `rgba(${hexTri(col)},${(ed.w > 0.9 ? 0.4 : ed.w > 0.4 ? 0.3 : 0.16) * dim * f})`);
        g!.strokeStyle = grd;
        g!.lineWidth = ed.w > 0.9 ? 1.4 : ed.w > 0.4 ? 1 : 0.6;
        g!.beginPath();
        g!.moveTo(A[0], A[1]);
        g!.lineTo(B[0], B[1]);
        g!.stroke();
      }
      // nodes far→near
      const order: number[] = [];
      for (let i2 = 1; i2 < nodes.length; i2++) order.push(i2);
      order.sort((a, b) => nodes[a]._p![2] - nodes[b]._p![2]);
      let hoverRepo: Node | null = null,
        hoverD = 1e9,
        hoverHub: Node | null = null;
      for (let oo = 0; oo < order.length; oo++) {
        const n2 = nodes[order[oo]],
          P = n2._p!,
          sc = P[3],
          f2 = fog(P[2]),
          dim2 = focusDom !== "all" && n2.dom !== focusDom ? 0.16 : 1;
        if (n2.type === "hub") {
          const hhot = (mmx - P[0]) * (mmx - P[0]) + (mmy - P[1]) * (mmy - P[1]) < 26 * 26;
          if (hhot) hoverHub = n2;
          const sel = activeDom === n2.dom;
          const hg = g!.createRadialGradient(P[0], P[1], 0, P[0], P[1], 36 * sc);
          hg.addColorStop(0, `rgba(${hexTri(n2.col!)},${(hhot ? 0.3 : 0.2) * dim2 * f2})`);
          hg.addColorStop(1, `rgba(${hexTri(n2.col!)},0)`);
          g!.fillStyle = hg;
          g!.beginPath();
          g!.arc(P[0], P[1], 36 * sc, 0, TAU);
          g!.fill();
          g!.shadowBlur = 14;
          g!.shadowColor = `rgba(${hexTri(n2.col!)},0.9)`;
          g!.fillStyle = `rgba(${hexTri(n2.col!)},${0.95 * dim2})`;
          g!.beginPath();
          g!.arc(P[0], P[1], Math.max(3, (hhot ? 7 : 5.5) * sc), 0, TAU);
          g!.fill();
          g!.shadowBlur = 0;
          if (hhot || sel) {
            g!.strokeStyle = `rgba(${hexTri(n2.col!)},${sel ? 0.85 : 0.6})`;
            g!.lineWidth = 1.3;
            g!.beginPath();
            g!.arc(P[0], P[1], 12 * sc, 0, TAU);
            g!.stroke();
          }
          g!.font = `600 ${11.5 * Math.max(0.75, sc)}px system-ui`;
          g!.fillStyle = `rgba(255,230,203,${(hhot ? 1 : 0.92) * dim2})`;
          g!.textAlign = "center";
          g!.textBaseline = "middle";
          g!.fillText(n2.dom!.charAt(0).toUpperCase() + n2.dom!.slice(1), P[0], P[1] - 17 * sc);
        } else if (n2.type === "repo") {
          const rad = Math.max(1.6, (n2.base || 3) * sc),
            d2 = (mmx - P[0]) * (mmx - P[0]) + (mmy - P[1]) * (mmy - P[1]),
            hot = d2 < (rad + 13) * (rad + 13);
          if (hot && d2 < hoverD) {
            hoverD = d2;
            hoverRepo = n2;
          }
          const isPin = pinned === n2;
          g!.shadowBlur = hot || isPin ? 16 : 8;
          g!.shadowColor = `rgba(${hexTri(n2.col!)},0.85)`;
          g!.fillStyle = `rgba(${hexTri(n2.col!)},${(hot || isPin ? 1 : 0.9) * dim2 * Math.max(0.5, f2)})`;
          g!.beginPath();
          g!.arc(P[0], P[1], rad, 0, TAU);
          g!.fill();
          g!.shadowBlur = 0;
          if (hot || isPin) {
            const rt = hexTri(n2.col!),
              rr2 = rad + 9;
            g!.strokeStyle = `rgba(${rt},0.55)`;
            g!.lineWidth = 1;
            for (let bk = 0; bk < 4; bk++) {
              const aa = t * 1.1 + (bk * Math.PI) / 2;
              g!.beginPath();
              g!.arc(P[0], P[1], rr2, aa - 0.32, aa + 0.32);
              g!.stroke();
            }
            const pr = (t * 0.55) % 1;
            g!.strokeStyle = `rgba(${rt},${(1 - pr) * 0.42})`;
            g!.beginPath();
            g!.arc(P[0], P[1], rad + 2 + pr * 17, 0, TAU);
            g!.stroke();
            if (isPin) {
              g!.strokeStyle = "rgba(255,230,203,.85)";
              g!.lineWidth = 1.3;
              g!.beginPath();
              g!.arc(P[0], P[1], rad + 4, 0, TAU);
              g!.stroke();
            }
          }
          g!.fillStyle = "rgba(4,20,20,0.85)";
          g!.beginPath();
          g!.arc(P[0], P[1], rad * 0.4, 0, TAU);
          g!.fill();
          const act = REPOACT[n2.repo!.name];
          if (act === "running") {
            const pp = (t * 0.5) % 1;
            g!.strokeStyle = `rgba(34,211,238,${(1 - pp) * 0.5 * dim2})`;
            g!.lineWidth = 1.2;
            g!.beginPath();
            g!.arc(P[0], P[1], rad + 3 + pp * 11, 0, TAU);
            g!.stroke();
          } else if (act === "err") {
            g!.strokeStyle = `rgba(251,113,133,${0.75 * dim2})`;
            g!.lineWidth = 1.4;
            g!.beginPath();
            g!.arc(P[0], P[1], rad + 4, 0, TAU);
            g!.stroke();
            g!.fillStyle = `rgba(251,113,133,${0.9 * dim2})`;
            g!.font = "bold 9px system-ui";
            g!.textAlign = "center";
            g!.textBaseline = "middle";
            g!.fillText("!", P[0], P[1] - rad - 9);
          }
          if (focusDom === n2.dom || hot || isPin) {
            g!.font = "10px system-ui";
            g!.fillStyle = `rgba(255,230,203,${0.85 * dim2})`;
            g!.textAlign = "left";
            g!.textBaseline = "middle";
            g!.fillText(n2.repo!.name, P[0] + rad + 5, P[1]);
          }
        } else {
          g!.fillStyle = `rgba(${hexTri(n2.col!)},${0.5 * dim2 * f2})`;
          g!.beginPath();
          g!.arc(P[0], P[1], Math.max(0.8, (n2.base || 1) * sc), 0, TAU);
          g!.fill();
        }
      }
      if (hoverRepo && !pinned) {
        const r = hoverRepo.repo!,
          PP = hoverRepo._p!;
        maptip.style.opacity = "1";
        maptip.style.left = PP[0] + "px";
        maptip.style.top = PP[1] + "px";
        maptip.innerHTML =
          `<div class="t">${r.name}</div><div class="m">${r.nodes} nodes &middot; ${r.edges} edges</div>` +
          `<div class="m">god node: ${r.top || "—"}</div><div class="dm" style="color:${hoverRepo.col}">${hoverRepo.dom}</div>`;
      } else if (!pinned) maptip.style.opacity = "0";
      hoverPause = hoverRepo !== null || hoverHub !== null;
      if (pinned && pinned._p) {
        nodedetail.style.left = pinned._p[0] + "px";
        nodedetail.style.top = pinned._p[1] + "px";
      }
      raf = requestAnimationFrame(draw);
    }
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("pointerup", onWinUp);
    };
  }, []);

  return (
    <>
      <canvas id="map" ref={canvasRef} className={props.mode === "voice" ? "voice" : ""} />
      <div className="tip maptip" ref={tipRef} />
      <div className="tip nodedetail glass" ref={detailRef} hidden />
    </>
  );
}

export default KnowledgeMap;
