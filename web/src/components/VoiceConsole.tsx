import { useCallback, useEffect, useRef, useState } from "react";
import { AudioLines, Loader2, Mic, MicOff, Radar, Volume2, VolumeX, X } from "lucide-react";
import { authedFetch, fetchJSON } from "@/lib/api";
import { cn } from "@/lib/utils";
import { VoiceSounds } from "@/lib/voiceSounds";
import { VoiceOrbCanvas } from "@/components/VoiceOrbCanvas";

// The mic on the Control Center talks to the real JARVIS agent:
//   speech  ->  browser Web Speech API (live transcript, no key needed)
//   text    ->  POST /api/control/voice/converse  (one `hermes -z` turn)
//   reply   ->  POST /api/control/voice/tts        (cloned "JARVIS" voice, mp3)
// JARVIS is allowed to think/research (config reasoning), so a turn can take a
// while. We cover that with synthesized processing sounds + a live status
// shown both on the orb and as a pending line in the transcript ("chat"). If a
// turn runs long we escalate to a "researching" state (deeper sound + label).
//
// Turn-taking is half-duplex: the mic is stopped while JARVIS thinks/speaks so
// it never transcribes its own voice, then resumes for the next turn. End of
// speech is a 1.5s SILENCE TIMER (not the engine's short VAD) so a mid-sentence
// breath no longer cuts the user off.

const SILENCE_MS = 1500;
const RESEARCH_ESCALATE_MS = 10000; // a turn still running past this = "researching"
const TRANSCRIPT_KEY = "jarvis_voice_transcript";
const TRANSCRIPT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // match the backend 30-day voice-session TTL
const MUTED_KEY = "jarvis_voice_muted";

type Phase = "idle" | "listening" | "thinking" | "speaking" | "error";
type Role = "you" | "jarvis";
type Line = { id: number; role: Role; text: string };

// Web Speech API is not in the TS DOM lib; treat instances/events as `any`.
function getSpeechRecognitionCtor(): any | null {
  if (typeof window === "undefined") return null;
  const w = window as any;
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

// Mobile browsers (iOS Safari) ship no Web Speech API — fall back to
// MediaRecorder + server-side Whisper (/api/control/voice/transcribe).
function getMediaRecorderCtor(): any | null {
  if (typeof window === "undefined") return null;
  const w = window as any;
  if (typeof w.MediaRecorder !== "function") return null;
  if (!w.isSecureContext) return null;
  return w.MediaRecorder;
}

function pickRecorderMime(): string {
  const w = window as any;
  const candidates = ["audio/webm", "audio/mp4", "audio/ogg", "audio/aac", ""];
  for (const m of candidates) {
    try {
      if (!m || w.MediaRecorder.isTypeSupported(m)) return m;
    } catch {
      /* keep probing */
    }
  }
  return "";
}

export function VoiceConsole({
  gatewayRunning,
  workCount,
  bare = false,
  context = null,
  onClearContext,
}: {
  gatewayRunning: boolean;
  workCount: number;
  /** Hide the dashboard chrome (gateway pill + over-orb transcript) so the orb floats clean. */
  bare?: boolean;
  /** A project selected on the map — prepended to what you say so voice references it. */
  context?: string | null;
  onClearContext?: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const contextRef = useRef<string | null>(context);
  contextRef.current = context;
  const [researching, setResearching] = useState(false);
  const [interim, setInterim] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [errorMsg, setErrorMsg] = useState<string>("");
  // Whisper fallback state (mobile browsers without Web Speech API).
  const whisperModeRef = useRef<boolean>(false);
  const mediaRecorderRef = useRef<any>(null);
  const recordChunksRef = useRef<Blob[]>([]);
  const recordStreamRef = useRef<MediaStream | null>(null);
  const silenceFallbackRef = useRef<number | null>(null);
  // Late-bound callbacks (declared later) used by the whisper path.
  const handleUtteranceRef = useRef<(t: string) => void>(() => {});
  const startListeningRef = useRef<() => void>(() => {});
  const [supported] = useState<boolean>(() => !!getSpeechRecognitionCtor() || !!getMediaRecorderCtor());
  const [ttsReady, setTtsReady] = useState<boolean>(true);
  const [muted, setMuted] = useState<boolean>(() => {
    try {
      return localStorage.getItem(MUTED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const mutedRef = useRef(muted);

  const phaseRef = useRef<Phase>("idle");
  const activeRef = useRef<boolean>(false);
  const sendingRef = useRef<boolean>(false);
  const recognitionRef = useRef<any>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const conversationIdRef = useRef<string | null>(null);
  const finalBufRef = useRef<string>("");
  const silenceTimerRef = useRef<number | null>(null);
  const researchTimerRef = useRef<number | null>(null);
  const soundsRef = useRef<VoiceSounds | null>(null);
  const lineIdRef = useRef<number>(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const interruptRef = useRef<boolean>(false);
  const playResolveRef = useRef<(() => void) | null>(null);

  const sounds = useCallback((): VoiceSounds => {
    if (!soundsRef.current) soundsRef.current = new VoiceSounds();
    return soundsRef.current;
  }, []);

  const setPhaseBoth = useCallback((p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  }, []);

  const clearSilence = useCallback(() => {
    if (silenceTimerRef.current !== null) {
      window.clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }, []);

  const clearResearch = useCallback(() => {
    if (researchTimerRef.current !== null) {
      window.clearTimeout(researchTimerRef.current);
      researchTimerRef.current = null;
    }
  }, []);

  // ---- Whisper fallback (mobile): MediaRecorder -> /voice/transcribe ----

  const stopWhisperCapture = useCallback(() => {
    if (silenceFallbackRef.current !== null) {
      window.clearTimeout(silenceFallbackRef.current);
      silenceFallbackRef.current = null;
    }
    const rec = mediaRecorderRef.current;
    if (rec && rec.state === "recording") {
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
    }
    recordStreamRef.current?.getTracks().forEach((t: MediaStreamTrack) => t.stop());
    recordStreamRef.current = null;
  }, []);

  const transcribeAndSend = useCallback(
    async (chunks: Blob[]) => {
      const mime = pickRecorderMime() || "audio/webm";
      const ext = mime.includes("mp4") ? "mp4" : mime.includes("ogg") ? "ogg" : mime.includes("aac") ? "aac" : "webm";
      const blob = new Blob(chunks, { type: mime || "audio/webm" });
      if (blob.size < 1200) {
        startListeningRef.current();
        return;
      }
      setPhaseBoth("thinking");
      void soundsRef.current?.micTap(false);
      const snd = sounds();
      snd.thinkingStart();
      try {
        const form = new FormData();
        form.append("audio", blob, `speech.${ext}`);
        const res = await authedFetch("/api/control/voice/transcribe", { method: "POST", body: form });
        if (!res.ok) throw new Error(`transcribe ${res.status}`);
        const data = (await res.json()) as { text?: string };
        const text = (data.text || "").trim();
        if (!text) {
          startListeningRef.current();
          return;
        }
        handleUtteranceRef.current(text);
      } catch (err: unknown) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
        startListeningRef.current();
      }
    },
    [setPhaseBoth, sounds],
  );

  const startWhisperCapture = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordStreamRef.current = stream;
      const mimeType = pickRecorderMime();
      const rec = new (getMediaRecorderCtor() as any)(mimeType ? { audio: true, mimeType } : { audio: true });
      recordChunksRef.current = [];
      rec.ondataavailable = (ev: any) => {
        if (ev.data && ev.data.size > 0) recordChunksRef.current.push(ev.data);
      };
      rec.onstop = () => {
        recordStreamRef.current?.getTracks().forEach((t: MediaStreamTrack) => t.stop());
        recordStreamRef.current = null;
        if (activeRef.current && !interruptRef.current) void transcribeAndSend(recordChunksRef.current);
      };
      mediaRecorderRef.current = rec;
      rec.start();
      setPhaseBoth("listening");
      void soundsRef.current?.micTap(true);
    } catch {
      activeRef.current = false;
      setErrorMsg("Microphone permission denied.");
      setPhaseBoth("error");
    }
  }, [setPhaseBoth, transcribeAndSend]);

  const appendLine = useCallback((role: Role, text: string): number => {
    const clean = text.trim();
    if (!clean) return -1;
    const id = lineIdRef.current++;
    setLines((prev) => [...prev, { id, role, text: clean }].slice(-100));
    return id;
  }, []);

  // Voice-output readiness (whether the ElevenLabs key is set server-side).
  useEffect(() => {
    let cancelled = false;
    fetchJSON<{ tts_ready: boolean }>("/api/control/voice/status")
      .then((s) => {
        if (!cancelled) setTtsReady(Boolean(s?.tts_ready));
      })
      .catch(() => {
        /* status is best-effort; keep default */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-scroll the transcript to the newest line.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, interim, phase, researching]);

  // Restore the recent transcript + conversation id on mount (within TTL) so a
  // page reload keeps the last exchange and JARVIS can continue the thread.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(TRANSCRIPT_KEY);
      if (!raw) return;
      const data = JSON.parse(raw) as { ts?: number; conversationId?: string | null; lines?: Line[] };
      if (!data || typeof data.ts !== "number" || Date.now() - data.ts > TRANSCRIPT_TTL_MS) {
        localStorage.removeItem(TRANSCRIPT_KEY);
        return;
      }
      if (Array.isArray(data.lines) && data.lines.length > 0) {
        const restored = data.lines.slice(-100);
        setLines(restored);
        lineIdRef.current = (restored[restored.length - 1]?.id ?? 0) + 1;
      }
      if (data.conversationId) conversationIdRef.current = data.conversationId;
    } catch {
      /* storage unavailable — start fresh */
    }
  }, []);

  // Persist the transcript as it grows (never clobber with an empty list — the
  // hidden desktop/mobile twin instance stays empty).
  useEffect(() => {
    if (lines.length === 0) return;
    try {
      localStorage.setItem(
        TRANSCRIPT_KEY,
        JSON.stringify({ ts: Date.now(), conversationId: conversationIdRef.current, lines }),
      );
    } catch {
      /* ignore */
    }
  }, [lines]);

  useEffect(() => {
    mutedRef.current = muted;
    try {
      localStorage.setItem(MUTED_KEY, muted ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [muted]);

  type ConverseResult = { reply: string; conversation_id: string; source?: string; pending_id?: string };

  const converse = useCallback(async (text: string): Promise<ConverseResult> => {
    // If a project is selected on the map, reference it so voice is scoped to it.
    const ctx = contextRef.current;
    const msg = ctx ? `[Regarding the project "${ctx}"] ${text}` : text;
    const res = await fetchJSON<ConverseResult>("/api/control/voice/converse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: msg, conversation_id: conversationIdRef.current }),
    });
    if (res?.conversation_id) conversationIdRef.current = res.conversation_id;
    return res;
  }, []);

  // A delegated turn's finished answer is delivered to Enrique's WhatsApp by the
  // background agent — so we don't keep JARVIS "busy" on the call waiting to
  // speak it. Track delivery quietly (no speech, no mic hold) and drop a small
  // confirmation into the transcript when it lands.
  const trackDelivery = useCallback(
    async (id: string): Promise<void> => {
      const start = Date.now();
      while (Date.now() - start < 600000) {
        await new Promise((r) => window.setTimeout(r, 4000));
        try {
          const r = await fetchJSON<{ status: string; delivered?: boolean }>(
            `/api/control/voice/result/${id}`,
          );
          if (r.status === "done") {
            appendLine(
              "jarvis",
              r.delivered
                ? "✓ Sent the answer to your WhatsApp, sir."
                : "Finished, sir — but I couldn't reach WhatsApp; it's in the Control Center.",
            );
            return;
          }
          if (r.status === "error") {
            appendLine("jarvis", "That task ran into an error, sir.");
            return;
          }
          if (r.status === "unknown") return;
        } catch {
          /* transient — keep polling */
        }
      }
    },
    [appendLine],
  );

  const startListening = useCallback(() => {
    if (!activeRef.current) return;
    clearSilence();
    finalBufRef.current = "";
    sendingRef.current = false;
    setInterim("");
    if (whisperModeRef.current) {
      startWhisperCapture();
      return;
    }
    const rec = recognitionRef.current;
    if (!rec) return;
    setPhaseBoth("listening");
    void soundsRef.current?.micTap(true); // orb reacts to the user's voice
    try {
      rec.start();
    } catch {
      /* already started — ignore */
    }
  }, [clearSilence, setPhaseBoth, startWhisperCapture]);

  handleUtteranceRef.current = (text: string) => {
    void Promise.resolve(handleUserUtterance(text));
  };
  startListeningRef.current = startListening;

  const afterTurn = useCallback(() => {
    if (activeRef.current) startListeningRef.current();
    else setPhaseBoth("idle");
  }, [setPhaseBoth]);

  // Speak one line (no phase/turn management — the caller drives the flow).
  const playTts = useCallback(
    async (text: string): Promise<void> => {
      if (mutedRef.current || !ttsReady || !text) return; // quiet mode: text only
      let url: string | null = null;
      try {
        const res = await authedFetch("/api/control/voice/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        if (!res.ok) throw new Error(`tts ${res.status}`);
        const blob = await res.blob();
        url = URL.createObjectURL(blob);
        const audio = audioRef.current ?? new Audio();
        audioRef.current = audio;
        soundsRef.current?.connectAudioElement(audio);
        audio.src = url;
        await new Promise<void>((resolve) => {
          playResolveRef.current = resolve;
          audio.onended = () => resolve();
          audio.onerror = () => resolve();
          audio.play().catch(() => resolve());
        });
        playResolveRef.current = null;
      } catch {
        /* playback failed — the reply text is already on screen */
      } finally {
        if (url) URL.revokeObjectURL(url);
      }
    },
    [ttsReady],
  );

  // Barge-in: cut JARVIS off and return to listening (does NOT end the session).
  const interrupt = useCallback(() => {
    interruptRef.current = true;
    clearResearch();
    setResearching(false);
    if (soundsRef.current) soundsRef.current.stopAmbient();
    const audio = audioRef.current;
    if (audio) {
      try {
        audio.pause();
      } catch {
        /* ignore */
      }
    }
    playResolveRef.current?.(); // unblock any in-flight playTts immediately
  }, [clearResearch]);

  const handleUserUtterance = useCallback(
    (text: string) => {
      const clean = text.trim();
      if (!clean) {
        afterTurn();
        return;
      }
      appendLine("you", clean);
      setInterim("");
      setResearching(false);
      setPhaseBoth("thinking");
      void soundsRef.current?.micTap(false); // stop mic tap so the orb tracks TTS, not the mic
      // JARVIS goes off to work: earcon + ambient pad, escalate if it runs long.
      const snd = sounds();
      snd.thinkingStart();
      snd.startAmbient();
      clearResearch();
      researchTimerRef.current = window.setTimeout(() => {
        if (phaseRef.current === "thinking") {
          setResearching(true);
          snd.escalate();
        }
      }, RESEARCH_ESCALATE_MS);

      const stopWork = () => {
        clearResearch();
        setResearching(false);
        snd.stopAmbient();
      };

      void (async () => {
        interruptRef.current = false;
        try {
          const res = await converse(clean);
          if (interruptRef.current) return;
          if (res.source === "delegated" && res.pending_id) {
            // Heavy/slow work is handed to a background agent that delivers the
            // finished answer to Enrique's WhatsApp. Speak the ack (which
            // already promises WhatsApp) and end the turn promptly — don't hold
            // the call. Track delivery quietly so the transcript can confirm it.
            appendLine("jarvis", res.reply);
            stopWork();
            snd.returned();
            setPhaseBoth("speaking");
            await playTts(res.reply);
            void trackDelivery(res.pending_id);
          } else {
            stopWork();
            snd.returned();
            const spoken = res.reply || "Sorry, I didn't catch that.";
            appendLine("jarvis", spoken);
            setPhaseBoth("speaking");
            await playTts(spoken);
          }
        } catch (err: unknown) {
          if (interruptRef.current) return;
          stopWork();
          snd.error();
          appendLine("jarvis", "I hit an error reaching the agent.");
          setErrorMsg(err instanceof Error ? err.message : String(err));
        } finally {
          stopWork();
          afterTurn();
        }
      })();
    },
    [afterTurn, appendLine, clearResearch, converse, playTts, trackDelivery, setPhaseBoth, sounds],
  );

  // Fires after ~SILENCE_MS of no new speech: treat the buffer as a full turn.
  const flushUtterance = useCallback(() => {
    if (phaseRef.current !== "listening" || sendingRef.current) return;
    const text = finalBufRef.current.trim();
    if (!text) return; // just noise — keep listening
    sendingRef.current = true;
    clearSilence();
    const rec = recognitionRef.current;
    if (rec) {
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
    }
    handleUserUtterance(text);
  }, [clearSilence, handleUserUtterance]);

  const ensureRecognition = useCallback((): any | null => {
    if (recognitionRef.current) return recognitionRef.current;
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return null;
    const rec = new Ctor();
    rec.lang = "en-US";
    rec.continuous = true; // stay on; WE decide when the turn ends (silence timer)
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onresult = (ev: any) => {
      let live = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (r.isFinal) finalBufRef.current += r[0].transcript;
        else live += r[0].transcript;
      }
      setInterim((finalBufRef.current + " " + live).trim());
      clearSilence();
      silenceTimerRef.current = window.setTimeout(flushUtterance, SILENCE_MS);
    };
    rec.onerror = (ev: any) => {
      const e = ev?.error;
      if (e === "no-speech" || e === "aborted") return; // benign — keep-alive via onend
      // Any hard/persistent failure: STOP rather than spin-restart via onend
      // (a looping "network"/"audio-capture" error would hammer STT + pin CPU).
      activeRef.current = false;
      clearSilence();
      if (soundsRef.current) soundsRef.current.stopMic();
      setErrorMsg(
        e === "not-allowed" || e === "service-not-allowed"
          ? "Microphone permission denied."
          : e === "audio-capture"
            ? "No microphone found."
            : e === "network"
              ? "Speech service unavailable — check your connection."
              : "Voice input error — tap to retry.",
      );
      setPhaseBoth("error");
    };
    rec.onend = () => {
      if (activeRef.current && phaseRef.current === "listening" && !sendingRef.current) {
        try {
          rec.start();
        } catch {
          /* ignore */
        }
      }
    };
    recognitionRef.current = rec;
    return rec;
  }, [clearSilence, flushUtterance, setPhaseBoth]);

  const stopAll = useCallback(() => {
    activeRef.current = false;
    sendingRef.current = false;
    whisperModeRef.current = false;
    stopWhisperCapture();
    clearSilence();
    clearResearch();
    setResearching(false);
    setInterim("");
    finalBufRef.current = "";
    if (soundsRef.current) {
      soundsRef.current.stopAmbient();
      soundsRef.current.stopMic();
    }
    const rec = recognitionRef.current;
    if (rec) {
      try {
        rec.abort();
      } catch {
        /* ignore */
      }
    }
    const audio = audioRef.current;
    if (audio) {
      try {
        audio.pause();
      } catch {
        /* ignore */
      }
    }
    setPhaseBoth("idle");
  }, [clearSilence, clearResearch, stopWhisperCapture, setPhaseBoth]);

  // The ✕ ends AND clears: fresh transcript + new conversation thread. (A plain
  // reload still restores, since we only wipe storage on an explicit end.)
  const endAndClear = useCallback(() => {
    stopAll();
    setLines([]);
    conversationIdRef.current = null;
    try {
      localStorage.removeItem(TRANSCRIPT_KEY);
    } catch {
      /* ignore */
    }
  }, [stopAll]);

  const toggle = useCallback(() => {
    if (activeRef.current) {
      if (phaseRef.current === "speaking" || phaseRef.current === "thinking") {
        interrupt(); // barge-in: cut JARVIS off and go back to listening
      } else {
        stopAll(); // listening → end the conversation
      }
      return;
    }
    setErrorMsg("");
    // Unlock audio inside the click gesture (WebAudio + <audio> autoplay policy).
    const snd = sounds();
    snd.resume();
    snd.listenStart();
    if (!audioRef.current) audioRef.current = new Audio();
    snd.connectAudioElement(audioRef.current);
    activeRef.current = true;
    // No Web Speech API (iOS Safari) -> MediaRecorder + server Whisper.
    if (!getSpeechRecognitionCtor()) {
      if (!getMediaRecorderCtor()) {
        activeRef.current = false;
        setErrorMsg("Voice unavailable in this browser.");
        setPhaseBoth("error");
        return;
      }
      whisperModeRef.current = true;
      startListening();
      return;
    }
    whisperModeRef.current = false;
    const rec = ensureRecognition();
    if (!rec) {
      activeRef.current = false;
      setErrorMsg("Voice input needs Chrome or Edge.");
      setPhaseBoth("error");
      return;
    }
    startListening();
  }, [ensureRecognition, interrupt, sounds, startListening, stopAll, setPhaseBoth]);

  // Tear down on unmount.
  useEffect(() => {
    return () => {
      activeRef.current = false;
      if (silenceTimerRef.current !== null) window.clearTimeout(silenceTimerRef.current);
      if (researchTimerRef.current !== null) window.clearTimeout(researchTimerRef.current);
      const rec = recognitionRef.current;
      if (rec) {
        try {
          rec.abort();
        } catch {
          /* ignore */
        }
      }
      const audio = audioRef.current;
      if (audio) {
        try {
          audio.pause();
        } catch {
          /* ignore */
        }
      }
      if (soundsRef.current) soundsRef.current.dispose();
    };
  }, []);

  const active = phase !== "idle" && phase !== "error";
  const working = phase === "thinking";
  const statusText = !supported
    ? "Voice needs Chrome / Edge"
    : working
      ? researching
        ? "Researching…"
        : "Thinking…"
      : phase === "listening"
        ? "Listening…"
        : phase === "speaking"
          ? "JARVIS is speaking…"
          : phase === "error"
            ? errorMsg || "Voice unavailable"
            : "Tap to talk to JARVIS";
  const showTranscript = active || lines.length > 0 || interim.length > 0;

  return (
    <div className="relative grid min-h-0 w-full flex-1 place-items-center">
      {/* Orb — the whole orb is one big tap target (easier on mobile) */}
      <div
        role="button"
        tabIndex={0}
        aria-label={
          phase === "speaking" || phase === "thinking"
            ? "Interrupt JARVIS and speak"
            : active
              ? "Stop voice conversation"
              : "Start voice conversation"
        }
        onClick={toggle}
        title={
          active
            ? "Tap to interrupt / stop"
            : "Tap to talk · tap again while JARVIS speaks to interrupt"
        }
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        }}
        className={cn(
          "group relative mx-auto grid aspect-square h-full max-h-full w-auto max-w-full place-items-center overflow-visible outline-none",
          supported ? "cursor-pointer" : "cursor-not-allowed",
        )}
      >
        <VoiceOrbCanvas phase={phase} researching={researching} getLevel={() => soundsRef.current?.level() ?? 0} />

        <div
          className={cn(
            "pointer-events-none relative z-10 flex h-[30%] w-[30%] items-center justify-center rounded-full border bg-[#02090c]/40 backdrop-blur-[2px] transition group-hover:scale-[1.05] group-focus-visible:ring-2 group-focus-visible:ring-cyan-300/60",
            !supported && "opacity-50",
            phase === "listening"
              ? "border-emerald-200/50 text-emerald-50"
              : working
                ? researching
                  ? "border-amber-200/60 text-amber-50"
                  : "border-sky-200/50 text-sky-50"
                : phase === "speaking"
                  ? "border-cyan-100/60 text-cyan-50"
                  : phase === "error"
                    ? "border-rose-300/60 text-rose-100"
                    : "border-cyan-200/40 text-cyan-50 group-hover:border-cyan-100/70",
          )}
        >
          {working ? (
            researching ? (
              <Radar className="relative h-[30%] w-[30%] max-h-14 max-w-14 animate-pulse" />
            ) : (
              <Loader2 className="relative h-[30%] w-[30%] max-h-14 max-w-14 animate-spin" />
            )
          ) : phase === "speaking" ? (
            <AudioLines className="relative h-[30%] w-[30%] max-h-14 max-w-14" />
          ) : phase === "error" || !supported ? (
            <MicOff className="relative h-[30%] w-[30%] max-h-14 max-w-14" />
          ) : (
            <Mic className="relative h-[30%] w-[30%] max-h-14 max-w-14" />
          )}
        </div>

        {/* Phase caption (on-screen status) */}
        <div
          className={cn(
            "absolute bottom-[13%] left-1/2 z-10 max-w-[86%] -translate-x-1/2 text-center text-[11px] font-medium uppercase tracking-[0.22em] max-sm:bottom-auto max-sm:top-[6%]",
            phase === "error" ? "text-rose-300/90" : researching ? "text-amber-300" : "text-muted-foreground",
          )}
        >
          {statusText}
        </div>
        {/* Gateway / sessions pill (full chrome only) */}
        {!bare && (
          <div className="absolute bottom-[6%] left-1/2 z-10 -translate-x-1/2 rounded-full border border-border/45 bg-background/70 px-3 py-1 text-[10px] uppercase tracking-[0.22em] text-muted-foreground backdrop-blur max-sm:hidden">
            {gatewayRunning ? "gateway online" : "gateway offline"} · {workCount} sessions
            {!ttsReady && " · voice output off"}
            {ttsReady && muted && " · muted"}
          </div>
        )}

        {/* Bare mode: project-context chip (references the clicked map project) */}
        {bare && context && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onClearContext?.();
            }}
            title="Stop referencing this project"
            className="pointer-events-auto absolute left-1/2 top-[1%] z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-cyan-300/40 bg-[#02090c]/70 px-3 py-1 text-[10px] font-medium tracking-[0.1em] text-cyan-200 backdrop-blur transition hover:border-cyan-200/70"
          >
            <Radar className="h-3 w-3" />
            {context}
            <X className="h-3 w-3 opacity-70" />
          </button>
        )}
      </div>

      {/* Live transcript — floats over the orb in full mode; in bare (dock) mode
          it's a PERSISTENT panel to the LEFT of the orb (always visible, fills
          in real time as you talk) so it never covers the orb. */}
      {(bare || showTranscript) && (
        <div
          className={cn(
            "z-20 flex flex-col overflow-hidden",
            bare
              ? "vc-live-left"
              : "absolute inset-x-2 bottom-2 max-h-[46%] rounded-2xl border border-cyan-300/20 bg-background/85 shadow-[0_0_40px_rgba(34,211,238,0.10)] backdrop-blur sm:inset-x-auto sm:bottom-auto sm:right-3 sm:top-3 sm:w-60 lg:max-h-[62%] lg:w-60",
          )}
        >
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/40 px-3 py-1.5">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  active ? "animate-pulse bg-emerald-400" : "bg-muted-foreground/40",
                )}
              />
              Transcript
            </div>
            <div className="flex items-center gap-0.5">
              <button
                onClick={() => setMuted((m) => !m)}
                aria-label={muted ? "Unmute JARVIS voice" : "Mute JARVIS voice (text only)"}
                title={muted ? "Voice output off — tap to unmute" : "Mute voice (text only)"}
                className={cn(
                  "rounded-md p-0.5 outline-none transition focus-visible:ring-1 focus-visible:ring-cyan-300/60",
                  muted ? "text-amber-300 hover:text-amber-200" : "text-muted-foreground hover:text-primary",
                )}
              >
                {muted ? <VolumeX className="h-3 w-3" /> : <Volume2 className="h-3 w-3" />}
              </button>
              {(active || lines.length > 0) && (
                <button
                  onClick={endAndClear}
                  aria-label="End and clear conversation"
                  title="End & clear — start a fresh conversation"
                  className="rounded-md p-0.5 text-muted-foreground outline-none transition hover:text-rose-300 focus-visible:ring-1 focus-visible:ring-rose-300/60"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          </div>
          <div ref={scrollRef} aria-live="polite" aria-atomic="false" className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-3 py-2">
            {lines.length === 0 && !interim && !working && (
              <div className="text-[15px] italic text-muted-foreground/70 sm:text-xs">
                {whisperModeRef.current && active ? "Listening… tap the orb when done" : "Say something…"}
              </div>
            )}
            {lines.map((l) => (
              <div key={l.id} className="text-[15px] leading-snug sm:text-xs sm:leading-relaxed">
                <span
                  className={cn(
                    "mr-1 font-semibold",
                    l.role === "you" ? "text-emerald-300" : "text-cyan-300",
                  )}
                >
                  {l.role === "you" ? "You" : "JARVIS"}
                </span>
                <span className="text-foreground/90">{l.text}</span>
              </div>
            ))}
            {interim && (
              <div className="text-[15px] font-medium leading-snug text-foreground sm:text-xs sm:italic sm:font-normal sm:text-muted-foreground/70">
                <span className="mr-1 font-semibold text-emerald-300/70">You</span>
                {interim}
              </div>
            )}
            {/* In-chat status while JARVIS is working */}
            {working && (
              <div className="flex items-center gap-1.5 text-xs leading-relaxed">
                <span className={cn("font-semibold", researching ? "text-amber-300" : "text-cyan-300")}>JARVIS</span>
                <span className={cn("inline-flex items-center gap-1", researching ? "text-amber-300/90" : "text-muted-foreground")}>
                  {researching ? <Radar className="h-3 w-3 animate-pulse" /> : <Loader2 className="h-3 w-3 animate-spin" />}
                  {researching ? "researching…" : "thinking…"}
                </span>
              </div>
            )}
          </div>
          {errorMsg && (
            <div className="shrink-0 border-t border-border/40 px-3 py-1.5 text-[10px] text-rose-300/90">{errorMsg}</div>
          )}
        </div>
      )}
    </div>
  );
}

export default VoiceConsole;
