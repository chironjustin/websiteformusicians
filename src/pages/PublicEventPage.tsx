import { useEffect, useMemo, useRef, useState } from "react";
import { useEventChat } from "@/hooks/useEventChat";
import { useCurrentEvent } from "@/hooks/useCurrentEvent";
import { sendVisitorMessage } from "@/services/chatService";
import { getPublicImageUrl, getSignedAudioUrl } from "@/services/storageService";
import type { ChatMessage } from "@/types/chat";
import type { MusicEvent } from "@/types/event";

const GREEN = "#00FF41";
const BG = "#000000";
const VT = "'VT323', monospace";
const PSP = "'Press Start 2P', cursive";

type DisplayState = "upcoming" | "live" | "finished";

function pad2(value: number) {
  return String(Math.floor(value)).padStart(2, "0");
}

function splitMs(ms: number) {
  const seconds = Math.floor(ms / 1000);
  return {
    hours: Math.floor(seconds / 3600),
    minutes: Math.floor((seconds % 3600) / 60),
    seconds: seconds % 60,
  };
}

function fmtSecs(seconds: number) {
  return `${pad2(Math.floor(seconds / 60))}:${pad2(seconds % 60)}`;
}

function displayState(event: MusicEvent, now: Date): DisplayState {
  const starts = event.starts_at ? new Date(event.starts_at).getTime() : null;
  const ends = event.ends_at ? new Date(event.ends_at).getTime() : null;
  if (event.status === "finished" || (ends && now.getTime() >= ends)) return "finished";
  if (event.status === "live" || (starts && now.getTime() >= starts)) return "live";
  return "upcoming";
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

        if (nextY <= 0 || nextY >= vh - size) {
          velocity.current.y *= -1;
          nextY = Math.max(0, Math.min(vh - size, nextY));
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
    <div style={{ position: "fixed", left: pos.x, top: pos.y, zIndex: 50, pointerEvents: "none", width: size, height: size }}>
      <img
        src={src}
        alt=""
        style={{ width: size, height: size, objectFit: "cover", display: "block", imageRendering: "pixelated", opacity: 0.82 }}
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
  const [remaining, setRemaining] = useState(() => {
    if (!target) return 0;
    return Math.max(0, new Date(target).getTime() - Date.now());
  });

  useEffect(() => {
    const id = window.setInterval(() => {
      if (!target) {
        setRemaining(0);
        return;
      }
      setRemaining(Math.max(0, new Date(target).getTime() - Date.now()));
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

function AudioPlayer({ audioUrl, error }: { audioUrl: string; error: string }) {
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
          {audioUrl ? fmtSecs(Math.floor(progress)) : error || "audio loading..."}
        </span>
      </div>
      <div onClick={seek} style={{ width: "100%", height: "2px", background: "rgba(0,255,65,0.18)", position: "relative" }}>
        <div style={{ position: "absolute", left: 0, top: 0, height: "100%", width: `${pct}%`, background: GREEN, transition: "width 0.4s linear" }} />
      </div>
    </div>
  );
}

function StatusPanel({ state, chatOpen, onToggleChat }: { state: DisplayState; chatOpen: boolean; onToggleChat: () => void }) {
  const states: DisplayState[] = ["upcoming", "live", "finished"];
  return (
    <nav style={{
      position: "fixed",
      bottom: 16,
      right: 16,
      zIndex: 9998,
      display: "flex",
      flexDirection: "column",
      gap: 3,
      background: "rgba(0,0,0,0.92)",
      border: `1px solid ${GREEN}`,
      padding: "8px 10px",
    }}>
      <span style={{ fontFamily: VT, fontSize: "0.7rem", color: "rgba(0,255,65,0.4)", letterSpacing: "0.15em", marginBottom: 2 }}>status</span>
      {states.map(item => (
        <span key={item} style={{
          fontFamily: VT,
          fontSize: "0.85rem",
          letterSpacing: "0.1em",
          color: state === item ? BG : GREEN,
          background: state === item ? GREEN : "transparent",
          padding: "2px 8px",
          textAlign: "left",
        }}>
          {state === item ? "› " : "  "}{item}
        </span>
      ))}
      <button onClick={onToggleChat} style={{
        fontFamily: VT,
        fontSize: "0.85rem",
        color: chatOpen ? BG : GREEN,
        background: chatOpen ? GREEN : "transparent",
        border: "none",
        padding: "2px 8px",
        textAlign: "left",
        letterSpacing: "0.1em",
      }}>
        {chatOpen ? "› " : "  "}chat
      </button>
      <div style={{ borderTop: "1px solid rgba(0,255,65,0.2)", marginTop: 4, paddingTop: 4 }}>
        <a href="/admin" style={{ fontFamily: VT, fontSize: "0.85rem", color: "rgba(0,255,65,0.5)", textDecoration: "none", letterSpacing: "0.08em" }}>
          → admin
        </a>
      </div>
    </nav>
  );
}

function Shell({ children, state, chatOpen, onToggleChat }: { children: React.ReactNode; state: DisplayState; chatOpen: boolean; onToggleChat: () => void }) {
  return (
    <main className="public-event-shell" style={{ position: "relative", minHeight: "100vh", background: BG, color: "#fff", overflow: "hidden" }}>
      <GlobalStyles />
      <CRTOverlay />
      <StatusPanel state={state} chatOpen={chatOpen} onToggleChat={onToggleChat} />
      {children}
    </main>
  );
}

export default function PublicEventPage() {
  const { event, loading, error } = useCurrentEvent();
  const [audioUrl, setAudioUrl] = useState("");
  const [audioError, setAudioError] = useState("");
  const [now, setNow] = useState(new Date());
  const [chatOpen, setChatOpen] = useState(false);
  const chat = useEventChat(event?.id, "public");

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    let active = true;
    setAudioError("");
    setAudioUrl("");

    getSignedAudioUrl(event?.audio_path)
      .then(url => {
        if (active) setAudioUrl(url);
      })
      .catch(() => {
        if (active) setAudioError("audio unavailable");
      });

    return () => {
      active = false;
    };
  }, [event?.audio_path]);

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

  const state = displayState(event, now);
  const title = event.title.toLowerCase();
  const liveTarget = event.ends_at || (event.duration_hours && event.starts_at
    ? new Date(new Date(event.starts_at).getTime() + event.duration_hours * 60 * 60 * 1000).toISOString()
    : null);

  return (
    <Shell state={state} chatOpen={chatOpen} onToggleChat={() => setChatOpen(open => !open)}>
      {state !== "finished" && <DVDBounce imageUrl={images.artist} />}
      {state === "upcoming" && <UpcomingPage title={title} artworkUrl={images.artwork} startsAt={event.starts_at} />}
      {state === "live" && <LivePage title={title} artworkUrl={images.artwork} audioUrl={audioUrl} audioError={audioError} liveTarget={liveTarget} />}
      {state === "finished" && <FinishedPage event={event} title={title} merchImage={images.merch} />}
      <ChatDrawer
        eventId={event.id}
        messages={chat.messages}
        open={chatOpen}
        live={state === "live"}
        onClose={() => setChatOpen(false)}
      />
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

function LivePage({ title, artworkUrl, audioUrl, audioError, liveTarget }: { title: string; artworkUrl: string; audioUrl: string; audioError: string; liveTarget: string | null }) {
  return (
    <div style={{ position: "relative", minHeight: "100vh", background: BG, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ position: "relative", zIndex: 10, display: "flex", flexDirection: "column", alignItems: "center", gap: "clamp(1.25rem, 4vh, 2.5rem)", padding: "2rem", width: "min(640px, 92vw)" }}>
        <Countdown target={liveTarget} mode="remaining" />
        <p style={{ fontFamily: VT, fontSize: "clamp(1rem, 3vw, 1.6rem)", color: "rgba(255,255,255,0.55)", textAlign: "center", letterSpacing: "0.04em" }}>
          {title}
        </p>
        <Artwork size={320} imageUrl={artworkUrl} />
        <div style={{ width: "100%", maxWidth: 480 }}>
          <AudioPlayer audioUrl={audioUrl} error={audioError} />
        </div>
      </div>
    </div>
  );
}

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

function ChatDrawer({ eventId, messages, open, live, onClose }: { eventId: string; messages: ChatMessage[]; open: boolean; live: boolean; onClose: () => void }) {
  const [displayName, setDisplayName] = useState("");
  const [body, setBody] = useState("");
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [lastSentAt, setLastSentAt] = useState(0);

  async function submitMessage(event: React.FormEvent) {
    event.preventDefault();
    if (!live || sending) return;

    const sentAt = Date.now();
    if (sentAt - lastSentAt < 8_000) {
      setError("wait a few seconds before sending another message.");
      return;
    }

    setSending(true);
    setError("");
    setFeedback("");
    try {
      await sendVisitorMessage({ event_id: eventId, display_name: displayName, body });
      setBody("");
      setLastSentAt(sentAt);
      setFeedback("message sent for approval.");
    } catch (err) {
      setError(err instanceof Error ? err.message.toLowerCase() : "message failed.");
    } finally {
      setSending(false);
    }
  }

  return (
    <aside style={{
      position: "fixed",
      top: 0,
      right: 0,
      bottom: 0,
      zIndex: 9999,
      width: "min(360px, 92vw)",
      background: "rgba(0,0,0,0.96)",
      borderLeft: `1px solid ${GREEN}`,
      transform: open ? "translateX(0)" : "translateX(100%)",
      transition: "transform 180ms ease",
      display: "flex",
      flexDirection: "column",
      padding: "1rem",
      color: "#fff",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", borderBottom: "1px solid rgba(0,255,65,0.18)", paddingBottom: "0.75rem" }}>
        <p style={{ fontFamily: VT, color: GREEN, fontSize: "1.3rem", letterSpacing: "0.12em" }}>live chat</p>
        <span className="cursor-blink" style={{ fontFamily: VT, color: GREEN }}>_</span>
        <button onClick={onClose} style={{ marginLeft: "auto", fontFamily: VT, color: GREEN, background: "transparent", border: "none", fontSize: "1.1rem" }}>close</button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: "0.8rem", padding: "1rem 0" }}>
        {messages.length === 0 && <p style={{ fontFamily: VT, color: "rgba(255,255,255,0.45)", fontSize: "1.05rem" }}>no approved messages yet.</p>}
        {messages.map(message => (
          <div key={message.id} style={{
            border: `1px solid ${message.is_highlighted ? GREEN : "rgba(0,255,65,0.18)"}`,
            padding: "0.55rem 0.65rem",
            background: message.is_highlighted ? "rgba(0,255,65,0.08)" : "transparent",
            order: message.is_pinned ? -1 : 0,
          }}>
            <p style={{ fontFamily: VT, color: GREEN, fontSize: "0.95rem", letterSpacing: "0.04em" }}>
              {message.display_name}{message.is_admin ? " [admin]" : ""}{message.is_pinned ? " [pinned]" : ""}{message.is_liked ? " [liked]" : ""}
            </p>
            <p style={{ fontFamily: VT, color: "#fff", fontSize: "1.2rem", lineHeight: 1.2, overflowWrap: "anywhere" }}>{message.body}</p>
          </div>
        ))}
      </div>

      {live ? (
        <form onSubmit={submitMessage} style={{ borderTop: "1px solid rgba(0,255,65,0.18)", paddingTop: "0.75rem", display: "grid", gap: "0.55rem" }}>
          <input value={displayName} onChange={event => setDisplayName(event.target.value)} maxLength={50} placeholder="name" style={chatInputStyle} />
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <input value={body} onChange={event => setBody(event.target.value)} maxLength={500} placeholder="message..." style={chatInputStyle} />
            <button disabled={sending || !displayName.trim() || !body.trim()} style={{ fontFamily: VT, background: GREEN, color: BG, border: "none", padding: "0 0.8rem", fontSize: "1.1rem" }}>
              send
            </button>
          </div>
          {feedback && <p style={{ fontFamily: VT, color: GREEN, fontSize: "0.95rem" }}>{feedback}</p>}
          {error && <p style={{ fontFamily: VT, color: "#ff5c5c", fontSize: "0.95rem" }}>{error}</p>}
        </form>
      ) : (
        <p style={{ borderTop: "1px solid rgba(0,255,65,0.18)", paddingTop: "0.75rem", fontFamily: VT, color: "rgba(255,255,255,0.45)", fontSize: "1.05rem" }}>chat is closed.</p>
      )}
    </aside>
  );
}

const chatInputStyle: React.CSSProperties = {
  width: "100%",
  minWidth: 0,
  background: "transparent",
  color: "#fff",
  border: "1px solid rgba(0,255,65,0.35)",
  padding: "0.5rem 0.6rem",
  fontFamily: VT,
  fontSize: "1.05rem",
};
