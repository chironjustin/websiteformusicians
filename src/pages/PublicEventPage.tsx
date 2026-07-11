import { useEffect, useMemo, useState } from "react";
import { useEventChat } from "@/hooks/useEventChat";
import { useCurrentEvent } from "@/hooks/useCurrentEvent";
import { sendVisitorMessage } from "@/services/chatService";
import { getPublicImageUrl, getSignedAudioUrl } from "@/services/storageService";
import type { ChatMessage } from "@/types/chat";
import type { MusicEvent } from "@/types/event";

const GREEN = "#00FF41";
const BG = "#000";
const VT = "'VT323', monospace";
const PSP = "'Press Start 2P', cursive";

type DisplayState = "upcoming" | "live" | "finished";

function displayState(event: MusicEvent, now: Date): DisplayState {
  const starts = event.starts_at ? new Date(event.starts_at).getTime() : null;
  const ends = event.ends_at ? new Date(event.ends_at).getTime() : null;
  if (event.status === "finished" || (ends && now.getTime() >= ends)) return "finished";
  if (event.status === "live" || (starts && now.getTime() >= starts)) return "live";
  return "upcoming";
}

function pad2(value: number) {
  return String(Math.floor(value)).padStart(2, "0");
}

function Countdown({ target }: { target: string | null }) {
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 250);
    return () => window.clearInterval(id);
  }, []);

  if (!target) return <span>soon</span>;
  const remaining = Math.max(0, new Date(target).getTime() - now.getTime());
  const seconds = Math.floor(remaining / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  return <span>{pad2(hours)}:{pad2(minutes)}:{pad2(secs)}</span>;
}

function AudioPlayer({ src }: { src: string }) {
  return (
    <audio
      controls
      src={src || undefined}
      style={{ width: "100%", accentColor: GREEN, filter: "grayscale(1) contrast(1.4)" }}
    />
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main style={{ position: "relative", minHeight: "100vh", background: BG, color: "#fff", overflow: "hidden" }}>
      <div style={{ position: "fixed", inset: 0, pointerEvents: "none", backgroundImage: "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.1) 2px, rgba(0,0,0,0.1) 4px)", zIndex: 2 }} />
      <div style={{ position: "relative", zIndex: 3 }}>{children}</div>
    </main>
  );
}

export default function PublicEventPage() {
  const { event, loading, error } = useCurrentEvent();
  const [audioUrl, setAudioUrl] = useState("");
  const [now, setNow] = useState(new Date());
  const chat = useEventChat(event?.id, "public");

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    let active = true;
    getSignedAudioUrl(event?.audio_path)
      .then(url => {
        if (active) setAudioUrl(url);
      })
      .catch(() => {
        if (active) setAudioUrl("");
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
    return <Shell><Centered muted>loading...</Centered></Shell>;
  }

  if (error) {
    return <Shell><Centered muted>{error}</Centered></Shell>;
  }

  if (!event) {
    return <Shell><Centered muted>no active event yet.</Centered></Shell>;
  }

  const state = displayState(event, now);
  const title = event.title.toLowerCase();

  if (state === "upcoming") {
    return (
      <Shell>
        {images.artist && <FloatingArtist src={images.artist} />}
        <section style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "clamp(2rem, 5vh, 4rem)", padding: 24, textAlign: "center" }}>
          <div style={{ fontFamily: PSP, fontSize: "clamp(1.1rem, 5.5vw, 2.8rem)", lineHeight: 1.3 }}>
            <Countdown target={event.starts_at} />
          </div>
          <p style={{ fontFamily: VT, fontSize: "clamp(1rem, 3vw, 1.6rem)", color: "rgba(255,255,255,0.55)" }}>{title}</p>
          <Artwork src={images.artwork} />
        </section>
      </Shell>
    );
  }

  if (state === "live") {
    return (
      <Shell>
        {images.artist && <FloatingArtist src={images.artist} />}
        <section style={{ minHeight: "100vh", maxWidth: 680, margin: "0 auto", display: "flex", flexDirection: "column", justifyContent: "center", gap: 28, padding: "32px 24px" }}>
          <p style={{ fontFamily: VT, fontSize: "clamp(1.5rem, 5vw, 2.8rem)", color: GREEN }}>{title}</p>
          <Artwork src={images.artwork} />
          {audioUrl ? <AudioPlayer src={audioUrl} /> : <p style={{ fontFamily: VT, color: "rgba(255,255,255,0.5)" }}>audio unavailable.</p>}
          <PublicChat eventId={event.id} messages={chat.messages} live />
        </section>
      </Shell>
    );
  }

  return (
    <Shell>
      <section style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 24, padding: 24, textAlign: "center" }}>
        <p style={{ fontFamily: VT, fontSize: "clamp(1rem, 3vw, 1.4rem)", color: "rgba(255,255,255,0.6)" }}>thank you for listening.</p>
        <p style={{ fontFamily: VT, fontSize: "clamp(1.2rem, 4vw, 2rem)", color: "#fff" }}>{title}</p>
        {images.merch && <img src={images.merch} alt="Merchandise" style={{ width: 160, height: 160, objectFit: "cover", border: `2px solid ${GREEN}` }} />}
        <LinkList event={event} />
        <PublicChat eventId={event.id} messages={chat.messages} live={false} />
      </section>
    </Shell>
  );
}

function Centered({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", fontFamily: VT, color: muted ? "rgba(0,255,65,0.65)" : GREEN, fontSize: 24 }}>
      {children}
    </div>
  );
}

function Artwork({ src }: { src: string }) {
  return (
    <div style={{ width: 360, height: 360, maxWidth: "82vw", maxHeight: "82vw", border: `2px solid ${GREEN}`, background: BG }}>
      {src && <img src={src} alt="Artwork" style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
    </div>
  );
}

function FloatingArtist({ src }: { src: string }) {
  return <img src={src} alt="" style={{ position: "fixed", top: 96, left: 32, width: 96, height: 96, objectFit: "cover", imageRendering: "pixelated", opacity: 0.8, zIndex: 4 }} />;
}

function LinkList({ event }: { event: MusicEvent }) {
  const links = [
    ["support me", event.support_url],
    ["shop merch", event.merch_url],
    ["next show", event.event_url],
  ].filter((link): link is [string, string] => Boolean(link[1]));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {links.map(([label, href]) => (
        <a key={label} href={href} target="_blank" rel="noreferrer" style={{ fontFamily: VT, color: GREEN, fontSize: 22, textDecoration: "none" }}>
          → {label}
        </a>
      ))}
    </div>
  );
}

function PublicChat({ eventId, messages, live }: { eventId: string; messages: ChatMessage[]; live: boolean }) {
  const [displayName, setDisplayName] = useState("");
  const [body, setBody] = useState("");
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [lastSentAt, setLastSentAt] = useState(0);

  async function submitMessage(event: React.FormEvent) {
    event.preventDefault();
    if (!live || sending) return;
    const now = Date.now();
    if (now - lastSentAt < 8_000) {
      setError("wait a few seconds before sending another message.");
      return;
    }

    setSending(true);
    setError("");
    setFeedback("");
    try {
      await sendVisitorMessage({ event_id: eventId, display_name: displayName, body });
      setBody("");
      setLastSentAt(now);
      setFeedback("message sent for approval.");
    } catch (err) {
      setError(err instanceof Error ? err.message.toLowerCase() : "message failed.");
    } finally {
      setSending(false);
    }
  }

  return (
    <section style={{ borderTop: "1px solid rgba(0,255,65,0.18)", paddingTop: 18, display: "flex", flexDirection: "column", gap: 14 }}>
      <p style={{ fontFamily: VT, color: GREEN, fontSize: 24 }}>live chat</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: 260, overflowY: "auto" }}>
        {messages.length === 0 && <p style={{ fontFamily: VT, color: "rgba(255,255,255,0.45)", fontSize: 18 }}>no approved messages yet.</p>}
        {messages.map(message => (
          <div key={message.id} style={{
            border: `1px solid ${message.is_highlighted ? GREEN : "rgba(0,255,65,0.18)"}`,
            padding: "8px 10px",
            background: message.is_highlighted ? "rgba(0,255,65,0.08)" : "transparent",
            order: message.is_pinned ? -1 : 0,
          }}>
            <p style={{ fontFamily: VT, color: GREEN, fontSize: 16 }}>
              {message.display_name}{message.is_admin ? " [admin]" : ""}{message.is_pinned ? " [pinned]" : ""}{message.is_liked ? " [liked]" : ""}
            </p>
            <p style={{ fontFamily: VT, color: "#fff", fontSize: 19, overflowWrap: "anywhere" }}>{message.body}</p>
          </div>
        ))}
      </div>

      {live ? (
        <form onSubmit={submitMessage} style={{ display: "grid", gap: 8 }}>
          <input
            value={displayName}
            onChange={event => setDisplayName(event.target.value)}
            maxLength={50}
            placeholder="name"
            style={chatInputStyle}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={body}
              onChange={event => setBody(event.target.value)}
              maxLength={500}
              placeholder="message..."
              style={chatInputStyle}
            />
            <button disabled={sending || !displayName.trim() || !body.trim()} style={{ fontFamily: VT, background: GREEN, color: BG, border: "none", padding: "0 14px", fontSize: 18 }}>
              send
            </button>
          </div>
          {feedback && <p style={{ fontFamily: VT, color: GREEN, fontSize: 16 }}>{feedback}</p>}
          {error && <p style={{ fontFamily: VT, color: "#ff5c5c", fontSize: 16 }}>{error}</p>}
        </form>
      ) : (
        <p style={{ fontFamily: VT, color: "rgba(255,255,255,0.45)", fontSize: 18 }}>chat is closed.</p>
      )}
    </section>
  );
}

const chatInputStyle: React.CSSProperties = {
  width: "100%",
  minWidth: 0,
  background: "transparent",
  color: "#fff",
  border: "1px solid rgba(0,255,65,0.35)",
  padding: "8px 10px",
  fontFamily: VT,
  fontSize: 18,
};
