import { useEffect, useMemo, useRef, useState } from "react";
import { formatCountdown, getCountdownTarget, getEventDisplayState, getRemainingMilliseconds } from "@/lib/eventTiming";
import { useEventChat } from "@/hooks/useEventChat";
import { useCurrentEvent } from "@/hooks/useCurrentEvent";
import {
  ChatSubmissionError,
  getEventListenerCount,
  joinEventChatIdentity,
  sendVisitorMessage,
} from "@/services/chatService";
import {
  getAudioObjectPath,
  getPublicImageUrl,
  getSafeSupabaseSessionState,
  getSignedAudioUrl,
  getSignedAudioUrlViaRestDiagnostic,
  getSupabaseProjectHost,
  SignedAudioUrlTimeoutError,
} from "@/services/storageService";
import type { ChatMessage } from "@/types/chat";
import type { MusicEvent } from "@/types/event";

const GREEN = "#00FF41";
const BG = "#000000";
const VT = "'VT323', monospace";
const PSP = "'Press Start 2P', cursive";

type DisplayState = "upcoming" | "live" | "finished";
type AudioSourceStatus = "idle" | "loading" | "ready" | "error";
type AudioSigningEffectStatus = "idle" | "entered" | "skipped";
type AudioSigningRequestStatus = "idle" | "loading" | "resolved" | "rejected" | "timed-out" | "cancelled";

type AudioUrlPipelineDiagnostics = {
  eventId: string | null;
  eventStatus: string | null;
  state: DisplayState;
  audioPath: string | null;
  audioPathPresent: boolean;
  signingEffect: AudioSigningEffectStatus;
  signingRequest: AudioSigningRequestStatus;
  finalAudioUrlPresent: boolean;
  lastSafeErrorMessage: string;
  sourceIdentity: string;
  requestId: number | null;
  requestStartedAt: string;
  requestElapsedMs: number | null;
  retryCount: number;
  sessionState: string;
  online: boolean | null;
  resultIgnored: boolean;
  resultIgnoredReason: string;
  normalizedAudioPath: string | null;
  projectHost: string;
  directRestState: string;
  directRestElapsedMs: number | null;
  directRestAudioUrlPresent: boolean;
  directRestError: string;
};

const CHAT_NAME_KEY_PREFIX = "music-event-chat-name:";
const CHAT_PARTICIPANT_KEY_PREFIX = "music-event-chat-participant:";
const LEGACY_CHAT_IDENTITY_KEYS = ["live-chat-name", "chat-name", "username", "joined-chat"];

type JoinedChatIdentity = {
  participantId: string;
  sessionId: string;
  displayName: string;
  joinedAt?: string;
};

function pad2(value: number) {
  return String(Math.floor(value)).padStart(2, "0");
}

function splitMs(ms: number) {
  return formatCountdown(ms);
}

function fmtSecs(seconds: number) {
  return `${pad2(Math.floor(seconds / 60))}:${pad2(seconds % 60)}`;
}

function sanitizeUrlForLog(value: string) {
  if (!value) return "";
  try {
    const url = new URL(value);
    return url.pathname;
  } catch {
    return value.split("?")[0]?.split("#")[0] ?? "";
  }
}

function getErrorLogInfo(error: unknown) {
  return {
    errorName: error instanceof Error ? error.name : "UnknownError",
    errorMessage: error instanceof Error ? error.message : String(error),
  };
}

function logAudioUrlPipeline(message: string, details: Record<string, unknown>) {
  console.info(`[audio-url-pipeline] ${message}`, details);
}

function GlobalStyles() {
  const css = `
    @keyframes glitch {
      0%, 84%, 100% { transform: none; text-shadow: none; }
      85% { transform: translateX(-4px); text-shadow: 4px 0 ${GREEN}, -2px 0 #FF0000; }
      87% { transform: translateX(4px); text-shadow: -4px 0 ${GREEN}, 2px 0 #FF0000; }
      89% { transform: translateY(-2px); text-shadow: 0 3px #0033FF; }
      91% { transform: none; text-shadow: none; }
    }
    @keyframes cursorBlink {
      0%, 100% { opacity: 1; }
      50% { opacity: 0; }
    }
    .glitch-anim { animation: glitch 7s infinite; }
    .cursor-blink { animation: cursorBlink 1s step-end infinite; }
    .public-event-shell * { cursor: crosshair !important; box-sizing: border-box; }
    .public-event-shell input, .public-event-shell textarea { cursor: text !important; }
    .public-event-shell ::-webkit-scrollbar { display: none; }
    .public-event-shell * { scrollbar-width: none; }
    .live-event-view {
      position: relative;
      min-height: 100vh;
      background: ${BG};
      overflow: hidden;
      padding: 2.2rem 1.75rem 1.25rem;
    }
    .live-event-content {
      position: relative;
      z-index: 10;
      height: calc(100vh - 3.5rem);
      min-height: 0;
      display: flex;
      flex-direction: column;
    }
    .live-chat-layout {
      position: relative;
      flex: 1 1 auto;
      min-height: 0;
    }
    .live-chat-layout--joined {
      display: flex;
      flex-direction: column;
    }
    .live-chat-stream--prejoin {
      position: absolute;
      left: 0;
      right: 0;
      top: 8.1rem;
      bottom: 17rem;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      z-index: 3;
    }
    .live-chat-stream--joined {
      position: relative;
      z-index: 3;
      flex: 1 1 auto;
      min-height: 0;
      display: flex;
      flex-direction: column;
      gap: 0;
    }
    .live-chat__header {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid rgba(0,255,65,0.15);
      padding: 1.25rem 0 0.7rem;
      margin-bottom: 0.5rem;
    }
    .live-chat__messages {
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      overscroll-behavior: contain;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      padding: 0.25rem 0 0.75rem;
    }
    .chat-composer {
      flex: 0 0 auto;
      padding-bottom: calc(max(1rem, env(safe-area-inset-bottom)) + 0.75rem);
      z-index: 30;
      pointer-events: auto;
    }
    .chat-composer__form {
      display: grid;
      gap: 0.5rem;
    }
    .chat-composer__controls {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      border-top: 1px solid rgba(0,255,65,0.1);
      padding-top: 0.7rem;
      min-width: 0;
    }
    .chat-composer__feedback {
      min-height: 1.15rem;
      margin: 0;
      font-family: ${VT};
      font-size: 0.95rem;
      line-height: 1.2;
      overflow-wrap: anywhere;
    }
    @supports (min-height: 100dvh) {
      .public-event-shell,
      .live-event-view {
        min-height: 100dvh;
      }
      .live-event-content {
        height: calc(100dvh - 3.5rem);
      }
    }
    @media (max-width: 640px) {
      .live-event-view {
        height: 100vh;
        padding: 2rem 1.35rem 0;
      }
      .live-event-content,
      .live-chat-layout,
      .live-chat-layout--joined,
      .live-chat-stream--joined {
        min-height: 0;
        overflow: hidden;
      }
      .live-chat-layout,
      .live-chat-layout--joined,
      .live-chat-stream--joined {
        flex: 1 1 0;
      }
      .live-chat__header,
      .chat-composer {
        flex: 0 0 auto;
      }
      .live-chat__messages {
        flex: 1 1 0;
        height: 0;
        min-height: 0;
        overflow-y: auto;
        -webkit-overflow-scrolling: touch;
      }
      .chat-composer {
        padding-bottom: calc(max(1rem, env(safe-area-inset-bottom)) + 0.75rem);
      }
      .chat-composer__form {
        gap: 0.42rem;
      }
      .chat-composer__controls {
        gap: 0.42rem;
      }
      .chat-composer__feedback {
        min-height: 1.35rem;
      }
    }
    @supports (height: 100dvh) {
      @media (max-width: 640px) {
        .live-event-view {
          height: 100dvh;
        }
      }
    }
  `;
  return <style dangerouslySetInnerHTML={{ __html: css }} />;
}

function CRTOverlay() {
  return (
    <div className="fixed inset-0 pointer-events-none" style={{ zIndex: 997 }}>
      <div style={{
        position: "absolute",
        inset: 0,
        backgroundImage: "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.07) 2px, rgba(0,0,0,0.07) 4px)",
      }} />
      <div style={{
        position: "absolute",
        inset: 0,
        background: "radial-gradient(ellipse at 50% 50%, transparent 50%, rgba(0,0,0,0.72) 100%)",
      }} />
    </div>
  );
}

const PLACEHOLDER_SRC = "data:image/svg+xml," + encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">
  <rect width="96" height="96" fill="#0a0a0a"/>
  <rect x="1" y="1" width="94" height="94" fill="none" stroke="#00FF41" stroke-width="2"/>
  <rect x="3" y="3" width="6" height="6" fill="#00FF41"/>
  <rect x="87" y="3" width="6" height="6" fill="#00FF41"/>
  <rect x="3" y="87" width="6" height="6" fill="#00FF41"/>
  <rect x="87" y="87" width="6" height="6" fill="#00FF41"/>
  <line x1="20" y1="20" x2="76" y2="76" stroke="#00FF41" stroke-width="1" opacity="0.3"/>
  <line x1="76" y1="20" x2="20" y2="76" stroke="#00FF41" stroke-width="1" opacity="0.3"/>
  <text x="48" y="54" font-family="monospace" font-size="9" fill="#00FF41" text-anchor="middle" opacity="0.6">artist</text>
</svg>`);

function DVDBounce({ imageUrl }: { imageUrl: string }) {
  const size = 96;
  const height = size * 1.25;
  const [pos, setPos] = useState({ x: 180, y: 130 });
  const velocity = useRef({ x: 2.2, y: 1.75 });

  useEffect(() => {
    let raf: number;
    const tick = () => {
      setPos(previous => {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        let nextX = previous.x + velocity.current.x;
        let nextY = previous.y + velocity.current.y;

        if (nextX <= 0 || nextX >= vw - size) {
          velocity.current.x *= -1;
          nextX = Math.max(0, Math.min(vw - size, nextX));
        }

        if (nextY <= 0 || nextY >= vh - height) {
          velocity.current.y *= -1;
          nextY = Math.max(0, Math.min(vh - height, nextY));
        }

        return { x: nextX, y: nextY };
      });
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const src = imageUrl.trim() || PLACEHOLDER_SRC;

  return (
    <div style={{ position: "fixed", left: pos.x, top: pos.y, zIndex: 50, pointerEvents: "none", width: size, height }}>
      <img
        src={src}
        alt=""
        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", imageRendering: "pixelated", opacity: 0.82 }}
      />
    </div>
  );
}

function Artwork({ size = 360, imageUrl = "" }: { size?: number; imageUrl?: string }) {
  const corners = [
    { top: -2, left: -2 },
    { top: -2, right: -2 },
    { bottom: -2, left: -2 },
    { bottom: -2, right: -2 },
  ];

  return (
    <div style={{
      width: size,
      height: size,
      maxWidth: "min(82vw, 82vmin)",
      maxHeight: "min(82vw, 82vmin)",
      border: `2px solid ${GREEN}`,
      position: "relative",
      flexShrink: 0,
      overflow: "hidden",
      background: imageUrl ? "transparent" : BG,
    }}>
      {imageUrl && <img src={imageUrl} alt="Artwork" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />}
      {corners.map((corner, index) => (
        <div key={index} style={{ position: "absolute", width: 8, height: 8, background: GREEN, zIndex: 1, ...corner }} />
      ))}
    </div>
  );
}

function Countdown({ target, mode = "countdown" }: { target: string | null; mode?: "countdown" | "remaining" }) {
  const [remaining, setRemaining] = useState(() => getRemainingMilliseconds(target));

  useEffect(() => {
    const id = window.setInterval(() => {
      setRemaining(getRemainingMilliseconds(target));
    }, 50);
    return () => window.clearInterval(id);
  }, [target]);

  if (!target) return <span>soon</span>;
  const { hours, minutes, seconds } = splitMs(remaining);
  const centiseconds = Math.floor((remaining % 1000) / 10);
  const label = mode === "remaining" && remaining === 0 ? "live" : `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}:${pad2(centiseconds)}`;

  return (
    <span style={{
      fontFamily: PSP,
      fontSize: "clamp(1.1rem, 5.5vw, 2.8rem)",
      color: "#FFFFFF",
      letterSpacing: "0.04em",
      lineHeight: 1.3,
    }}>
      {label}
    </span>
  );
}

type NativeAudioDiagnostics = {
  audioUrlPresent: boolean;
  readyState: number;
  networkState: number;
  duration: number | string;
  paused: boolean;
  muted: boolean;
  volume: number;
  currentTime: number;
  mediaErrorCode: number | string;
  loadedmetadataFired: boolean;
  canplayFired: boolean;
  playFired: boolean;
  playingFired: boolean;
  pauseFired: boolean;
  errorFired: boolean;
};

function AudioPlayer(props: { audioUrl: string; startsAt: string | null; sourceStatus: AudioSourceStatus; pipelineDiagnostics: AudioUrlPipelineDiagnostics }) {
  const nativeAudioTest = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("nativeAudioTest") === "1";
  if (nativeAudioTest) return <NativeAudioTestPlayer audioUrl={props.audioUrl} sourceStatus={props.sourceStatus} pipelineDiagnostics={props.pipelineDiagnostics} />;
  return <CustomAudioPlayer audioUrl={props.audioUrl} sourceStatus={props.sourceStatus} startsAt={props.startsAt} />;
}

function NativeAudioTestPlayer({ audioUrl, sourceStatus, pipelineDiagnostics }: { audioUrl: string; sourceStatus: AudioSourceStatus; pipelineDiagnostics: AudioUrlPipelineDiagnostics }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [diagnostics, setDiagnostics] = useState<NativeAudioDiagnostics>({
    audioUrlPresent: Boolean(audioUrl),
    readyState: 0,
    networkState: 0,
    duration: "n/a",
    paused: true,
    muted: false,
    volume: 1,
    currentTime: 0,
    mediaErrorCode: "none",
    loadedmetadataFired: false,
    canplayFired: false,
    playFired: false,
    playingFired: false,
    pauseFired: false,
    errorFired: false,
  });

  const updateDiagnostics = (eventName?: keyof Pick<NativeAudioDiagnostics, "loadedmetadataFired" | "canplayFired" | "playFired" | "playingFired" | "pauseFired" | "errorFired">) => {
    const audio = audioRef.current;
    setDiagnostics(previous => ({
      ...previous,
      ...(eventName ? { [eventName]: true } : {}),
      audioUrlPresent: Boolean(audioUrl),
      readyState: audio?.readyState ?? 0,
      networkState: audio?.networkState ?? 0,
      duration: Number.isFinite(audio?.duration) ? Number((audio?.duration ?? 0).toFixed(3)) : "n/a",
      paused: audio?.paused ?? true,
      muted: audio?.muted ?? false,
      volume: audio?.volume ?? 1,
      currentTime: Number((audio?.currentTime ?? 0).toFixed(3)),
      mediaErrorCode: audio?.error?.code ?? "none",
    }));
  };

  useEffect(() => {
    console.info("AUDIO ELEMENT MOUNTED");
    updateDiagnostics();
    return () => {
      console.info("AUDIO ELEMENT UNMOUNTED");
    };
  }, []);

  useEffect(() => {
    console.info("AUDIO SRC CHANGED", {
      audioUrlPresent: Boolean(audioUrl),
      audioUrlPath: sanitizeUrlForLog(audioUrl),
    });
    updateDiagnostics();
  }, [audioUrl]);

  const rows: Array<[string, string]> = [
    ["event audio path present", pipelineDiagnostics.audioPathPresent ? "yes" : "no"],
    ["signing effect", pipelineDiagnostics.signingEffect],
    ["signing request", pipelineDiagnostics.signingRequest],
    ["request ID", pipelineDiagnostics.requestId === null ? "none" : String(pipelineDiagnostics.requestId)],
    ["started", pipelineDiagnostics.requestStartedAt || "none"],
    ["elapsed ms", pipelineDiagnostics.requestElapsedMs === null ? "n/a" : String(pipelineDiagnostics.requestElapsedMs)],
    ["retry count", String(pipelineDiagnostics.retryCount)],
    ["session", pipelineDiagnostics.sessionState],
    ["online", pipelineDiagnostics.online === null ? "unknown" : pipelineDiagnostics.online ? "yes" : "no"],
    ["result ignored", pipelineDiagnostics.resultIgnored ? `yes: ${pipelineDiagnostics.resultIgnoredReason}` : "no"],
    ["normalized path", pipelineDiagnostics.normalizedAudioPath ?? "none"],
    ["project host", pipelineDiagnostics.projectHost || "unknown"],
    ["direct REST state", pipelineDiagnostics.directRestState],
    ["direct REST elapsed ms", pipelineDiagnostics.directRestElapsedMs === null ? "n/a" : String(pipelineDiagnostics.directRestElapsedMs)],
    ["direct REST URL present", pipelineDiagnostics.directRestAudioUrlPresent ? "yes" : "no"],
    ["direct REST error", pipelineDiagnostics.directRestError || "none"],
    ["final audio URL present", pipelineDiagnostics.finalAudioUrlPresent ? "yes" : "no"],
    ["last safe error", pipelineDiagnostics.lastSafeErrorMessage || "none"],
    ["source identity", pipelineDiagnostics.sourceIdentity],
    ["audio URL present", diagnostics.audioUrlPresent ? "yes" : "no"],
    ["readyState", String(diagnostics.readyState)],
    ["networkState", String(diagnostics.networkState)],
    ["duration", String(diagnostics.duration)],
    ["paused", diagnostics.paused ? "yes" : "no"],
    ["muted", diagnostics.muted ? "yes" : "no"],
    ["volume", String(diagnostics.volume)],
    ["currentTime", String(diagnostics.currentTime)],
    ["media error code", String(diagnostics.mediaErrorCode)],
    ["loadedmetadata fired", diagnostics.loadedmetadataFired ? "yes" : "no"],
    ["canplay fired", diagnostics.canplayFired ? "yes" : "no"],
    ["play fired", diagnostics.playFired ? "yes" : "no"],
    ["playing fired", diagnostics.playingFired ? "yes" : "no"],
    ["pause fired", diagnostics.pauseFired ? "yes" : "no"],
    ["error fired", diagnostics.errorFired ? "yes" : "no"],
  ];

  return (
    <div style={{ display: "grid", gap: "0.65rem", width: "100%", minWidth: "4.5rem" }}>
      {audioUrl ? (
        <audio
          ref={audioRef}
          src={audioUrl}
          controls
          playsInline
          preload="auto"
          onLoadedMetadata={() => updateDiagnostics("loadedmetadataFired")}
          onCanPlay={() => updateDiagnostics("canplayFired")}
          onPlay={() => updateDiagnostics("playFired")}
          onPlaying={() => updateDiagnostics("playingFired")}
          onPause={() => updateDiagnostics("pauseFired")}
          onError={() => updateDiagnostics("errorFired")}
          onTimeUpdate={() => updateDiagnostics()}
          onDurationChange={() => updateDiagnostics()}
          onVolumeChange={() => updateDiagnostics()}
          style={{ width: "100%", maxWidth: "min(100%, 24rem)" }}
        />
      ) : (
        <p style={{ fontFamily: VT, color: sourceStatus === "error" ? "#ff5c5c" : "rgba(0,255,65,0.65)", fontSize: "1rem" }}>
          {sourceStatus === "loading" ? "loading native audio..." : "native audio unavailable"}
        </p>
      )}
      <div style={{ display: "grid", gap: "0.2rem", fontFamily: VT, fontSize: "0.9rem", color: "rgba(255,255,255,0.7)", letterSpacing: "0.04em" }}>
        {rows.map(([label, value]) => (
          <div key={label} style={{ display: "flex", justifyContent: "space-between", gap: "1rem", borderBottom: "1px solid rgba(0,255,65,0.08)", paddingBottom: "0.1rem" }}>
            <span style={{ color: "rgba(0,255,65,0.65)" }}>{label}:</span>
            <span>{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function CustomAudioPlayer({ audioUrl, startsAt, sourceStatus }: { audioUrl: string; startsAt: string | null; sourceStatus: AudioSourceStatus }) {
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const audioRef = useRef<HTMLAudioElement>(null);

  const getUsableDuration = () => {
    const mediaDuration = audioRef.current?.duration;
    if (Number.isFinite(mediaDuration) && mediaDuration && mediaDuration > 0) {
      return mediaDuration;
    }
    return duration > 0 ? duration : 0;
  };

  const getLivePosition = (usableDuration = getUsableDuration()) => {
    if (!startsAt || usableDuration <= 0) return 0;
    const startedAt = new Date(startsAt).getTime();
    if (Number.isNaN(startedAt)) return 0;
    const elapsed = Math.max(0, (Date.now() - startedAt) / 1000);
    return elapsed % usableDuration;
  };

  const initializeMediaDuration = () => {
    const usableDuration = getUsableDuration();
    if (usableDuration <= 0) return 0;
    setDuration(usableDuration);
    setProgress(getLivePosition(usableDuration));
    return usableDuration;
  };

  const handleMediaReady = () => {
    const usableDuration = initializeMediaDuration();
    if (usableDuration > 0) syncToLive(false);
  };

  const syncToLive = (force = false) => {
    const audio = audioRef.current;
    const usableDuration = getUsableDuration();
    if (!audio || usableDuration <= 0) return;
    const nextPosition = getLivePosition(usableDuration);
    const directDrift = Math.abs(audio.currentTime - nextPosition);
    const loopDrift = usableDuration - directDrift;
    const drift = Math.min(directDrift, loopDrift);
    if (force || drift > 1.5) {
      audio.currentTime = nextPosition;
    }
    setProgress(nextPosition);
  };

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio || !audioUrl) return;
    if (!audio.paused) {
      audio.pause();
      return;
    }

    try {
      audio.muted = false;
      audio.volume = 1;
    } catch (error) {
      console.warn("Live audio volume restore failed", getErrorLogInfo(error));
    }

    audio.play()
      .then(() => {
        const usableDuration = initializeMediaDuration();
        if (usableDuration <= 0) return;
        try {
          syncToLive(true);
        } catch (error) {
          console.error("Live audio synchronization failed", {
            ...getErrorLogInfo(error),
            readyState: audio.readyState,
            networkState: audio.networkState,
            paused: audio.paused,
            muted: audio.muted,
            volume: audio.volume,
            duration: audio.duration,
            currentSrc: sanitizeUrlForLog(audio.currentSrc),
            targetPosition: getLivePosition(usableDuration),
            audioUrlExists: Boolean(audioUrl),
          });
        }
      })
      .catch(error => {
        console.error("Live audio playback failed", {
          ...getErrorLogInfo(error),
          readyState: audio.readyState,
          networkState: audio.networkState,
          paused: audio.paused,
          muted: audio.muted,
          volume: audio.volume,
          duration: audio.duration,
          currentSrc: sanitizeUrlForLog(audio.currentSrc),
          targetPosition: null,
          audioUrlExists: Boolean(audioUrl),
        });
      });
  };

  useEffect(() => {
    const onVisibility = () => {
      if (!document.hidden) syncToLive(false);
    };

    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [audioUrl, startsAt]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audioUrl || !audio) return;
    if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
      handleMediaReady();
    }
  }, [audioUrl, startsAt]);

  useEffect(() => {
    const id = window.setInterval(() => {
      const usableDuration = getUsableDuration();
      if (usableDuration <= 0) return;
      const livePosition = getLivePosition(usableDuration);
      setProgress(livePosition);
      if (playing) syncToLive(false);
    }, 500);
    return () => window.clearInterval(id);
  }, [duration, playing, startsAt]);

  const usableDuration = getUsableDuration();
  const pct = usableDuration > 0 ? (progress / usableDuration) * 100 : 0;
  const sourceLabel = sourceStatus === "loading" ? "loading audio" : sourceStatus === "error" ? "audio unavailable" : "";
  const disabled = !audioUrl;

  return (
    <div style={{ width: "100%", minWidth: "4.5rem" }}>
      {audioUrl && (
        <audio
          ref={audioRef}
          src={audioUrl}
          loop
          playsInline
          preload="metadata"
          onLoadedMetadata={handleMediaReady}
          onDurationChange={handleMediaReady}
          onCanPlay={handleMediaReady}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onError={() => {
            const audio = audioRef.current;
            console.error("Live audio element error", {
              readyState: audio?.readyState,
              networkState: audio?.networkState,
              paused: audio?.paused,
              muted: audio?.muted,
              volume: audio?.volume,
              duration: audio?.duration,
              currentSrc: sanitizeUrlForLog(audio?.currentSrc ?? ""),
              errorCode: audio?.error?.code,
              errorMessage: audio?.error?.message,
              audioUrlExists: Boolean(audioUrl),
            });
          }}
        />
      )}
      <div style={{ display: "flex", alignItems: "center", gap: "clamp(0.25rem, 1.2vw, 0.7rem)", minWidth: 0 }}>
        <button
          type="button"
          onClick={toggle}
          disabled={disabled}
          aria-label={playing ? "Pause live audio" : "Resume live audio"}
          style={{
            fontFamily: VT,
            fontSize: "clamp(0.95rem, 4vw, 1.35rem)",
            color: disabled ? "rgba(255,255,255,0.28)" : "#FFFFFF",
            background: "none",
            border: "none",
            padding: 0,
            letterSpacing: "0.08em",
            width: "2.75rem",
            minWidth: "2.75rem",
            height: "2.75rem",
            display: "grid",
            placeItems: "center",
            flex: "0 0 auto",
            position: "relative",
            zIndex: 30,
            pointerEvents: "auto",
            touchAction: "manipulation",
            WebkitTapHighlightColor: "transparent",
          }}
        >
          {playing ? "■" : "▶"}
        </button>
        {sourceLabel && (
          <span style={{ fontFamily: VT, color: sourceStatus === "error" ? "#ff5c5c" : "rgba(0,255,65,0.55)", fontSize: "0.95rem", letterSpacing: "0.04em", whiteSpace: "nowrap" }}>
            {sourceLabel}
          </span>
        )}
        <div
          role="progressbar"
          aria-label={`Live audio position ${fmtSecs(Math.floor(progress))}`}
          aria-valuemin={0}
          aria-valuemax={usableDuration || 0}
          aria-valuenow={progress}
          style={{ minWidth: "2.25rem", flex: "1 1 auto", height: "2px", background: "rgba(0,255,65,0.18)", position: "relative", pointerEvents: "none" }}
        >
          <div style={{ position: "absolute", left: 0, top: 0, height: "100%", width: `${pct}%`, background: GREEN, transition: "width 0.4s linear" }} />
        </div>
      </div>
    </div>
  );
}

function CompactLiveCountdown({ target }: { target: string | null }) {
  const [remaining, setRemaining] = useState(() => getRemainingMilliseconds(target));

  useEffect(() => {
    const id = window.setInterval(() => {
      setRemaining(getRemainingMilliseconds(target));
    }, 1000);
    return () => window.clearInterval(id);
  }, [target]);

  if (!target) return null;

  const totalSeconds = Math.ceil(remaining / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const label = days > 0
    ? `${days}d:${pad2(hours)}:${pad2(minutes)}`
    : hours > 0
      ? `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`
      : `${pad2(minutes)}:${pad2(seconds)}`;
  const accessible = days > 0
    ? `Event ends in ${days} days, ${hours} hours, and ${minutes} minutes`
    : hours > 0
      ? `Event ends in ${hours} hours, ${minutes} minutes, and ${seconds} seconds`
      : `Event ends in ${minutes} minutes and ${seconds} seconds`;

  return (
    <span
      aria-label={accessible}
      style={{
        fontFamily: VT,
        color: "rgba(0,255,65,0.52)",
        fontSize: "clamp(0.85rem, 2.8vw, 1.15rem)",
        letterSpacing: "0.04em",
        fontVariantNumeric: "tabular-nums",
        whiteSpace: "nowrap",
        minWidth: days > 0 || hours > 0 ? "8ch" : "5.5ch",
        textAlign: "right",
      }}
    >
      live ends {label}
    </span>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="public-event-shell" style={{ position: "relative", minHeight: "100vh", background: BG, color: "#fff", overflow: "hidden" }}>
      <GlobalStyles />
      <CRTOverlay />
      {children}
    </main>
  );
}

function getEventChatNameKey(eventId: string) {
  return `${CHAT_NAME_KEY_PREFIX}${eventId}`;
}

function getEventChatParticipantKey(eventId: string) {
  return `${CHAT_PARTICIPANT_KEY_PREFIX}${eventId}`;
}

function readStoredChatIdentity(eventId: string): JoinedChatIdentity | null {
  const participantValue = window.localStorage.getItem(getEventChatParticipantKey(eventId));
  if (participantValue) {
    try {
      const parsed = JSON.parse(participantValue) as Partial<JoinedChatIdentity>;
      if (parsed.participantId && parsed.sessionId && parsed.displayName) {
        return {
          participantId: parsed.participantId,
          sessionId: parsed.sessionId,
          displayName: parsed.displayName,
          joinedAt: parsed.joinedAt,
        };
      }
    } catch {
      window.localStorage.removeItem(getEventChatParticipantKey(eventId));
    }
  }

  return null;
}

function storeChatIdentity(eventId: string, identity: JoinedChatIdentity) {
  window.localStorage.setItem(getEventChatParticipantKey(eventId), JSON.stringify(identity));
  window.localStorage.setItem(getEventChatNameKey(eventId), identity.displayName);
}

function removeEventChatIdentity(eventId: string) {
  window.localStorage.removeItem(getEventChatParticipantKey(eventId));
  window.localStorage.removeItem(getEventChatNameKey(eventId));
}

function removeLegacyChatIdentity() {
  for (const key of LEGACY_CHAT_IDENTITY_KEYS) {
    window.localStorage.removeItem(key);
  }
}

function getAudioSourceIdentity(eventId: string | null, audioPath: string | null) {
  return `${eventId ?? "no-event"}:${audioPath || "no-audio-path"}`;
}

function getAudioSourceKey(eventId: string | null, audioPath: string | null) {
  return eventId && audioPath ? `${eventId}::${audioPath}` : "";
}

function getSafeAudioObjectPath(path: string | null | undefined) {
  const rawAudioPath = path ?? "";
  if (!rawAudioPath.trim()) return null;
  try {
    return getAudioObjectPath(rawAudioPath);
  } catch {
    return null;
  }
}

export default function PublicEventPage() {
  const { event, loading, error } = useCurrentEvent();
  const nativeAudioTest = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("nativeAudioTest") === "1";
  const [audioUrl, setAudioUrl] = useState("");
  const [audioSourceStatus, setAudioSourceStatus] = useState<AudioSourceStatus>("idle");
  const [audioPipelineDiagnostics, setAudioPipelineDiagnostics] = useState<AudioUrlPipelineDiagnostics>({
    eventId: null,
    eventStatus: null,
    state: "upcoming",
    audioPath: null,
    audioPathPresent: false,
    signingEffect: "idle",
    signingRequest: "idle",
    finalAudioUrlPresent: false,
    lastSafeErrorMessage: "",
    sourceIdentity: getAudioSourceIdentity(null, null),
    requestId: null,
    requestStartedAt: "",
    requestElapsedMs: null,
    retryCount: 0,
    sessionState: "unknown",
    online: null,
    resultIgnored: false,
    resultIgnoredReason: "",
    normalizedAudioPath: null,
    projectHost: "",
    directRestState: "idle",
    directRestElapsedMs: null,
    directRestAudioUrlPresent: false,
    directRestError: "",
  });
  const [now, setNow] = useState(new Date());
  const previousEventId = useRef<string | null>(null);
  const audioSigningRequestId = useRef(0);
  const audioUrlRef = useRef("");
  const audioSourceRef = useRef<{ eventId: string | null; audioPath: string | null }>({ eventId: null, audioPath: null });
  const activeAudioSourceKeyRef = useRef("");
  const signedAudioCache = useRef<{ eventId: string; audioPath: string; url: string } | null>(null);
  const inFlightSigningRequests = useRef<Map<string, Promise<string>>>(new Map());
  const state = event ? getEventDisplayState(event, now) : "upcoming";
  const authoritativeState = event?.status ?? "upcoming";
  const waitingForLiveStatus = state === "live" && authoritativeState === "upcoming";
  const [joinedIdentity, setJoinedIdentity] = useState<JoinedChatIdentity | null>(null);
  const [listenerCount, setListenerCount] = useState<number | null>(null);
  const chatViewer = useMemo(() => joinedIdentity ? {
    participantId: joinedIdentity.participantId,
    sessionId: joinedIdentity.sessionId,
  } : null, [joinedIdentity]);
  const chat = useEventChat(state === "live" ? event?.id : undefined, "public", chatViewer);

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    removeLegacyChatIdentity();
  }, []);

  useEffect(() => {
    setJoinedIdentity(event?.id ? readStoredChatIdentity(event.id) : null);
  }, [event?.id]);

  useEffect(() => {
    const eventId = event?.id;
    if (!eventId || state !== "live") {
      setListenerCount(null);
      return;
    }

    let cancelled = false;
    async function loadListenerCount() {
      try {
        const count = await getEventListenerCount(eventId);
        if (!cancelled) setListenerCount(count);
      } catch (err) {
        console.warn("[live-chat-listeners]", {
          eventId,
          error: err instanceof Error ? err.message : String(err),
        });
        if (!cancelled) setListenerCount(null);
      }
    }

    loadListenerCount();
    const id = window.setInterval(loadListenerCount, 10000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [event?.id, state]);

  useEffect(() => {
    const currentEventId = event?.id ?? null;
    const priorEventId = previousEventId.current;

    if (priorEventId && priorEventId !== currentEventId) {
      removeEventChatIdentity(priorEventId);
    }

    if (currentEventId && state === "finished") {
      removeEventChatIdentity(currentEventId);
    }

    previousEventId.current = currentEventId;
  }, [event?.id, state]);

  useEffect(() => {
    audioUrlRef.current = audioUrl;
    setAudioPipelineDiagnostics(previous => ({
      ...previous,
      finalAudioUrlPresent: Boolean(audioUrl),
    }));
    logAudioUrlPipeline("audioUrl state changed", {
      eventId: event?.id ?? null,
      eventStatus: event?.status ?? null,
      state,
      audioPath: event?.audio_path ?? null,
      finalAudioUrlPresent: Boolean(audioUrl),
      finalAudioUrlPath: sanitizeUrlForLog(audioUrl),
    });
  }, [audioUrl, event?.audio_path, event?.id, event?.status, state]);

  useEffect(() => {
    let cancelled = false;
    const eventId = event?.id ?? null;
    const eventStatus = event?.status ?? null;
    const rawAudioPath = event?.audio_path ?? "";
    const trimmedAudioPath = rawAudioPath.trim();
    let normalizedAudioPath: string | null = null;
    let normalizationError = "";
    try {
      normalizedAudioPath = trimmedAudioPath ? getAudioObjectPath(trimmedAudioPath) : null;
    } catch (err) {
      normalizationError = err instanceof Error ? err.message : String(err);
    }
    const audioPath = normalizedAudioPath ?? trimmedAudioPath;
    const sourceIdentity = getAudioSourceIdentity(eventId, audioPath || null);
    const sourceKey = getAudioSourceKey(eventId, audioPath || null);
    const sameEventAsCurrentSource = eventId && audioSourceRef.current.eventId === eventId;
    const sameSourceAsCurrentUrl = sameEventAsCurrentSource && audioSourceRef.current.audioPath === audioPath;

    const updatePipeline = (partial: Partial<AudioUrlPipelineDiagnostics>) => {
      setAudioPipelineDiagnostics(previous => ({
        ...previous,
        eventId,
        eventStatus,
        state,
        audioPath: audioPath || null,
        audioPathPresent: Boolean(audioPath),
        sourceIdentity,
        normalizedAudioPath,
        projectHost: getSupabaseProjectHost(),
        finalAudioUrlPresent: Boolean(audioUrlRef.current),
        ...partial,
      }));
    };

    logAudioUrlPipeline("effect runs", {
      eventId,
      eventStatus,
      state,
      audioPath: audioPath || null,
      hasAudioPath: Boolean(audioPath),
      sourceKey,
      activeSourceKey: activeAudioSourceKeyRef.current,
      currentAudioUrlPresent: Boolean(audioUrlRef.current),
      currentSourceIdentity: getAudioSourceIdentity(audioSourceRef.current.eventId, audioSourceRef.current.audioPath),
    });
    updatePipeline({ signingEffect: "entered", lastSafeErrorMessage: "" });

    if (state !== "live") {
      audioSigningRequestId.current += 1;
      logAudioUrlPipeline("effect exits before signing because state is not live", {
        eventId,
        eventStatus,
        state,
        audioPath: audioPath || null,
        clearedAudioUrl: Boolean(audioUrlRef.current),
      });
      if (audioUrlRef.current) setAudioUrl("");
      audioSourceRef.current = { eventId: null, audioPath: null };
      activeAudioSourceKeyRef.current = "";
      setAudioSourceStatus("idle");
      updatePipeline({ signingEffect: "skipped", signingRequest: "idle" });
      return () => {
        cancelled = true;
      };
    }

    if (!eventId) {
      audioSigningRequestId.current += 1;
      if (audioUrlRef.current) setAudioUrl("");
      audioSourceRef.current = { eventId: null, audioPath: null };
      activeAudioSourceKeyRef.current = "";
      setAudioSourceStatus("error");
      updatePipeline({
        signingEffect: "skipped",
        signingRequest: "rejected",
        lastSafeErrorMessage: "Live event is missing an event ID.",
      });
      return () => {
        cancelled = true;
      };
    }

    if (!audioPath) {
      audioSigningRequestId.current += 1;
      const preservingExistingUrl = sameEventAsCurrentSource && Boolean(audioUrlRef.current);
      logAudioUrlPipeline("effect exits before signing because audio_path is missing", {
        eventId,
        eventStatus,
        state,
        audioPath: null,
        preservingExistingUrl,
      });
      if (!preservingExistingUrl) {
        console.error("Live audio source unavailable", {
          eventId,
          hasAudioPath: false,
        });
        setAudioSourceStatus("error");
      }
      updatePipeline({
        signingEffect: "skipped",
        signingRequest: preservingExistingUrl ? "resolved" : "rejected",
        lastSafeErrorMessage: preservingExistingUrl ? "" : "Live event is missing audio_path.",
      });
      return () => {
        cancelled = true;
      };
    }

    if (normalizationError || !normalizedAudioPath) {
      audioSigningRequestId.current += 1;
      setAudioSourceStatus("error");
      updatePipeline({
        signingRequest: "rejected",
        lastSafeErrorMessage: normalizationError || "Live event audio_path could not be normalized.",
      });
      console.error("Live audio source path is invalid", {
        eventId,
        hasAudioPath: true,
        errorMessage: normalizationError || "Live event audio_path could not be normalized.",
      });
      return () => {
        cancelled = true;
      };
    }

    if (sameSourceAsCurrentUrl && audioUrlRef.current) {
      logAudioUrlPipeline("reusing existing audioUrl for same event/path", {
        eventId,
        eventStatus,
        state,
        audioPath,
        audioUrlPath: sanitizeUrlForLog(audioUrlRef.current),
      });
      setAudioSourceStatus("ready");
      updatePipeline({ signingRequest: "resolved" });
      return () => {
        cancelled = true;
      };
    }

    const cached = signedAudioCache.current;
    if (cached?.eventId === eventId && cached.audioPath === audioPath && cached.url) {
      logAudioUrlPipeline("reusing cached signed audioUrl for same event/path", {
        eventId,
        eventStatus,
        state,
        audioPath,
        audioUrlPath: sanitizeUrlForLog(cached.url),
      });
      audioSourceRef.current = { eventId, audioPath };
      activeAudioSourceKeyRef.current = sourceKey;
      if (audioUrlRef.current !== cached.url) {
        logAudioUrlPipeline("setAudioUrl executes from cache", {
          eventId,
          eventStatus,
          state,
          audioPath,
          nextAudioUrlPresent: true,
          nextAudioUrlPath: sanitizeUrlForLog(cached.url),
        });
        setAudioUrl(cached.url);
      }
      setAudioSourceStatus("ready");
      updatePipeline({ signingRequest: "resolved" });
      return () => {
        cancelled = true;
      };
    }

    const requestId = audioSigningRequestId.current + 1;
    audioSigningRequestId.current = requestId;
    activeAudioSourceKeyRef.current = sourceKey;
    const requestStartedAt = Date.now();
    setAudioSourceStatus("loading");
    updatePipeline({
      signingRequest: "loading",
      requestId,
      requestStartedAt: new Date(requestStartedAt).toISOString(),
      requestElapsedMs: 0,
      retryCount: 0,
      resultIgnored: false,
      resultIgnoredReason: "",
      directRestState: nativeAudioTest ? "loading" : "idle",
      directRestElapsedMs: null,
      directRestAudioUrlPresent: false,
      directRestError: "",
    });

    getSafeSupabaseSessionState().then(sessionState => {
      if (cancelled || requestId !== audioSigningRequestId.current || sourceKey !== activeAudioSourceKeyRef.current) return;
      updatePipeline({
        sessionState: sessionState.session,
        online: sessionState.online,
        projectHost: sessionState.projectHost,
        lastSafeErrorMessage: sessionState.errorMessage || "",
      });
      logAudioUrlPipeline("safe session state before signing", {
        eventId,
        eventStatus,
        state,
        sourceKey,
        requestId,
        session: sessionState.session,
        getSessionResolved: sessionState.getSessionResolved,
        clientInitialized: sessionState.clientInitialized,
        online: sessionState.online,
        visibilityState: sessionState.visibilityState,
        projectHost: sessionState.projectHost,
        sessionError: sessionState.errorMessage,
      });
    });

    if (nativeAudioTest) {
      getSignedAudioUrlViaRestDiagnostic(audioPath)
        .then(result => {
          if (cancelled || requestId !== audioSigningRequestId.current || sourceKey !== activeAudioSourceKeyRef.current) return;
          updatePipeline({
            directRestState: result.state,
            directRestElapsedMs: result.elapsedMs,
            directRestAudioUrlPresent: result.signedUrlPresent,
            directRestError: result.errorMessage,
          });
        })
        .catch(err => {
          if (cancelled || requestId !== audioSigningRequestId.current || sourceKey !== activeAudioSourceKeyRef.current) return;
          const errorInfo = getErrorLogInfo(err);
          updatePipeline({
            directRestState: "rejected",
            directRestElapsedMs: Date.now() - requestStartedAt,
            directRestAudioUrlPresent: false,
            directRestError: errorInfo.errorMessage,
          });
        });
    }

    const signAudioUrl = (attempt: 1 | 2) => {
      const attemptStartedAt = Date.now();
      updatePipeline({
        signingRequest: "loading",
        retryCount: attempt - 1,
        requestElapsedMs: Date.now() - requestStartedAt,
      });
      logAudioUrlPipeline("getSignedAudioUrl called", {
        eventId,
        eventStatus,
        state,
        audioPath,
        normalizedAudioPath,
        sourceKey,
        requestId,
        attempt,
      });
      console.info("Requesting live audio signed URL", {
        eventId,
        hasAudioPath: true,
        requestId,
        attempt,
      });

      let signingPromise = inFlightSigningRequests.current.get(sourceKey);
      if (!signingPromise) {
        signingPromise = getSignedAudioUrl(audioPath, 3600, {
          requestId,
          attempt,
          eventId,
          sourceKey,
          timeoutMs: 10000,
          startedAt: attemptStartedAt,
        });
        inFlightSigningRequests.current.set(sourceKey, signingPromise);
        const clearInFlight = () => {
          if (inFlightSigningRequests.current.get(sourceKey) === signingPromise) {
            inFlightSigningRequests.current.delete(sourceKey);
          }
        };
        signingPromise.then(clearInFlight, clearInFlight);
      } else {
        logAudioUrlPipeline("reusing in-flight signed URL request", {
          eventId,
          eventStatus,
          state,
          audioPath,
          sourceKey,
          requestId,
          attempt,
        });
      }

      signingPromise
        .then(url => {
          const isLatestRequest = requestId === audioSigningRequestId.current;
          const isCurrentSource = sourceKey === activeAudioSourceKeyRef.current;
          const ignored = cancelled || !isLatestRequest || !isCurrentSource;
          const ignoredReason = cancelled ? "effect cleanup ran" : !isLatestRequest ? "newer request exists" : !isCurrentSource ? "source key changed" : "";
          logAudioUrlPipeline("getSignedAudioUrl resolved", {
            eventId,
            eventStatus,
            state,
            audioPath,
            normalizedAudioPath,
            sourceKey,
            activeSourceKey: activeAudioSourceKeyRef.current,
            requestId,
            attempt,
            elapsedMs: Date.now() - attemptStartedAt,
            resolvedAudioUrlPresent: Boolean(url),
            resolvedAudioUrlPath: sanitizeUrlForLog(url),
            effectStillActive: !cancelled,
            isLatestRequest,
            isCurrentSource,
          });
          if (ignored) {
            logAudioUrlPipeline("setAudioUrl skipped because signing result is stale", {
              eventId,
              eventStatus,
              state,
              audioPath,
              sourceKey,
              activeSourceKey: activeAudioSourceKeyRef.current,
              requestId,
              attempt,
              resolvedAudioUrlPresent: Boolean(url),
              ignoredReason,
            });
            updatePipeline({
              resultIgnored: true,
              resultIgnoredReason: ignoredReason,
              requestElapsedMs: Date.now() - requestStartedAt,
            });
            return;
          }
          if (!url) {
            if (attempt === 1) {
              signAudioUrl(2);
              return;
            }
            setAudioSourceStatus("error");
            updatePipeline({
              signingRequest: "rejected",
              requestElapsedMs: Date.now() - requestStartedAt,
              lastSafeErrorMessage: "Signed audio URL request returned an empty URL.",
            });
            console.error("Live audio signed URL failed", {
              eventId,
              hasAudioPath: true,
              errorName: "EmptySignedUrl",
              errorMessage: "Signed audio URL request returned an empty URL.",
            });
            return;
          }
          logAudioUrlPipeline("setAudioUrl executes", {
            eventId,
            eventStatus,
            state,
            audioPath,
            requestId,
            attempt,
            nextAudioUrlPresent: true,
            nextAudioUrlPath: sanitizeUrlForLog(url),
          });
          signedAudioCache.current = { eventId, audioPath, url };
          audioSourceRef.current = { eventId, audioPath };
          activeAudioSourceKeyRef.current = sourceKey;
          setAudioUrl(url);
          setAudioSourceStatus("ready");
          updatePipeline({
            signingRequest: "resolved",
            finalAudioUrlPresent: true,
            requestElapsedMs: Date.now() - requestStartedAt,
            lastSafeErrorMessage: "",
          });
          console.info("Live audio signed URL ready", {
            eventId,
            hasAudioPath: true,
            receivedAudioUrl: Boolean(url),
            audioUrlPath: sanitizeUrlForLog(url),
          });
        })
        .catch(err => {
          const isLatestRequest = requestId === audioSigningRequestId.current;
          const isCurrentSource = sourceKey === activeAudioSourceKeyRef.current;
          const ignored = cancelled || !isLatestRequest || !isCurrentSource;
          const ignoredReason = cancelled ? "effect cleanup ran" : !isLatestRequest ? "newer request exists" : !isCurrentSource ? "source key changed" : "";
          const errorInfo = getErrorLogInfo(err);
          const timedOut = err instanceof SignedAudioUrlTimeoutError;
          logAudioUrlPipeline("getSignedAudioUrl rejects", {
            eventId,
            eventStatus,
            state,
            audioPath,
            normalizedAudioPath,
            sourceKey,
            activeSourceKey: activeAudioSourceKeyRef.current,
            requestId,
            attempt,
            elapsedMs: Date.now() - attemptStartedAt,
            timedOut,
            ...errorInfo,
            effectStillActive: !cancelled,
            isLatestRequest,
            isCurrentSource,
          });
          if (ignored) {
            updatePipeline({
              resultIgnored: true,
              resultIgnoredReason: ignoredReason,
              requestElapsedMs: Date.now() - requestStartedAt,
            });
            return;
          }
          if (attempt === 1) {
            updatePipeline({
              signingRequest: timedOut ? "timed-out" : "rejected",
              retryCount: 1,
              requestElapsedMs: Date.now() - requestStartedAt,
              lastSafeErrorMessage: errorInfo.errorMessage,
            });
            signAudioUrl(2);
            return;
          }
          if (audioUrlRef.current && sameSourceAsCurrentUrl) {
            logAudioUrlPipeline("getSignedAudioUrl rejection ignored because current source already has audioUrl", {
              eventId,
              eventStatus,
              state,
              audioPath,
              sourceKey,
              requestId,
              attempt,
              ...errorInfo,
            });
            return;
          }
          console.error("Live audio signed URL failed", {
            eventId,
            hasAudioPath: true,
            ...errorInfo,
          });
          setAudioSourceStatus("error");
          updatePipeline({
            signingRequest: timedOut ? "timed-out" : "rejected",
            requestElapsedMs: Date.now() - requestStartedAt,
            lastSafeErrorMessage: errorInfo.errorMessage,
          });
        });
    };

    signAudioUrl(1);

    return () => {
      cancelled = true;
      logAudioUrlPipeline("effect cleanup ran", {
        eventId,
        eventStatus,
        state,
        audioPath,
        sourceKey,
        requestId,
        activeRequestId: audioSigningRequestId.current,
        activeSourceKey: activeAudioSourceKeyRef.current,
      });
    };
  }, [event?.audio_path, event?.id, event?.status, nativeAudioTest, state]);

  const images = useMemo(() => ({
    artwork: getPublicImageUrl("artwork", event?.artwork_path),
    artist: getPublicImageUrl("artist-images", event?.artist_image_path),
    merch: getPublicImageUrl("merch-images", event?.merch_image_path),
  }), [event]);

  if (loading) {
    return <LoadingShell>loading...</LoadingShell>;
  }

  if (error) {
    return <LoadingShell>{error}</LoadingShell>;
  }

  if (!event) {
    return <LoadingShell>no active event yet.</LoadingShell>;
  }

  const title = event.title.toLowerCase();
  const countdownTarget = getCountdownTarget(event, state);
  const currentRawAudioPath = event.audio_path ?? "";
  const currentNormalizedAudioPath = getSafeAudioObjectPath(currentRawAudioPath);
  const currentAudioPath = (currentNormalizedAudioPath ?? currentRawAudioPath.trim()) || null;
  const currentSourceIdentity = getAudioSourceIdentity(event.id, currentAudioPath);
  const pipelineMatchesCurrentSource = audioPipelineDiagnostics.sourceIdentity === currentSourceIdentity;
  const sourceScopedAudioPipelineDiagnostics: AudioUrlPipelineDiagnostics = pipelineMatchesCurrentSource
    ? audioPipelineDiagnostics
    : {
      ...audioPipelineDiagnostics,
      signingEffect: state === "live" ? "entered" : "idle",
      signingRequest: state === "live" && currentAudioPath ? "loading" : "idle",
      requestId: audioSigningRequestId.current || null,
      requestStartedAt: "",
      requestElapsedMs: null,
      retryCount: 0,
      resultIgnored: false,
      resultIgnoredReason: "",
      normalizedAudioPath: currentNormalizedAudioPath,
      directRestState: nativeAudioTest && state === "live" && currentAudioPath ? "loading" : "idle",
      directRestElapsedMs: null,
      directRestAudioUrlPresent: false,
      directRestError: "",
      lastSafeErrorMessage: "",
    };
  const currentAudioPipelineDiagnostics: AudioUrlPipelineDiagnostics = {
    ...sourceScopedAudioPipelineDiagnostics,
    eventId: event.id,
    eventStatus: event.status,
    state,
    audioPath: currentAudioPath,
    audioPathPresent: Boolean(currentAudioPath),
    normalizedAudioPath: currentNormalizedAudioPath,
    finalAudioUrlPresent: Boolean(audioUrl),
    sourceIdentity: currentSourceIdentity,
  };

  return (
    <Shell>
      {state === "upcoming" && <DVDBounce imageUrl={images.artist} />}
      {state === "upcoming" && <UpcomingPage title={title} artworkUrl={images.artwork} startsAt={countdownTarget} />}
      {state === "live" && (
        <LiveEventView
          key={event.id}
          title={title}
          artistName={event.artist_name || "artist"}
          artistUrl={images.artist}
          audioUrl={audioUrl}
          audioSourceStatus={audioSourceStatus}
          audioPipelineDiagnostics={currentAudioPipelineDiagnostics}
          startsAt={event.starts_at}
          liveTarget={countdownTarget}
          eventId={event.id}
          messages={chat.messages}
          listenerCount={listenerCount}
          joinedIdentity={joinedIdentity}
          onJoin={setJoinedIdentity}
          onMessageSubmitted={chat.refetch}
          live={authoritativeState === "live"}
          starting={waitingForLiveStatus}
        />
      )}
      {state === "finished" && <FinishedPage event={event} merchImage={images.merch} />}
    </Shell>
  );
}

function LoadingShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="public-event-shell" style={{ position: "relative", minHeight: "100vh", background: BG, color: GREEN, overflow: "hidden" }}>
      <GlobalStyles />
      <CRTOverlay />
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", fontFamily: VT, color: "rgba(0,255,65,0.65)", fontSize: 24 }}>
        {children}
      </div>
    </main>
  );
}

function UpcomingPage({ title, artworkUrl, startsAt }: { title: string; artworkUrl: string; startsAt: string | null }) {
  return (
    <div style={{ position: "relative", minHeight: "100vh", background: BG, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ position: "relative", zIndex: 10, display: "flex", flexDirection: "column", alignItems: "center", gap: "clamp(2rem, 5vh, 4rem)", padding: "2rem" }}>
        <Countdown target={startsAt} />
        <p style={{ fontFamily: VT, fontSize: "clamp(1rem, 3vw, 1.6rem)", color: "rgba(255,255,255,0.55)", textAlign: "center", letterSpacing: "0.04em" }}>
          {title}
        </p>
        <Artwork size={360} imageUrl={artworkUrl} />
      </div>
    </div>
  );
}

function ArtistPortrait({ imageUrl }: { imageUrl: string }) {
  const src = imageUrl.trim() || PLACEHOLDER_SRC;

  return (
    <div style={{
      width: "clamp(82px, 18vw, 126px)",
      aspectRatio: "4 / 5",
      position: "relative",
      overflow: "hidden",
      background: "transparent",
      filter: "contrast(1.05) saturate(0.9)",
    }}>
      <img src={src} alt="Artist" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", imageRendering: "pixelated", opacity: 0.82, pointerEvents: "none" }} />
    </div>
  );
}

function BouncingArtistPortrait({ imageUrl }: { imageUrl: string }) {
  const portraitRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const posRef = useRef({ x: 0, y: 0 });
  const velocity = useRef({ x: 1.25, y: 0.9 });

  useEffect(() => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    const resetPosition = () => {
      const portrait = portraitRef.current?.getBoundingClientRect();
      if (!portrait) return;
      const maxX = Math.max(0, window.innerWidth - portrait.width);
      const maxY = Math.max(0, window.innerHeight - portrait.height);
      const next = {
        x: Math.max(0, Math.min(maxX, posRef.current.x || window.innerWidth * 0.5)),
        y: Math.max(0, Math.min(maxY, posRef.current.y || window.innerHeight * 0.45)),
      };
      posRef.current = next;
      setPos(next);
    };

    resetPosition();
    window.addEventListener("resize", resetPosition);

    if (reducedMotion.matches) {
      return () => window.removeEventListener("resize", resetPosition);
    }

    let raf = 0;
    const tick = () => {
      const portrait = portraitRef.current?.getBoundingClientRect();
      if (portrait) {
        let nextX = posRef.current.x + velocity.current.x;
        let nextY = posRef.current.y + velocity.current.y;
        const maxX = Math.max(0, window.innerWidth - portrait.width);
        const maxY = Math.max(0, window.innerHeight - portrait.height);

        if (nextX <= 0 || nextX >= maxX) {
          velocity.current.x *= -1;
          nextX = Math.max(0, Math.min(maxX, nextX));
        }

        if (nextY <= 0 || nextY >= maxY) {
          velocity.current.y *= -1;
          nextY = Math.max(0, Math.min(maxY, nextY));
        }

        const next = { x: nextX, y: nextY };
        posRef.current = next;
        setPos(next);
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);

    return () => {
      window.removeEventListener("resize", resetPosition);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div
      aria-hidden="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1,
        pointerEvents: "none",
        overflow: "hidden",
      }}
    >
      <div ref={portraitRef} style={{ position: "absolute", left: 0, top: 0, transform: `translate3d(${pos.x}px, ${pos.y}px, 0)`, willChange: "transform" }}>
        <ArtistPortrait imageUrl={imageUrl} />
      </div>
    </div>
  );
}

function LiveEventView({ title, artistName, artistUrl, audioUrl, audioSourceStatus, audioPipelineDiagnostics, startsAt, liveTarget, eventId, messages, listenerCount, joinedIdentity, onJoin, onMessageSubmitted, live, starting }: { title: string; artistName: string; artistUrl: string; audioUrl: string; audioSourceStatus: AudioSourceStatus; audioPipelineDiagnostics: AudioUrlPipelineDiagnostics; startsAt: string | null; liveTarget: string | null; eventId: string; messages: ChatMessage[]; listenerCount: number | null; joinedIdentity: JoinedChatIdentity | null; onJoin: (identity: JoinedChatIdentity) => void; onMessageSubmitted: () => void | Promise<void>; live: boolean; starting: boolean }) {
  useEffect(() => {
    console.info("[live-chat-join-state]", {
      eventId,
      joined: Boolean(joinedIdentity),
      sourceIdentity: audioPipelineDiagnostics.sourceIdentity,
      audioPathPresent: audioPipelineDiagnostics.audioPathPresent,
      finalAudioUrlPresent: audioPipelineDiagnostics.finalAudioUrlPresent,
      signingRequest: audioPipelineDiagnostics.signingRequest,
    });
  }, [audioPipelineDiagnostics.audioPathPresent, audioPipelineDiagnostics.finalAudioUrlPresent, audioPipelineDiagnostics.signingRequest, audioPipelineDiagnostics.sourceIdentity, eventId, joinedIdentity]);

  const joined = Boolean(joinedIdentity);

  return (
    <div className="live-event-view">
      <div className="live-event-content">
        <LiveAudioHeader title={title} audioUrl={audioUrl} audioSourceStatus={audioSourceStatus} audioPipelineDiagnostics={audioPipelineDiagnostics} startsAt={startsAt} liveTarget={liveTarget} />
        <div style={{ height: 1, background: "rgba(0,255,65,0.08)", margin: "1.25rem 0 0" }} />
        <div className={`live-chat-layout ${joined ? "live-chat-layout--joined" : "live-chat-layout--prejoin"}`}>
          <LiveMessageStream messages={messages} joined={joined} eventId={eventId} artistName={artistName} artistUrl={artistUrl} listenerCount={listenerCount} />
          <BouncingArtistPortrait imageUrl={artistUrl} />
          {starting && (
            <p style={{ position: "absolute", top: "8.25rem", left: 0, right: 0, fontFamily: VT, color: "rgba(0,255,65,0.7)", fontSize: "1.1rem", letterSpacing: "0.06em", textAlign: "center" }}>
              event is starting...
            </p>
          )}
          {joinedIdentity ? (
            <ActiveChatComposer eventId={eventId} identity={joinedIdentity} live={live} starting={starting} onMessageSubmitted={onMessageSubmitted} />
          ) : (
            <JoinChatPanel eventId={eventId} onJoin={onJoin} onListenerCount={setListenerCount} />
          )}
        </div>
      </div>
    </div>
  );
}

function LiveAudioHeader({ title, audioUrl, audioSourceStatus, audioPipelineDiagnostics, startsAt, liveTarget }: { title: string; audioUrl: string; audioSourceStatus: AudioSourceStatus; audioPipelineDiagnostics: AudioUrlPipelineDiagnostics; startsAt: string | null; liveTarget: string | null }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "clamp(0.25rem, 1.5vw, 1rem)", width: "100%", minWidth: 0, flexWrap: "nowrap", overflow: "hidden" }}>
      <p style={{ fontFamily: VT, fontSize: "clamp(0.95rem, 3.4vw, 1.85rem)", color: "rgba(255,255,255,0.38)", letterSpacing: "0.04em", minWidth: 0, flex: "0 1 clamp(4.25rem, 24vw, 18ch)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {title}
      </p>
      <div style={{ minWidth: "4.5rem", flex: "1 1 5rem" }}>
        <AudioPlayer audioUrl={audioUrl} sourceStatus={audioSourceStatus} pipelineDiagnostics={audioPipelineDiagnostics} startsAt={startsAt} />
      </div>
      <CompactLiveCountdown target={liveTarget} />
    </div>
  );
}

function LiveMessageStream({ messages, joined, eventId, artistName, artistUrl, listenerCount }: { messages: ChatMessage[]; joined: boolean; eventId: string; artistName: string; artistUrl: string; listenerCount: number | null }) {
  const pinnedMessage = messages.find(message => message.is_pinned);
  const feedMessages = pinnedMessage ? messages.filter(message => message.id !== pinnedMessage.id) : messages;
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const bottomAnchorRef = useRef<HTMLDivElement | null>(null);
  const wasNearBottomRef = useRef(true);
  const didInitialScrollRef = useRef(false);
  const latestMessageId = messages[messages.length - 1]?.id ?? "";

  useEffect(() => {
    didInitialScrollRef.current = false;
    wasNearBottomRef.current = true;
  }, [eventId]);

  useEffect(() => {
    if (!joined) return;

    const viewport = viewportRef.current;
    const bottomAnchor = bottomAnchorRef.current;
    if (!viewport || !bottomAnchor) return;

    const shouldScroll = !didInitialScrollRef.current || wasNearBottomRef.current;
    const behavior: ScrollBehavior = didInitialScrollRef.current ? "smooth" : "auto";
    if (!shouldScroll) return;

    const frame = window.requestAnimationFrame(() => {
      if (behavior === "auto") {
        viewport.scrollTop = viewport.scrollHeight;
      } else {
        bottomAnchor.scrollIntoView({ block: "end", behavior });
      }
      didInitialScrollRef.current = true;
    });

    return () => window.cancelAnimationFrame(frame);
  }, [joined, latestMessageId, messages.length]);

  function updateNearBottom() {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    wasNearBottomRef.current = distanceFromBottom < 80;
  }

  if (!joined) {
    return (
      <section className="live-chat-stream--prejoin" style={{ opacity: messages.length > 0 ? 1 : 0.28 }}>
        {pinnedMessage && (
          <div style={{ width: "min(100%, 620px)" }}>
            <ChatMessageBubble message={pinnedMessage} joined={joined} artistName={artistName} artistUrl={artistUrl} pinnedArea />
          </div>
        )}
        {feedMessages.map(message => (
          <ChatMessageBubble key={message.id} message={message} joined={joined} artistName={artistName} artistUrl={artistUrl} />
        ))}
      </section>
    );
  }

  return (
    <section className="live-chat-stream--joined" style={{ opacity: messages.length > 0 ? 1 : 0.9 }}>
      <div className="live-chat__header">
        <p style={{ fontFamily: VT, color: GREEN, fontSize: "1.45rem", letterSpacing: "0.22em" }}>live chat</p>
        <p style={{ fontFamily: VT, color: "rgba(0,255,65,0.4)", fontSize: "1.05rem", letterSpacing: "0.1em", whiteSpace: "nowrap" }}>listeners: {listenerCount ?? "—"}</p>
      </div>
      <div ref={viewportRef} className="live-chat__messages" onScroll={updateNearBottom}>
        {pinnedMessage && (
          <div style={{ width: "min(100%, 620px)" }}>
            <ChatMessageBubble message={pinnedMessage} joined={joined} artistName={artistName} artistUrl={artistUrl} pinnedArea />
          </div>
        )}
        {feedMessages.map(message => (
          <ChatMessageBubble key={message.id} message={message} joined={joined} artistName={artistName} artistUrl={artistUrl} />
        ))}
        <div ref={bottomAnchorRef} aria-hidden="true" style={{ height: 1, flexShrink: 0 }} />
      </div>
    </section>
  );
}

function ChatMessageBubble({ message, joined, artistName, artistUrl, pinnedArea = false }: { message: ChatMessage; joined: boolean; artistName: string; artistUrl: string; pinnedArea?: boolean }) {
  const displayName = message.is_admin ? artistName : message.display_name;
  const labels = getPublicMessageLabels(message);

  return (
    <div style={{
      maxWidth: pinnedArea ? "100%" : joined ? "min(88%, 620px)" : "88%",
      borderLeft: `2px solid ${message.is_highlighted ? GREEN : "rgba(0,255,65,0.3)"}`,
      padding: joined ? "0.45rem 0 0.45rem 0.65rem" : "0.25rem 0 0.25rem 0.65rem",
      background: message.is_highlighted ? "rgba(0,255,65,0.07)" : "transparent",
    }}>
      <div style={{ minWidth: 0 }}>
        <p style={{ fontFamily: VT, color: GREEN, fontSize: "0.95rem", letterSpacing: "0.05em", overflowWrap: "anywhere" }}>
          {displayName}{labels.length > 0 ? ` ${labels.join(" ")}` : ""}
        </p>
        <p style={{ fontFamily: VT, color: "#fff", fontSize: "1.15rem", lineHeight: 1.15, overflowWrap: "anywhere" }}>{message.body}</p>
        {message.is_liked && <ArtistLikeIndicator artistUrl={artistUrl} />}
      </div>
    </div>
  );
}

function getPublicMessageLabels(message: ChatMessage) {
  return message.is_pinned ? ["[pinned]"] : [];
}

function ArtistLikeIndicator({ artistUrl }: { artistUrl: string }) {
  if (!artistUrl) return null;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.35rem", marginTop: "0.25rem" }}>
      <img
        src={artistUrl}
        alt=""
        aria-hidden="true"
        style={{
          width: 18,
          height: 18,
          borderRadius: "50%",
          objectFit: "cover",
          display: "block",
          flexShrink: 0,
        }}
      />
      <span style={{ fontFamily: VT, color: "rgba(255,255,255,0.45)", fontSize: "0.95rem", letterSpacing: "0.04em" }}>likes</span>
    </div>
  );
}

function JoinChatPanel({ eventId, onJoin, onListenerCount }: { eventId: string; onJoin: (identity: JoinedChatIdentity) => void; onListenerCount: (count: number) => void }) {
  const [error, setError] = useState("");
  const [joining, setJoining] = useState(false);

  async function join(event: React.FormEvent) {
    event.preventDefault();
    setJoining(true);
    setError("");
    try {
      const participant = await joinEventChatIdentity({ event_id: eventId });
      const identity = {
        participantId: participant.id,
        sessionId: participant.session_id,
        displayName: participant.display_name,
        joinedAt: participant.joined_at,
      };
      storeChatIdentity(eventId, identity);
      getEventListenerCount(eventId).then(onListenerCount).catch(() => undefined);
      console.info("[live-chat-join-state]", {
        eventId,
        joined: true,
        action: "join-submitted",
      });
      onJoin(identity);
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not join chat.");
    } finally {
      setJoining(false);
    }
  }

  return (
    <form onSubmit={join} style={{ position: "absolute", left: "50%", bottom: "clamp(8.5rem, 18vh, 13rem)", transform: "translateX(-50%)", width: "min(350px, 82vw)", display: "grid", gap: "1.25rem", zIndex: 3 }}>
      <div style={{ textAlign: "center", display: "grid", gap: "0.9rem" }}>
        <p style={{ fontFamily: PSP, fontSize: "clamp(1rem, 4vw, 1.55rem)", color: "#FFFFFF", letterSpacing: "0.06em" }}>join chat</p>
      </div>
      <button disabled={joining} style={enterButtonStyle}>
        [ join ]
      </button>
      {error && <p style={{ fontFamily: VT, color: "#ff5c5c", fontSize: "0.95rem", textAlign: "center" }}>{error}</p>}
    </form>
  );
}

const VISITOR_MESSAGE_LIMIT = 400;
const RATE_LIMIT_MESSAGE = "Wait a little till sending again.";

function getUnicodeLength(value: string) {
  return Array.from(value).length;
}

function ActiveChatComposer({ eventId, identity, live, starting, onMessageSubmitted }: { eventId: string; identity: JoinedChatIdentity; live: boolean; starting: boolean; onMessageSubmitted: () => void | Promise<void> }) {
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [cooldownRemaining, setCooldownRemaining] = useState(0);

  useEffect(() => {
    setBody("");
    setError("");
    setSending(false);
    setCooldownUntil(0);
    setCooldownRemaining(0);
  }, [eventId]);

  useEffect(() => {
    if (cooldownUntil <= Date.now()) {
      setCooldownRemaining(0);
      return;
    }

    const update = () => {
      const remaining = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
      setCooldownRemaining(remaining);
      if (remaining === 0) {
        setCooldownUntil(0);
        setError(current => current === RATE_LIMIT_MESSAGE ? "" : current);
      }
    };

    update();
    const id = window.setInterval(update, 1000);
    return () => window.clearInterval(id);
  }, [cooldownUntil]);

  async function submitMessage(event: React.FormEvent) {
    event.preventDefault();
    const trimmedBody = body.trim();
    const trimmedLength = getUnicodeLength(trimmedBody);

    if (!live || sending || cooldownRemaining > 0) return;
    if (!trimmedBody) {
      setError("Message cannot be empty.");
      return;
    }
    if (trimmedLength > VISITOR_MESSAGE_LIMIT) {
      setError("Message must be 400 characters or fewer.");
      return;
    }

    setSending(true);
    setError("");
    try {
      const clientToken = crypto.randomUUID();
      await sendVisitorMessage({
        event_id: eventId,
        participant_id: identity.participantId,
        session_id: identity.sessionId,
        body,
        client_token: clientToken,
      });
      setBody("");
      await onMessageSubmitted();
    } catch (err) {
      console.error("Visitor chat submission failed", err);
      if (err instanceof ChatSubmissionError && err.code === "MESSAGE_RATE_LIMITED" && err.retryAfterSeconds) {
        setCooldownUntil(Date.now() + err.retryAfterSeconds * 1000);
        setCooldownRemaining(err.retryAfterSeconds);
        setError(RATE_LIMIT_MESSAGE);
      } else if (err instanceof ChatSubmissionError) {
        setError(err.message);
      } else {
        setError("message could not be submitted.");
      }
    } finally {
      setSending(false);
    }
  }

  const trimmedLength = getUnicodeLength(body.trim());
  const isTooLong = trimmedLength > VISITOR_MESSAGE_LIMIT;
  const canSend = live && !sending && cooldownRemaining === 0 && Boolean(body.trim()) && !isTooLong;
  const feedbackMessage = error;
  const feedbackTone = error ? "error" : "status";

  return (
    <div className="chat-composer">
      {live ? (
        <form className="chat-composer__form" onSubmit={submitMessage}>
          <div className="chat-composer__controls">
            <span style={{ fontFamily: VT, color: GREEN, fontSize: "1.05rem", letterSpacing: "0.06em", maxWidth: "min(26vw, 140px)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexShrink: 0 }}>{identity.displayName}</span>
            <span style={{ fontFamily: VT, color: GREEN, fontSize: "1.35rem" }}>›</span>
            <input value={body} onChange={event => setBody(event.target.value)} aria-label="Message" style={{ ...terminalInputStyle, fontSize: "1.05rem" }} />
            <button disabled={!canSend} style={sendButtonStyle(canSend)}>send</button>
          </div>
          <div className="chat-composer__feedback" role={feedbackMessage ? feedbackTone === "error" ? "alert" : "status" : undefined} aria-live={feedbackTone === "error" ? "assertive" : "polite"} style={{ color: feedbackTone === "error" ? "#ff5c5c" : GREEN }}>
            {feedbackMessage}
          </div>
        </form>
      ) : (
        <p style={{ fontFamily: VT, color: "rgba(255,255,255,0.45)", fontSize: "1.05rem" }}>
          {starting ? "event is starting. chat will open in a moment." : "chat is closed."}
        </p>
      )}
    </div>
  );
}

const enterButtonStyle: React.CSSProperties = {
  justifySelf: "center",
  width: "min(180px, 70%)",
  background: "rgba(0,255,65,0.22)",
  color: BG,
  border: "none",
  padding: "0.65rem 1rem",
  fontFamily: VT,
  fontSize: "1.2rem",
  letterSpacing: "0.25em",
};

function sendButtonStyle(active: boolean): React.CSSProperties {
  return {
    width: "auto",
    flexShrink: 0,
    padding: "0.35rem 0.75rem",
    fontFamily: VT,
    fontSize: "1rem",
    letterSpacing: "0.12em",
    border: "none",
    color: active ? BG : "rgba(255,255,255,0.28)",
    background: active ? GREEN : "rgba(255,255,255,0.06)",
    boxShadow: active ? "0 0 14px rgba(0,255,65,0.32)" : "none",
    opacity: active ? 1 : 0.85,
  };
}

const terminalInputStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: "transparent",
  border: "none",
  outline: "none",
  color: "#FFFFFF",
  fontFamily: VT,
  fontSize: "1.25rem",
  letterSpacing: "0.08em",
};

function FinishedPage({ event, merchImage }: { event: MusicEvent; merchImage: string }) {
  const linkStyle: React.CSSProperties = {
    fontFamily: VT,
    fontSize: "clamp(1rem, 3vw, 1.3rem)",
    color: GREEN,
    textDecoration: "none",
    letterSpacing: "0.05em",
    display: "inline-block",
  };
  const headingStyle: React.CSSProperties = {
    fontFamily: VT,
    fontSize: "clamp(1.4rem, 5vw, 2.2rem)",
    color: "#FFFFFF",
    lineHeight: 1.2,
  };
  const sections: React.ReactNode[] = [];

  if (event.support_url) {
    sections.push(
      <div key="support" style={{ width: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: "0.6rem" }}>
        <p style={headingStyle}>support me</p>
        <a href={event.support_url} target="_blank" rel="noopener noreferrer" style={linkStyle}>→ support</a>
      </div>,
    );
  }

  if (event.merch_url && merchImage) {
    sections.push(
      <div key="merch" style={{ width: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: "0.75rem" }}>
        <p style={headingStyle}>buy merch</p>
        <a href={event.merch_url} target="_blank" rel="noopener noreferrer" style={{ display: "block", border: `2px solid ${GREEN}` }}>
          <img src={merchImage} alt="Merchandise" style={{ width: 160, height: 160, objectFit: "cover", display: "block" }} />
        </a>
        <a href={event.merch_url} target="_blank" rel="noopener noreferrer" style={linkStyle}>→ shop now</a>
      </div>,
    );
  }

  if (event.event_url) {
    sections.push(
      <div key="event" style={{ width: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: "0.6rem" }}>
        <p style={headingStyle}>pull up to next show:</p>
        <a href={event.event_url} target="_blank" rel="noopener noreferrer" style={linkStyle}>→ get tickets</a>
      </div>,
    );
  }

  return (
    <div style={{ position: "relative", minHeight: "100vh", background: BG, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ position: "relative", zIndex: 10, textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: "1.75rem", padding: "3rem 1.5rem", maxWidth: 420, width: "100%" }}>
        <p style={{ fontFamily: VT, fontSize: "clamp(0.85rem, 2.5vw, 1.1rem)", color: "rgba(255,255,255,0.35)" }}>thank you for listening.</p>
        {sections.map((section, index) => (
          <div key={index} style={{ width: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: "1.75rem" }}>
            {index > 0 && <p style={{ fontFamily: VT, fontSize: "1rem", color: "rgba(0,255,65,0.28)", letterSpacing: "0.25em" }}>or</p>}
            {section}
          </div>
        ))}
      </div>
    </div>
  );
}
