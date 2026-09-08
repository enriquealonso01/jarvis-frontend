// Tiny WebAudio earcon + ambient engine for the voice console. No audio files
// (the artifact/CSP sandbox blocks external media): every sound is synthesized
// from oscillators. Everything is deliberately low-volume and subtle.
//
// Earcons:
//   listenStart()  — soft rising chirp when the mic opens
//   thinkingStart()— two-note "on it" when JARVIS starts a turn
//   returned()     — two-note descending when the answer comes back
//   error()        — low buzz on failure
// Ambient:
//   startAmbient() — gentle pulsing pad while JARVIS is working/researching
//   escalate()     — deepens the pad + adds a slow ping once a turn runs long
//   stopAmbient()  — fades the pad out

type AmbientNodes = {
  gain: GainNode;
  filter: BiquadFilterNode;
  osc: OscillatorNode;
  osc2: OscillatorNode;
  lfo: OscillatorNode;
  base: number;
};

export class VoiceSounds {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private ambient: AmbientNodes | null = null;
  private pingTimer: number | null = null;
  private analyser: AnalyserNode | null = null;
  private timeBuf: Uint8Array<ArrayBuffer> | null = null;
  private connectedEls = new WeakSet<HTMLAudioElement>();
  private micStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private micTapped = false;

  private ensure(): AudioContext | null {
    if (typeof window === "undefined") return null;
    if (!this.ctx) {
      const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!Ctor) return null;
      this.ctx = new Ctor() as AudioContext;
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  /** Unlock/resume the context from a user gesture (the mic click). */
  resume(): void {
    const c = this.ensure();
    if (c && c.state === "suspended") void c.resume();
  }

  private blip(freqs: number[], dur = 0.12, gain = 0.05, type: OscillatorType = "sine"): void {
    const c = this.ensure();
    if (!c || !this.master) return;
    const master = this.master;
    const t0 = c.currentTime;
    freqs.forEach((f, i) => {
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = type;
      o.frequency.value = f;
      const start = t0 + i * dur * 0.8;
      g.gain.setValueAtTime(0.0001, start);
      g.gain.linearRampToValueAtTime(gain, start + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      o.connect(g);
      g.connect(master);
      o.start(start);
      o.stop(start + dur + 0.03);
    });
  }

  listenStart(): void {
    this.blip([660, 990], 0.09, 0.04);
  }
  thinkingStart(): void {
    this.blip([523.25, 784], 0.12, 0.05);
  }
  returned(): void {
    this.blip([784, 523.25], 0.12, 0.05);
  }
  error(): void {
    this.blip([300, 220], 0.18, 0.05, "triangle");
  }

  startAmbient(): void {
    const c = this.ensure();
    if (!c || !this.master) return;
    const master = this.master;
    this.stopAmbient();
    const osc = c.createOscillator();
    const osc2 = c.createOscillator();
    const filter = c.createBiquadFilter();
    const gain = c.createGain();
    const lfo = c.createOscillator();
    const lfoGain = c.createGain();

    osc.type = "sine";
    osc.frequency.value = 110;
    osc2.type = "sine";
    osc2.frequency.value = 146.83; // gentle interval, "processing" pad
    filter.type = "lowpass";
    filter.frequency.value = 620;
    lfo.type = "sine";
    lfo.frequency.value = 0.85; // slow tremolo ~0.85 Hz
    lfoGain.gain.value = 0.018;

    const base = 0.03;
    const t = c.currentTime;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(base, t + 0.45);

    lfo.connect(lfoGain);
    lfoGain.connect(gain.gain);
    osc.connect(filter);
    osc2.connect(filter);
    filter.connect(gain);
    gain.connect(master);

    osc.start();
    osc2.start();
    lfo.start();
    this.ambient = { gain, filter, osc, osc2, lfo, base };
  }

  /** Deepen the pad and add a slow ping — signals JARVIS has gone deep. */
  escalate(): void {
    const c = this.ctx;
    const a = this.ambient;
    if (!c || !a) return;
    const now = c.currentTime;
    try {
      a.gain.gain.cancelScheduledValues(now);
      a.gain.gain.setValueAtTime(a.gain.gain.value, now);
      a.gain.gain.linearRampToValueAtTime(a.base * 1.5, now + 0.6);
      a.filter.frequency.linearRampToValueAtTime(900, now + 0.6);
    } catch {
      /* ignore */
    }
    if (this.pingTimer === null) {
      this.pingTimer = window.setInterval(() => this.blip([1318.5], 0.07, 0.02), 2800);
    }
  }

  stopAmbient(): void {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    const c = this.ctx;
    const a = this.ambient;
    this.ambient = null;
    if (!c || !a) return;
    const now = c.currentTime;
    try {
      a.gain.gain.cancelScheduledValues(now);
      a.gain.gain.setValueAtTime(a.gain.gain.value, now);
      a.gain.gain.linearRampToValueAtTime(0.0001, now + 0.25);
      a.osc.stop(now + 0.3);
      a.osc2.stop(now + 0.3);
      a.lfo.stop(now + 0.3);
    } catch {
      /* ignore */
    }
  }

  private ensureAnalyser(): AnalyserNode | null {
    const c = this.ensure();
    if (!c) return null;
    if (!this.analyser) {
      this.analyser = c.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.smoothingTimeConstant = 0.82;
      this.timeBuf = new Uint8Array(this.analyser.fftSize);
    }
    return this.analyser;
  }

  /** Route a TTS <audio> element through the graph so we can measure it.
   * Once connected, the element plays through our AudioContext (so keep it
   * resumed). Safe to call repeatedly — each element is connected once. */
  connectAudioElement(el: HTMLAudioElement): void {
    const c = this.ensure();
    const an = this.ensureAnalyser();
    if (!c || !an || !this.master) return;
    if (c.state === "suspended") void c.resume(); // routed audio needs a running ctx
    if (this.connectedEls.has(el)) return;
    try {
      const src = c.createMediaElementSource(el);
      src.connect(this.master); // playback
      src.connect(an); // measurement tap (dead-end)
      this.connectedEls.add(el);
    } catch {
      /* already connected elsewhere or unsupported — fall back to simulated */
    }
  }

  /** Tap/untap the mic into the analyser so the orb reacts to the user's
   * voice while listening. Lazily acquires one getUserMedia stream and just
   * connects/disconnects it (cheap) between turns. Tap OFF while JARVIS speaks
   * so the analyser measures the TTS, not the mic picking it up. Denied/absent
   * mic just leaves the visualiser on its gentle simulated base — no error. */
  async micTap(on: boolean): Promise<void> {
    const c = this.ensure();
    const an = this.ensureAnalyser();
    if (!c || !an) return;
    if (on) {
      if (!this.micStream) {
        try {
          this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          this.micSource = c.createMediaStreamSource(this.micStream);
        } catch {
          this.micStream = null;
          this.micSource = null;
          return;
        }
      }
      if (this.micSource && !this.micTapped) {
        try {
          this.micSource.connect(an);
          this.micTapped = true;
        } catch {
          /* ignore */
        }
      }
    } else if (this.micSource && this.micTapped) {
      try {
        this.micSource.disconnect(an);
      } catch {
        /* ignore */
      }
      this.micTapped = false;
    }
  }

  stopMic(): void {
    if (this.micSource) {
      try {
        this.micSource.disconnect();
      } catch {
        /* ignore */
      }
      this.micSource = null;
    }
    if (this.micStream) {
      this.micStream.getTracks().forEach((t) => t.stop());
      this.micStream = null;
    }
    this.micTapped = false;
  }

  /** Current audio amplitude 0..1 (RMS of the analyser's time-domain data).
   * Reflects whatever is tapped into the analyser (TTS while speaking, or the
   * mic while listening). */
  level(): number {
    const an = this.analyser;
    const buf = this.timeBuf;
    if (!an || !buf) return 0;
    an.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / buf.length);
    return Math.min(1, rms * 3.4);
  }

  dispose(): void {
    this.stopAmbient();
    this.stopMic();
    try {
      void this.ctx?.close();
    } catch {
      /* ignore */
    }
    this.ctx = null;
    this.master = null;
  }
}
