import { useEffect, useMemo, useRef, useState } from "react";
import { formatCountdown, getCountdownTarget, getEventDisplayState, getRemainingMilliseconds } from "@/lib/eventTiming";
import { useEventChat } from "@/hooks/useEventChat";
import { useCurrentEvent } from "@/hooks/useCurrentEvent";
import { getVisitorMessageStatus, sendVisitorMessage } from "@/services/chatService";
import { getPublicImageUrl, getSignedAudioUrl } from "@/services/storageService";
import type { ChatMessage } from "@/types/chat";
import type { MusicEvent } from "@/types/event";

const GREEN = "#00FF41";
const BG = "#000000";
const VT = "'VT323', monospace";
const PSP = "'Press Start 2P', cursive";

type DisplayState = "upcoming" | "live" | "finished";

const CHAT_NAME_KEY_PREFIX = "music-event-chat-name:";
const CHAT_AVATAR_KEY_PREFIX = "music-event-chat-avatar:";
const LEGACY_CHAT_IDENTITY_KEYS = ["live-chat-name", "chat-name", "username", "joined-chat"];

function pad2(value: number) {
  return String(Math.floor(value)).padStart(2, "0");
}

function splitMs(ms: number) {
  return formatCountdown(ms);
}

function fmtSecs(seconds: number) {
  return `${pad2(Math.floor(seconds / 60))}:${pad2(seconds % 60)}`;
}

function hashString(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededValue(seed: number, offset: number) {
  const value = Math.sin(seed + offset * 999) * 10000;
  return value - Math.floor(value);
}

function createRetroAvatar(eventId: string, name: string) {
  const normalizedName = name.replace(/\s+/g, " ").trim().toLowerCase();
  const seed = hashString(`${eventId}:${normalizedName || "guest"}`);
  const hue = Math.floor(seededValue(seed, 1) * 95) + 95;
  const accentHue = Math.floor(seededValue(seed, 2) * 60) + 180;
  const skin = `hsl(${hue}, 56%, 42%)`;
  const accent = `hsl(${accentHue}, 62%, 54%)`;
  const face = seededValue(seed, 3) > 0.5 ? "round" : "square";
  const visor = seededValue(seed, 4) > 0.55;
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" shape-rendering="crispEdges">
  <rect width="48" height="48" fill="#050505"/>
  <rect x="4" y="6" width="40" height="38" fill="${accent}" opacity="0.18"/>
  <rect x="10" y="8" width="28" height="30" rx="${face === "round" ? 10 : 2}" fill="${skin}"/>
  <rect x="14" y="14" width="6" height="6" fill="#020202"/>
  <rect x="28" y="14" width="6" height="6" fill="#020202"/>
  ${visor ? '<rect x="12" y="12" width="24" height="8" fill="#d7ffe1" opacity="0.45"/>' : ""}
  <rect x="18" y="27" width="12" height="3" fill="#020202"/>
  <rect x="8" y="36" width="32" height="8" fill="${accent}"/>
  <rect x="2" y="2" width="6" height="6" fill="#00FF41" opacity="0.75"/>
  <rect x="40" y="40" width="6" height="6" fill="#00FF41" opacity="0.75"/>
</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
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

function AudioPlayer({ audioUrl }: { audioUrl: string }) {
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const audioRef = useRef<HTMLAudioElement>(null);

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio || !audioUrl) return;
    playing ? audio.pause() : audio.play().catch(() => {});
    setPlaying(!playing);
  };

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTime = () => setProgress(audio.currentTime);
    const onMeta = () => setDuration(audio.duration || 0);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);

    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("loadedmetadata", onMeta);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);

    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("loadedmetadata", onMeta);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
    };
  }, [audioUrl]);

  const seek = (event: React.MouseEvent<HTMLDivElement>) => {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    const rect = event.currentTarget.getBoundingClientRect();
    audio.currentTime = ((event.clientX - rect.left) / rect.width) * duration;
  };

  const pct = duration > 0 ? (progress / duration) * 100 : 0;

  return (
    <div style={{ width: "100%" }}>
      {audioUrl && <audio ref={audioRef} src={audioUrl} loop />}
      <div style={{ display: "flex", alignItems: "center", gap: "1.25rem", marginBottom: "0.6rem" }}>
        <button onClick={toggle} disabled={!audioUrl} style={{
          fontFamily: VT,
          fontSize: "1.4rem",
          color: audioUrl ? "#FFFFFF" : "rgba(255,255,255,0.28)",
          background: "none",
          border: "none",
          padding: 0,
          letterSpacing: "0.08em",
        }}>
          {playing ? "■" : "▶"}
        </button>
        <span style={{ fontFamily: VT, fontSize: "1.3rem", color: "rgba(255,255,255,0.5)", letterSpacing: "0.05em" }}>
          {fmtSecs(Math.floor(progress))}
        </span>
      </div>
      <div onClick={seek} style={{ width: "100%", height: "2px", background: "rgba(0,255,65,0.18)", position: "relative" }}>
        <div style={{ position: "absolute", left: 0, top: 0, height: "100%", width: `${pct}%`, background: GREEN, transition: "width 0.4s linear" }} />
      </div>
    </div>
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

function removeEventChatIdentity(eventId: string) {
  window.localStorage.removeItem(getEventChatNameKey(eventId));
  window.localStorage.removeItem(`${CHAT_AVATAR_KEY_PREFIX}${eventId}`);
}

function removeLegacyChatIdentity() {
  for (const key of LEGACY_CHAT_IDENTITY_KEYS) {
    window.localStorage.removeItem(key);
  }
}

export default function PublicEventPage() {
  const { event, loading, error } = useCurrentEvent();
  const [audioUrl, setAudioUrl] = useState("");
  const [now, setNow] = useState(new Date());
  const previousEventId = useRef<string | null>(null);
  const state = event ? getEventDisplayState(event, now) : "upcoming";
  const authoritativeState = event?.status ?? "upcoming";
  const waitingForLiveStatus = state === "live" && authoritativeState === "upcoming";
  const chat = useEventChat(state === "live" ? event?.id : undefined, "public");

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    removeLegacyChatIdentity();
  }, []);

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
    let active = true;
    setAudioUrl("");

    if (state !== "live") {
      return () => {
        active = false;
      };
    }

    if (!event?.audio_path) {
      return () => {
        active = false;
      };
    }

    getSignedAudioUrl(event?.audio_path)
      .then(url => {
        if (active) setAudioUrl(url);
      })
      .catch(() => {});

    return () => {
      active = false;
    };
  }, [event?.audio_path, state]);

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

  return (
    <Shell>
      {state === "upcoming" && <DVDBounce imageUrl={images.artist} />}
      {state === "upcoming" && <UpcomingPage title={title} artworkUrl={images.artwork} startsAt={countdownTarget} />}
      {state === "live" && (
        <LiveEventView
          key={event.id}
          title={title}
          artistUrl={images.artist}
          audioUrl={audioUrl}
          liveTarget={countdownTarget}
          eventId={event.id}
          messages={chat.messages}
          live={authoritativeState === "live"}
          starting={waitingForLiveStatus}
        />
      )}
      {state === "finished" && <FinishedPage event={event} title={title} merchImage={images.merch} />}
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
      <img src={src} alt="Artist" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", imageRendering: "pixelated", opacity: 0.82 }} />
    </div>
  );
}

function BouncingArtistPortrait({ imageUrl, joined }: { imageUrl: string; joined: boolean }) {
  const areaRef = useRef<HTMLDivElement>(null);
  const portraitRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const posRef = useRef({ x: 0, y: 0 });
  const velocity = useRef({ x: 1.25, y: 0.9 });

  useEffect(() => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    const resetPosition = () => {
      const area = areaRef.current?.getBoundingClientRect();
      const portrait = portraitRef.current?.getBoundingClientRect();
      if (!area || !portrait) return;
      const next = {
        x: Math.max(0, (area.width - portrait.width) / 2),
        y: Math.max(0, joined ? area.height * 0.28 : area.height * 0.1),
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
      const area = areaRef.current?.getBoundingClientRect();
      const portrait = portraitRef.current?.getBoundingClientRect();
      if (area && portrait) {
        let nextX = posRef.current.x + velocity.current.x;
        let nextY = posRef.current.y + velocity.current.y;
        const maxX = Math.max(0, area.width - portrait.width);
        const maxY = Math.max(0, area.height - portrait.height);

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
  }, [joined]);

  return (
    <div
      ref={areaRef}
      aria-hidden="true"
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        top: joined ? "10.2rem" : "9rem",
        bottom: joined ? "5.8rem" : "16rem",
        zIndex: 2,
        pointerEvents: "none",
        overflow: "hidden",
      }}
    >
      <div ref={portraitRef} style={{ position: "absolute", left: pos.x, top: pos.y }}>
        <ArtistPortrait imageUrl={imageUrl} />
      </div>
    </div>
  );
}

function LiveEventView({ title, artistUrl, audioUrl, liveTarget, eventId, messages, live, starting }: { title: string; artistUrl: string; audioUrl: string; liveTarget: string | null; eventId: string; messages: ChatMessage[]; live: boolean; starting: boolean }) {
  const joinedNameKey = getEventChatNameKey(eventId);
  const [joinedName, setJoinedName] = useState("");

  useEffect(() => {
    setJoinedName(window.localStorage.getItem(joinedNameKey) ?? "");
  }, [joinedNameKey]);

  return (
    <div style={{ position: "relative", minHeight: "100vh", background: BG, overflow: "hidden", padding: "2.2rem 1.75rem 1.25rem" }}>
      <div style={{ position: "relative", zIndex: 10, minHeight: "calc(100vh - 3.5rem)", display: "flex", flexDirection: "column" }}>
        <LiveAudioHeader title={title} audioUrl={audioUrl} />
        <div style={{ height: 1, background: "rgba(0,255,65,0.08)", margin: "1.25rem 0 0" }} />
        <LiveMessageStream messages={messages} joined={Boolean(joinedName)} eventId={eventId} />
        <BouncingArtistPortrait imageUrl={artistUrl} joined={Boolean(joinedName)} />
        <div style={{ position: "absolute", left: 0, right: 0, top: "7.5rem", display: "flex", justifyContent: "space-between", pointerEvents: "none" }}>
          <p style={{ fontFamily: VT, color: "rgba(0,255,65,0.08)", fontSize: "1.25rem", letterSpacing: "0.18em" }}>live ends</p>
          <span style={{ opacity: 0.12 }}><Countdown target={liveTarget} mode="remaining" /></span>
        </div>
        {starting && (
          <p style={{ position: "absolute", top: "8.25rem", left: 0, right: 0, fontFamily: VT, color: "rgba(0,255,65,0.7)", fontSize: "1.1rem", letterSpacing: "0.06em", textAlign: "center" }}>
            event is starting...
          </p>
        )}
        {joinedName ? (
          <ActiveChatComposer eventId={eventId} displayName={joinedName} live={live} starting={starting} />
        ) : (
          <JoinChatPanel eventId={eventId} storageKey={joinedNameKey} onJoin={setJoinedName} />
        )}
      </div>
    </div>
  );
}

function LiveAudioHeader({ title, audioUrl }: { title: string; audioUrl: string }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", alignItems: "start", gap: "1.6rem", width: "100%" }}>
      <p style={{ fontFamily: VT, fontSize: "clamp(1.35rem, 4vw, 1.85rem)", color: "rgba(255,255,255,0.38)", letterSpacing: "0.04em", paddingTop: "0.35rem" }}>
        {title}
      </p>
      <div style={{ minWidth: 0, paddingTop: 0 }}>
        {audioUrl && <AudioPlayer audioUrl={audioUrl} />}
      </div>
    </div>
  );
}

function LiveMessageStream({ messages, joined, eventId }: { messages: ChatMessage[]; joined: boolean; eventId: string }) {
  return (
    <section style={{
      position: "absolute",
      left: 0,
      right: 0,
      top: joined ? "6.2rem" : "8.1rem",
      bottom: joined ? "5.75rem" : "17rem",
      overflowY: "auto",
      display: "flex",
      flexDirection: "column",
      gap: "0.75rem",
      opacity: messages.length > 0 ? 1 : joined ? 0.9 : 0.28,
    }}>
      {joined && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "1px solid rgba(0,255,65,0.15)", paddingBottom: "0.7rem", marginBottom: "0.5rem" }}>
          <p style={{ fontFamily: VT, color: GREEN, fontSize: "1.45rem", letterSpacing: "0.22em" }}>live chat</p>
          <p style={{ fontFamily: VT, color: "rgba(0,255,65,0.4)", fontSize: "1.05rem", letterSpacing: "0.1em" }}>{messages.length} msgs</p>
        </div>
      )}
      {messages.map(message => (
        <div key={message.id} style={{
          maxWidth: joined ? "min(88%, 620px)" : "88%",
          display: "flex",
          alignItems: "flex-start",
          gap: joined ? "0.55rem" : 0,
          borderLeft: `2px solid ${message.is_highlighted ? GREEN : "rgba(0,255,65,0.3)"}`,
          padding: joined ? "0.45rem 0 0.45rem 0.65rem" : "0.25rem 0 0.25rem 0.65rem",
          background: message.is_highlighted ? "rgba(0,255,65,0.07)" : "transparent",
          order: message.is_pinned ? -1 : 0,
        }}>
          {joined && <ChatAvatar eventId={eventId} name={message.display_name} />}
          <div style={{ minWidth: 0 }}>
            <p style={{ fontFamily: VT, color: GREEN, fontSize: "0.95rem", letterSpacing: "0.05em" }}>
              {message.display_name}{message.is_admin ? " [admin]" : ""}{message.is_pinned ? " [pinned]" : ""}{message.is_liked ? " [liked]" : ""}
            </p>
            <p style={{ fontFamily: VT, color: "#fff", fontSize: "1.15rem", lineHeight: 1.15, overflowWrap: "anywhere" }}>{message.body}</p>
          </div>
        </div>
      ))}
    </section>
  );
}

function ChatAvatar({ eventId, name }: { eventId: string; name: string }) {
  return (
    <img
      src={createRetroAvatar(eventId, name)}
      alt=""
      aria-hidden="true"
      style={{
        width: 28,
        height: 28,
        objectFit: "cover",
        imageRendering: "pixelated",
        flexShrink: 0,
        opacity: 0.9,
      }}
    />
  );
}

function JoinChatPanel({ eventId, storageKey, onJoin }: { eventId: string; storageKey: string; onJoin: (name: string) => void }) {
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState("");

  function join(event: React.FormEvent) {
    event.preventDefault();
    const name = displayName.replace(/\s+/g, " ").trim().slice(0, 50);
    if (!name) {
      setError("choose a name first.");
      return;
    }
    window.localStorage.setItem(storageKey, name);
    onJoin(name);
  }

  return (
    <form onSubmit={join} style={{ position: "absolute", left: "50%", bottom: "clamp(8.5rem, 18vh, 13rem)", transform: "translateX(-50%)", width: "min(350px, 82vw)", display: "grid", gap: "1.25rem", zIndex: 3 }}>
      <div style={{ textAlign: "center", display: "grid", gap: "0.9rem" }}>
        <p style={{ fontFamily: PSP, fontSize: "clamp(1rem, 4vw, 1.55rem)", color: "#FFFFFF", letterSpacing: "0.06em" }}>join chat</p>
        <p style={{ fontFamily: VT, color: GREEN, fontSize: "1.25rem", letterSpacing: "0.22em" }}>choose name:</p>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", borderBottom: `2px solid ${GREEN}`, paddingBottom: "0.35rem" }}>
        <span style={{ fontFamily: VT, color: GREEN, fontSize: "1.35rem" }}>›</span>
        <input value={displayName} onChange={event => setDisplayName(event.target.value)} maxLength={50} aria-label="Display name" autoComplete={`event-${eventId}-name`} style={terminalInputStyle} />
        <span className="cursor-blink" style={{ width: 10, height: 3, background: GREEN }} />
      </div>
      <button disabled={!displayName.trim()} style={enterButtonStyle}>
        [ enter ]
      </button>
      {error && <p style={{ fontFamily: VT, color: "#ff5c5c", fontSize: "0.95rem", textAlign: "center" }}>{error}</p>}
    </form>
  );
}

function ActiveChatComposer({ eventId, displayName, live, starting }: { eventId: string; displayName: string; live: boolean; starting: boolean }) {
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [pendingSubmission, setPendingSubmission] = useState<{ id: string; clientToken: string } | null>(null);
  const [lastSentAt, setLastSentAt] = useState(0);

  useEffect(() => {
    setBody("");
    setError("");
    setSending(false);
    setPendingSubmission(null);
  }, [eventId]);

  useEffect(() => {
    if (!pendingSubmission) return;

    let active = true;
    const checkStatus = async () => {
      try {
        const status = await getVisitorMessageStatus(eventId, pendingSubmission.id, pendingSubmission.clientToken);
        if (!active) return;
        if (status !== "pending") {
          setPendingSubmission(null);
        }
      } catch {
        if (active) setPendingSubmission(null);
      }
    };

    checkStatus();
    const id = window.setInterval(checkStatus, 2000);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, [eventId, pendingSubmission]);

  async function submitMessage(event: React.FormEvent) {
    event.preventDefault();
    if (!live || sending || pendingSubmission) return;

    const sentAt = Date.now();
    if (sentAt - lastSentAt < 8_000) {
      setError("wait a few seconds before sending another message.");
      return;
    }

    setSending(true);
    setError("");
    try {
      const clientToken = crypto.randomUUID();
      const message = await sendVisitorMessage({ event_id: eventId, display_name: displayName, body, client_token: clientToken });
      setBody("");
      setLastSentAt(sentAt);
      setPendingSubmission({ id: message.id, clientToken });
    } catch (err) {
      setError(err instanceof Error ? err.message.toLowerCase() : "message failed.");
    } finally {
      setSending(false);
    }
  }

  const canSend = live && !sending && !pendingSubmission && Boolean(body.trim());

  return (
    <div style={{ position: "fixed", left: "clamp(0.85rem, 4vw, 1.75rem)", right: "clamp(0.85rem, 4vw, 1.75rem)", bottom: "max(1.2rem, env(safe-area-inset-bottom))", zIndex: 20 }}>
      {live ? (
        <form onSubmit={submitMessage} style={{ display: "grid", gap: "0.5rem" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", borderTop: "1px solid rgba(0,255,65,0.1)", paddingTop: "0.7rem" }}>
            <ChatAvatar eventId={eventId} name={displayName} />
            <span style={{ fontFamily: VT, color: GREEN, fontSize: "1.05rem", letterSpacing: "0.06em", maxWidth: "min(26vw, 140px)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexShrink: 0 }}>{displayName}</span>
            <span style={{ fontFamily: VT, color: GREEN, fontSize: "1.35rem" }}>›</span>
            <input value={body} onChange={event => setBody(event.target.value)} disabled={Boolean(pendingSubmission)} maxLength={500} aria-label="Message" style={{ ...terminalInputStyle, fontSize: "1.05rem" }} />
            <button disabled={!canSend} style={sendButtonStyle(canSend)}>send</button>
          </div>
          {pendingSubmission && <p style={{ fontFamily: VT, color: GREEN, fontSize: "0.95rem" }}>Waiting...</p>}
          {error && <p style={{ fontFamily: VT, color: "#ff5c5c", fontSize: "0.95rem" }}>{error}</p>}
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

function FinishedPage({ event, title, merchImage }: { event: MusicEvent; title: string; merchImage: string }) {
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

  if (event.merch_url || merchImage) {
    sections.push(
      <div key="merch" style={{ width: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: "0.75rem" }}>
        <p style={headingStyle}>buy merch</p>
        {merchImage && (
          <a href={event.merch_url || undefined} target={event.merch_url ? "_blank" : undefined} rel="noopener noreferrer" style={{ display: "block", border: `2px solid ${GREEN}` }}>
            <img src={merchImage} alt="Merchandise" style={{ width: 160, height: 160, objectFit: "cover", display: "block" }} />
          </a>
        )}
        {event.merch_url && <a href={event.merch_url} target="_blank" rel="noopener noreferrer" style={linkStyle}>→ {merchImage ? "shop now" : "go to shop"}</a>}
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
        <p style={{ fontFamily: VT, fontSize: "clamp(1rem, 3vw, 1.4rem)", color: "rgba(255,255,255,0.6)", marginTop: "-1rem" }}>{title}</p>
        {sections.length === 0 && <p style={{ fontFamily: VT, fontSize: "1.1rem", color: "rgba(0,255,65,0.5)" }}>come back soon.</p>}
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
