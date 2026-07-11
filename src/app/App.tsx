import { useState, useEffect, useRef, useCallback } from "react";
import { Radio } from "lucide-react";

// ══════════════════════════════════════════════════════════
// CONSTANTS
// ══════════════════════════════════════════════════════════
const GREEN = "#00FF41";
const BG = "#000000";
const VT = "'VT323', monospace";
const PSP = "'Press Start 2P', cursive";

// ══════════════════════════════════════════════════════════
// TYPES
// ══════════════════════════════════════════════════════════
interface EventConfig {
  songTitle: string;
  description: string;
  audioUrl: string;
  artworkUrl: string;
  artistImage: string;
  merchImage: string;
  startTime: Date;
  durationMs: number;
  links: {
    coffee: string;
    merch: string;
    liveShow: string;
    spotify: string;
    instagram: string;
    newsletter: string;
  };
}
interface ChatMessage {
  id: string;
  username: string;
  text: string;
  status: "pending" | "approved" | "rejected";
  ts: number;
}
type EventState = "upcoming" | "live" | "finished";
type AdminTab = "status" | "chat" | "setup";

// ══════════════════════════════════════════════════════════
// PIXEL ART COLOR MAP
// ══════════════════════════════════════════════════════════
const PC: Record<string, string> = {
  W: "#FFFFFF", L: "#AAAAAA", G: "#666666", g: "#2a2a2a",
  R: "#FF2200", O: "#FF6600", Y: "#FFD700", N: "#00CC44",
  B: "#0055FF", P: "#9900EE", C: "#00CCFF", M: "#FF00CC",
  T: "#FF4400", Z: "#00FF41",
};

// ══════════════════════════════════════════════════════════
// AVATAR SPRITES (8×8 pixel art)
// '.' = transparent, other chars → PC color map
// ══════════════════════════════════════════════════════════
const SPRITES = [
  { id: "ghost",   rows: ["..WWW...", ".WWWWWW.", "WWgWWgWW", "WWWWWWWW", "WWWWWWWW", ".WW.WW..", "..W...W.", "........"] },
  { id: "skull",   rows: [".WWWWWW.", "WWWWWWWW", "WgWWWWgW", "WWWWWWWW", ".WWWWWW.", ".WWWWWW.", ".WW..WW.", "........"] },
  { id: "alien",   rows: ["..NNNN..", ".NNNNNN.", "NNgNNgNN", "NNNNNNNN", ".NNNNNN.", "..NNNN..", "...NN...", "........"] },
  { id: "wizard",  rows: ["...PP...", "..PPPP..", ".PPPPPP.", "PPPPPPPP", ".WWWWWW.", "WWWWWWWW", ".WWWWWW.", "........"] },
  { id: "dragon",  rows: ["R.....RR", ".RRRRRR.", "RRRRRRRR", ".RRRRRR.", "RRRRRRRR", "..OOOO..", ".OOOOOO.", "...OO..."] },
  { id: "robot",   rows: [".LLLLLL.", "LLLLLLLL", "LCLLLLCL", "LLLLLLLL", ".LLLLLL.", "LLLLLLLL", ".LL..LL.", "........"] },
  { id: "fire",    rows: ["...Y....", "..YYY...", ".YYYYO..", "YYYYYOO.", "YOOOOOOO", ".OOOOOOO", "..OOOOO.", "...OOO.."] },
  { id: "cat",     rows: ["LL....LL", "LLLLLLLL", "LgLLLLgL", "LLLLLLLL", ".LLLLLL.", ".L.LL.L.", "..L..L..", "........"] },
  { id: "demon",   rows: ["R.....R.", "RR...RR.", ".RRRRR..", "RRgRRgRR", "RRRRRRRR", ".RRRRR..", "..RRR...", "...R...."] },
  { id: "ufo",     rows: ["..LLLL..", ".LLLLLL.", "LLLLLLLL", "CCCCCCCC", ".CCCCCC.", "..CCCC..", "...CC...", "........"] },
  { id: "blob",    rows: [".NNN....", "NNNNNNN.", "NNgNNNN.", "NNNNNNN.", "NNNNNNN.", ".NNNNNN.", "...NNN..", "........"] },
  { id: "glitch",  rows: ["RRRWWWBB", "RRWWWBBB", "RWWWBBBB", "WWWBBBBB", "WWBBBBBR", "WBBBBBR.", "BBBBR...", "BBBR...."] },
  { id: "crown",   rows: ["Y.Y.Y.Y.", "YYYYYYYY", "YYYYYYYY", ".YYYYYY.", ".YYYYYY.", ".YYYYYY.", "........", "........"] },
  { id: "starman", rows: ["...Y....", "..YYY...", ".YYYYYYY", "YYYYYYYY", ".YYYYYYY", "..YYY...", "...Y....", "........"] },
];


// ══════════════════════════════════════════════════════════
// UTILITY
// ══════════════════════════════════════════════════════════
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h * 31) + s.charCodeAt(i)) >>> 0;
  return h;
}
function pad2(n: number) { return String(Math.floor(n)).padStart(2, "0"); }
function splitMs(ms: number) {
  const s = Math.floor(ms / 1000);
  return { days: Math.floor(s / 86400), hours: Math.floor((s % 86400) / 3600), minutes: Math.floor((s % 3600) / 60), seconds: s % 60 };
}
function fmtSecs(s: number) { return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`; }
function getEventState(config: EventConfig, now: Date): EventState {
  const start = config.startTime.getTime();
  if (now.getTime() < start) return "upcoming";
  if (now.getTime() < start + config.durationMs) return "live";
  return "finished";
}

// ══════════════════════════════════════════════════════════
// GLOBAL STYLES — keyframes injected at runtime
// ══════════════════════════════════════════════════════════
function GlobalStyles() {
  const css = `
    @keyframes glitch {
      0%, 84%, 100% { transform: none; text-shadow: none; }
      85% { transform: translateX(-4px); text-shadow: 4px 0 ${GREEN}, -2px 0 #FF0000; }
      87% { transform: translateX(4px); text-shadow: -4px 0 ${GREEN}, 2px 0 #FF0000; }
      89% { transform: translateY(-2px); text-shadow: 0 3px #0033FF; }
      91% { transform: none; text-shadow: none; }
    }
    @keyframes pixelFloat {
      0%, 100% { transform: translateY(0px) rotate(0deg); }
      50% { transform: translateY(-10px) rotate(2deg); }
    }
    @keyframes pixelBlink {
      0%, 87%, 100% { opacity: 0.65; }
      88% { opacity: 0.05; }
      94% { opacity: 0.65; }
      97% { opacity: 0.1; }
    }
    @keyframes cursorBlink {
      0%, 100% { opacity: 1; }
      50% { opacity: 0; }
    }
    .glitch-anim { animation: glitch 7s infinite; }
    .pixel-float { animation: pixelFloat 3.5s ease-in-out infinite; }
    .pixel-blink { animation: pixelBlink 3s step-end infinite; }
    .cursor-blink { animation: cursorBlink 1s step-end infinite; }
    * { cursor: crosshair !important; box-sizing: border-box; }
    input, textarea { cursor: text !important; }
    ::-webkit-scrollbar { display: none; }
    * { scrollbar-width: none; }
  `;
  return <style dangerouslySetInnerHTML={{ __html: css }} />;
}

// ══════════════════════════════════════════════════════════
// CRT OVERLAY
// ══════════════════════════════════════════════════════════
function CRTOverlay() {
  return (
    <div className="fixed inset-0 pointer-events-none" style={{ zIndex: 997 }}>
      <div style={{
        position: "absolute", inset: 0,
        backgroundImage: "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.07) 2px, rgba(0,0,0,0.07) 4px)",
      }} />
      <div style={{
        position: "absolute", inset: 0,
        background: "radial-gradient(ellipse at 50% 50%, transparent 50%, rgba(0,0,0,0.72) 100%)",
      }} />
    </div>
  );
}

// ══════════════════════════════════════════════════════════
// PIXEL ART RENDERER
// ══════════════════════════════════════════════════════════
function PixelSprite({ rows, size = 32 }: { rows: string[]; size?: number }) {
  const nc = rows[0].length;
  const nr = rows.length;
  const cw = size / nc;
  const ch = size / nr;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}
      style={{ imageRendering: "pixelated", display: "block", shapeRendering: "crispEdges" }}>
      {rows.flatMap((row, y) =>
        Array.from(row).map((char, x) =>
          char !== "." && PC[char] ? (
            <rect key={`${x}-${y}`} x={x * cw} y={y * ch} width={cw} height={ch} fill={PC[char]} />
          ) : null
        )
      )}
    </svg>
  );
}

function PixelAvatar({ username, size = 40 }: { username: string; size?: number }) {
  const sprite = SPRITES[hashStr(username) % SPRITES.length];
  return <PixelSprite rows={sprite.rows} size={size} />;
}

// ══════════════════════════════════════════════════════════
// DEV PAGE SWITCHER — temporary, remove before launch
// ══════════════════════════════════════════════════════════
function DevSwitcher({ current, onSwitch }: { current: EventState; onSwitch: (s: EventState) => void }) {
  const states: EventState[] = ["upcoming", "live", "finished"];
  return (
    <div style={{
      position: "fixed", bottom: 16, right: 16, zIndex: 9998,
      display: "flex", flexDirection: "column", gap: 3,
      background: "rgba(0,0,0,0.92)", border: `1px solid ${GREEN}`,
      padding: "8px 10px",
    }}>
      <span style={{ fontFamily: VT, fontSize: "0.7rem", color: "rgba(0,255,65,0.4)", letterSpacing: "0.15em", marginBottom: 2 }}>dev</span>
      {states.map(s => (
        <button key={s} onClick={() => onSwitch(s)} style={{
          fontFamily: VT, fontSize: "0.85rem", letterSpacing: "0.1em",
          color: current === s ? BG : GREEN,
          background: current === s ? GREEN : "transparent",
          border: "none", padding: "2px 8px", textAlign: "left",
        }}>
          {current === s ? "› " : "  "}{s}
        </button>
      ))}
      <div style={{ borderTop: "1px solid rgba(0,255,65,0.2)", marginTop: 4, paddingTop: 4 }}>
        <a href="?admin" style={{ fontFamily: VT, fontSize: "0.85rem", color: "rgba(0,255,65,0.5)", textDecoration: "none", letterSpacing: "0.08em" }}>
          → admin
        </a>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════
// DVD-STYLE BOUNCING ARTIST IMAGE
// ══════════════════════════════════════════════════════════
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
  const SIZE = 96;
  const [pos, setPos] = useState({ x: 180, y: 130 });
  const vel = useRef({ x: 2.2, y: 1.75 });

  useEffect(() => {
    let raf: number;
    const tick = () => {
      setPos(prev => {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        let nx = prev.x + vel.current.x;
        let ny = prev.y + vel.current.y;
        if (nx <= 0 || nx >= vw - SIZE) {
          vel.current.x *= -1;
          nx = Math.max(0, Math.min(vw - SIZE, nx));
        }
        if (ny <= 0 || ny >= vh - SIZE) {
          vel.current.y *= -1;
          ny = Math.max(0, Math.min(vh - SIZE, ny));
        }
        return { x: nx, y: ny };
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const src = imageUrl.trim() || PLACEHOLDER_SRC;

  return (
    <div style={{
      position: "fixed", left: pos.x, top: pos.y, zIndex: 50,
      pointerEvents: "none", width: SIZE, height: SIZE,
    }}>
      <img
        src={src}
        alt=""
        style={{
          width: SIZE, height: SIZE,
          objectFit: "cover",
          display: "block",
          imageRendering: "pixelated",
          opacity: 0.82,
        }}
      />
    </div>
  );
}

// ══════════════════════════════════════════════════════════
// ARTWORK
// ══════════════════════════════════════════════════════════
function Artwork({ size = 320, imageUrl = "" }: { size?: number; imageUrl?: string }) {
  const corners = [
    { top: -2, left: -2 }, { top: -2, right: -2 },
    { bottom: -2, left: -2 }, { bottom: -2, right: -2 },
  ];
  const boxStyle: React.CSSProperties = {
    width: size, height: size,
    maxWidth: "min(82vw, 82vmin)", maxHeight: "min(82vw, 82vmin)",
    border: `2px solid ${GREEN}`,
    boxShadow: "none",
    position: "relative", flexShrink: 0, overflow: "hidden",
  };
  return (
    <div style={{ ...boxStyle, background: imageUrl ? "transparent" : BG }}>
      {imageUrl && (
        <img src={imageUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
      )}
      {corners.map((pos, i) => (
        <div key={i} style={{ position: "absolute", width: 8, height: 8, background: GREEN, zIndex: 1, ...pos }} />
      ))}
    </div>
  );
}

// ══════════════════════════════════════════════════════════
// COUNTDOWN
// ══════════════════════════════════════════════════════════
function Countdown({ target }: { target: Date }) {
  const [rem, setRem] = useState(Math.max(0, target.getTime() - Date.now()));
  useEffect(() => {
    const id = setInterval(() => setRem(Math.max(0, target.getTime() - Date.now())), 50);
    return () => clearInterval(id);
  }, [target]);
  const { hours, minutes, seconds } = splitMs(rem);
  const cs = Math.floor((rem % 1000) / 10); // centiseconds 00–99
  const str = `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}:${pad2(cs)}`;
  return (
    <span style={{
      fontFamily: PSP,
      fontSize: "clamp(1.1rem, 5.5vw, 2.8rem)",
      color: "#FFFFFF",
      letterSpacing: "0.04em",
      textShadow: "none",
      lineHeight: 1.3,
    }}>
      {str}
    </span>
  );
}

// ══════════════════════════════════════════════════════════
// AUDIO PLAYER (minimal: symbol / time / loop)
// ══════════════════════════════════════════════════════════
function AudioPlayer({ audioUrl }: { audioUrl: string }) {
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const audioRef = useRef<HTMLAudioElement>(null);

  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    playing ? el.pause() : el.play().catch(() => {});
    setPlaying(!playing);
  };

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onTime = () => setProgress(el.currentTime);
    const onMeta = () => setDuration(el.duration || 0);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    // attempt autoplay — browser may require prior interaction
    el.play().catch(() => {});
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
    };
  }, []);

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = audioRef.current;
    if (!el || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    el.currentTime = ((e.clientX - rect.left) / rect.width) * duration;
  };

  const pct = duration > 0 ? (progress / duration) * 100 : 0;

  return (
    <div style={{ width: "100%" }}>
      <audio ref={audioRef} src={audioUrl || undefined} loop />
      <div style={{ display: "flex", alignItems: "center", gap: "1.25rem", marginBottom: "0.6rem" }}>
        <button onClick={toggle} style={{
          fontFamily: VT, fontSize: "1.4rem", color: "#FFFFFF",
          background: "none", border: "none", padding: 0, letterSpacing: "0.08em",
        }}>
          {playing ? "■" : "▶"}
        </button>
        <span style={{ fontFamily: VT, fontSize: "1.3rem", color: "rgba(255,255,255,0.5)", letterSpacing: "0.05em" }}>
          {fmtSecs(Math.floor(progress))}
        </span>
      </div>
      <div onClick={seek} style={{ width: "100%", height: "2px", background: "rgba(0,255,65,0.18)", position: "relative" }}>
        <div style={{
          position: "absolute", left: 0, top: 0, height: "100%",
          width: `${pct}%`, background: GREEN, transition: "width 0.4s linear",
        }} />
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════
// USERNAME MODAL
// ══════════════════════════════════════════════════════════
function UsernameModal({ onJoin }: { onJoin: (name: string) => void }) {
  const [val, setVal] = useState("");
  const trimmed = val.trim();
  const valid = trimmed.length >= 2;
  const go = () => { if (valid) onJoin(trimmed); };

  return (
    <div style={{
      position: "absolute", inset: 0, zIndex: 20,
      background: "rgba(0,0,0,0.82)",
      backdropFilter: "blur(2px)",
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      padding: "2rem",
    }}>
      <p style={{ fontFamily: VT, fontSize: "1.4rem", color: "#FFFFFF", marginBottom: "0.5rem", letterSpacing: "0.1em" }}>
        join chat
      </p>
      <p style={{ fontFamily: VT, fontSize: "0.9rem", color: GREEN, marginBottom: "1.75rem", letterSpacing: "0.15em" }}>
        choose name:
      </p>

      <div style={{
        borderBottom: `2px solid ${GREEN}`, display: "flex", alignItems: "center",
        gap: "0.4rem", paddingBottom: "0.5rem", marginBottom: "1.75rem",
        width: "100%", maxWidth: "260px",
      }}>
        <span style={{ fontFamily: VT, fontSize: "1.3rem", color: GREEN }}>›</span>
        <input
          autoFocus
          value={val}
          onChange={e => setVal(e.target.value)}
          onKeyDown={e => e.key === "Enter" && go()}
          maxLength={16}
          style={{
            flex: 1, background: "transparent", border: "none", outline: "none",
            fontFamily: VT, fontSize: "1.5rem", color: "#FFFFFF", letterSpacing: "0.05em",
          }}
        />
        <span className="cursor-blink" style={{ fontFamily: VT, fontSize: "1.5rem", color: GREEN }}>_</span>
      </div>

      <button onClick={go} disabled={!valid} style={{
        fontFamily: VT, fontSize: "1rem", letterSpacing: "0.18em",
        color: BG, background: GREEN, border: "none",
        padding: "0.4rem 1.6rem", opacity: valid ? 1 : 0.25, transition: "opacity 0.2s",
      }}>
        [ enter ]
      </button>
    </div>
  );
}

// ══════════════════════════════════════════════════════════
// LIVE CHAT
// ══════════════════════════════════════════════════════════
interface LiveChatProps {
  messages: ChatMessage[];
  onSend: (username: string, text: string) => void;
}
function LiveChat({ messages, onSend }: LiveChatProps) {
  const [username, setUsername] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [hasPending, setHasPending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const approved = messages.filter(m => m.status === "approved");

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [approved.length]);

  const send = useCallback(() => {
    if (!username || !input.trim()) return;
    onSend(username, input.trim());
    setInput("");
    setHasPending(true);
    setTimeout(() => setHasPending(false), 8000);
  }, [username, input, onSend]);

  return (
    <div style={{ position: "relative", display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", gap: "0.5rem",
        marginBottom: "0.75rem", paddingBottom: "0.5rem",
        borderBottom: "1px solid rgba(0,255,65,0.18)", flexShrink: 0,
      }}>
        <span style={{ fontFamily: VT, fontSize: "0.95rem", color: GREEN, letterSpacing: "0.18em" }}>live chat</span>
        <span className="cursor-blink" style={{ fontFamily: VT, fontSize: "0.9rem", color: GREEN }}>_</span>
        <span style={{ marginLeft: "auto", fontFamily: VT, fontSize: "0.85rem", color: "rgba(0,255,65,0.35)" }}>
          {approved.length} msg{approved.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: "auto", minHeight: 0, display: "flex", flexDirection: "column", gap: "1rem" }}>
        {approved.map(m => (
          <div key={m.id} style={{ display: "flex", gap: "0.65rem", alignItems: "flex-start" }}>
            <div style={{ flexShrink: 0, marginTop: 2 }}>
              <PixelAvatar username={m.username} size={32} />
            </div>
            <div>
              <p style={{ fontFamily: VT, fontSize: "0.9rem", color: GREEN, marginBottom: "0.05rem", letterSpacing: "0.06em" }}>
                {m.username}
              </p>
              <p style={{ fontFamily: VT, fontSize: "1.05rem", color: "#FFFFFF", lineHeight: 1.25 }}>
                {m.text}
              </p>
            </div>
          </div>
        ))}
        {hasPending && username && (
          <div style={{ display: "flex", gap: "0.65rem", alignItems: "flex-start", opacity: 0.35 }}>
            <PixelAvatar username={username} size={32} />
            <div>
              <p style={{ fontFamily: VT, fontSize: "0.9rem", color: GREEN, marginBottom: "0.05rem" }}>{username}</p>
              <p style={{ fontFamily: VT, fontSize: "1.05rem", color: "rgba(255,255,255,0.5)", fontStyle: "italic" }}>waiting...</p>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Username overlay — messages still visible behind it */}
      {!username && <UsernameModal onJoin={setUsername} />}

      {/* Input */}
      {username && (
        <div style={{ flexShrink: 0, borderTop: "1px solid rgba(0,255,65,0.12)", paddingTop: "0.65rem", marginTop: "0.5rem" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.45rem" }}>
            <PixelAvatar username={username} size={22} />
            <span style={{ fontFamily: VT, fontSize: "0.85rem", color: GREEN, flexShrink: 0 }}>{username} ›</span>
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && send()}
              placeholder="..."
              maxLength={200}
              style={{
                flex: 1, background: "transparent", border: "none", outline: "none", minWidth: 0,
                fontFamily: VT, fontSize: "1.05rem", color: "#FFFFFF",
              }}
            />
            <button onClick={send} disabled={!input.trim()} style={{
              fontFamily: VT, fontSize: "1.3rem", color: GREEN, background: "none",
              border: "none", padding: 0, opacity: input.trim() ? 1 : 0.2,
              transition: "opacity 0.15s", flexShrink: 0,
            }}>→</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════
// UPCOMING PAGE — countdown / title / artwork only
// ══════════════════════════════════════════════════════════
function UpcomingPage({ config }: { config: EventConfig }) {
  return (
    <div style={{ position: "relative", minHeight: "100vh", background: BG, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ position: "relative", zIndex: 10, display: "flex", flexDirection: "column", alignItems: "center", gap: "clamp(2rem, 5vh, 4rem)", padding: "2rem" }}>
        <Countdown target={config.startTime} />
        <p style={{ fontFamily: VT, fontSize: "clamp(1rem, 3vw, 1.6rem)", color: "rgba(255,255,255,0.55)", textAlign: "center", letterSpacing: "0.04em" }}>
          {config.songTitle.toLowerCase()}
        </p>
        <Artwork size={360} imageUrl={config.artworkUrl} />
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════
// LIVE PAGE
// ══════════════════════════════════════════════════════════
interface LivePageProps {
  config: EventConfig;
  messages: ChatMessage[];
  onSendMessage: (username: string, text: string) => void;
}
function LivePage({ config, messages, onSendMessage }: LivePageProps) {
  return (
    <div style={{ position: "relative", height: "100vh", background: BG, overflow: "hidden", display: "flex", flexDirection: "column" }}>
      {/* Slim top bar: song title + player — border spans full width */}
      <div style={{ position: "relative", zIndex: 10, flexShrink: 0, borderBottom: "1px solid rgba(0,255,65,0.12)" }}>
        <div style={{
          padding: "1.25rem 1.5rem 1rem",
          display: "flex", alignItems: "center", gap: "1.5rem",
          maxWidth: "640px", width: "100%", margin: "0 auto",
        }}>
          <p style={{ fontFamily: VT, fontSize: "1.1rem", color: "rgba(255,255,255,0.5)", letterSpacing: "0.04em", flexShrink: 0 }}>
            {config.songTitle.toLowerCase()}
          </p>
          <div style={{ flex: 1 }}>
            <AudioPlayer audioUrl={config.audioUrl} />
          </div>
        </div>
      </div>

      {/* Chat fills the rest */}
      <div style={{
        position: "relative", zIndex: 10, flex: 1, minHeight: 0,
        maxWidth: "640px", width: "100%", margin: "0 auto",
        padding: "1rem 1.5rem",
        display: "flex", flexDirection: "column",
      }}>
        <LiveChat messages={messages} onSend={onSendMessage} />
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════
// FINISHED PAGE
// ══════════════════════════════════════════════════════════
function FinishedPage({ config }: { config: EventConfig }) {
  const { links, merchImage } = config;

  const linkStyle: React.CSSProperties = {
    fontFamily: VT, fontSize: "clamp(1rem, 3vw, 1.3rem)",
    color: GREEN, textDecoration: "none", letterSpacing: "0.05em",
    display: "inline-block",
  };
  const headingStyle: React.CSSProperties = {
    fontFamily: VT, fontSize: "clamp(1.4rem, 5vw, 2.2rem)", color: "#FFFFFF", lineHeight: 1.2,
  };

  // Build only the sections that have something to show
  const sections: React.ReactNode[] = [];

  if (links.coffee) {
    sections.push(
      <div key="coffee" style={{ width: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: "0.6rem" }}>
        <p style={headingStyle}>support me 🤑</p>
        <a href={links.coffee} target="_blank" rel="noopener noreferrer" style={linkStyle}>
          → buy me a coffee
        </a>
      </div>
    );
  }

  if (links.merch || merchImage) {
    sections.push(
      <div key="merch" style={{ width: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: "0.75rem" }}>
        <p style={headingStyle}>buy merch 😎</p>
        {merchImage && (
          <a href={links.merch || undefined} target={links.merch ? "_blank" : undefined} rel="noopener noreferrer"
            style={{ display: "block", border: `2px solid ${GREEN}` }}>
            <img src={merchImage} alt="merch" style={{ width: 160, height: 160, objectFit: "cover", display: "block" }} />
          </a>
        )}
        {links.merch && (
          <a href={links.merch} target="_blank" rel="noopener noreferrer" style={linkStyle}>
            → {merchImage ? "shop now" : "go to shop"}
          </a>
        )}
      </div>
    );
  }

  if (links.liveShow) {
    sections.push(
      <div key="show" style={{ width: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: "0.6rem" }}>
        <p style={headingStyle}>pull up to next show:</p>
        <a href={links.liveShow} target="_blank" rel="noopener noreferrer" style={linkStyle}>
          → get tickets
        </a>
      </div>
    );
  }

  return (
    <div style={{
      position: "relative", minHeight: "100vh", background: BG, overflow: "hidden",
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <div style={{
        position: "relative", zIndex: 10, textAlign: "center",
        display: "flex", flexDirection: "column", alignItems: "center",
        gap: "1.75rem", padding: "3rem 1.5rem", maxWidth: "420px", width: "100%",
      }}>
        <p style={{ fontFamily: VT, fontSize: "clamp(0.85rem, 2.5vw, 1.1rem)", color: "rgba(255,255,255,0.35)" }}>
          thank you for listening.
        </p>
        <p style={{ fontFamily: VT, fontSize: "clamp(1rem, 3vw, 1.4rem)", color: "rgba(255,255,255,0.6)", marginTop: "-1rem" }}>
          {config.songTitle.toLowerCase()}
        </p>

        {/* Render visible sections with "or" only between them */}
        {sections.map((section, i) => (
          <div key={i} style={{ width: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: "1.75rem" }}>
            {i > 0 && (
              <p style={{ fontFamily: VT, fontSize: "1rem", color: "rgba(0,255,65,0.28)", letterSpacing: "0.25em" }}>
                or
              </p>
            )}
            {section}
          </div>
        ))}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════
// REUSABLE UPLOAD CARD (admin only)
// ══════════════════════════════════════════════════════════
interface UploadCardProps {
  label: string;
  hint: string;
  accept: string;
  currentUrl: string;
  onFile: (url: string) => void;
  preview: (url: string) => React.ReactNode;
}
function UploadCard({ label, hint, accept, currentUrl, onFile, preview }: UploadCardProps) {
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    onFile(url);
  };

  const btnStyle: React.CSSProperties = {
    fontSize: 12, padding: "6px 14px", border: "1px solid #d1d5db",
    borderRadius: 4, background: "#fff", color: "#374151",
    fontWeight: 500, fontFamily: "system-ui, sans-serif",
  };

  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, padding: 16 }}>
      <p style={{ fontSize: 13, fontWeight: 600, marginBottom: 3 }}>{label}</p>
      <p style={{ fontSize: 12, color: "#9ca3af", marginBottom: 10 }}>{hint}</p>
      <input ref={fileRef} type="file" accept={accept} style={{ display: "none" }} onChange={handleFile} />
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button style={btnStyle} onClick={() => fileRef.current?.click()}>
          {currentUrl ? "Replace file" : "Upload file"}
        </button>
        {currentUrl && (
          <button style={{ ...btnStyle, color: "#ef4444", border: "1px solid #fca5a5" }}
            onClick={() => { onFile(""); if (fileRef.current) fileRef.current.value = ""; }}>
            Remove
          </button>
        )}
      </div>
      {currentUrl && preview(currentUrl)}
      {!currentUrl && (
        <p style={{ fontSize: 11, color: "#d1d5db", marginTop: 8 }}>No file uploaded yet.</p>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════
// ADMIN PANEL — clean, functional, no chaos
// ══════════════════════════════════════════════════════════
interface AdminPanelProps {
  config: EventConfig;
  onConfigChange: (c: EventConfig) => void;
  messages: ChatMessage[];
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  currentState: EventState;
  onStartNow: () => void;
  onEndNow: () => void;
}
function AdminPanel({ config, onConfigChange, messages, onApprove, onReject, currentState, onStartNow, onEndNow }: AdminPanelProps) {
  const [tab, setTab] = useState<AdminTab>("status");
  const pending = messages.filter(m => m.status === "pending");

  const inp = (extra?: React.CSSProperties): React.CSSProperties => ({
    width: "100%", padding: "6px 10px", border: "1px solid #d1d5db", borderRadius: 4,
    fontSize: 13, fontFamily: "system-ui, sans-serif", outline: "none", background: "#fff", color: "#111", ...extra,
  });
  const set = (k: keyof EventConfig, v: unknown) => onConfigChange({ ...config, [k]: v });

  const stateColor = { upcoming: "#fef3c7", live: "#dcfce7", finished: "#f3f4f6" }[currentState];
  const stateText = { upcoming: "#92400e", live: "#15803d", finished: "#6b7280" }[currentState];

  return (
    <div style={{ minHeight: "100vh", background: "#f9fafb", fontFamily: "system-ui, -apple-system, sans-serif", color: "#111827" }}>
      <div style={{ background: "#fff", borderBottom: "1px solid #e5e7eb", padding: "12px 24px", display: "flex", alignItems: "center", gap: 12 }}>
        <Radio size={18} color="#6366f1" />
        <span style={{ fontWeight: 600, fontSize: 15 }}>Event Admin</span>
        <span style={{ marginLeft: "auto", fontSize: 12, fontWeight: 600, letterSpacing: "0.05em", padding: "2px 10px", borderRadius: 999, background: stateColor, color: stateText }}>
          {currentState.toUpperCase()}
        </span>
      </div>

      <div style={{ background: "#fff", borderBottom: "1px solid #e5e7eb", display: "flex", padding: "0 16px" }}>
        {(["status", "chat", "setup"] as AdminTab[]).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: "10px 16px", fontSize: 13, background: "none", border: "none",
            borderBottom: tab === t ? "2px solid #6366f1" : "2px solid transparent",
            color: tab === t ? "#6366f1" : "#6b7280", fontWeight: tab === t ? 600 : 400,
          }}>
            {t === "chat" ? `Chat${pending.length > 0 ? ` (${pending.length})` : ""}` : t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      <div style={{ padding: 24, maxWidth: 560, display: "flex", flexDirection: "column", gap: 20 }}>

        {tab === "status" && (
          <>
            <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, padding: 16 }}>
              <p style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Event Controls</p>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={onStartNow} style={{ flex: 1, padding: 8, background: "#6366f1", color: "#fff", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600 }}>
                  Start Now
                </button>
                <button onClick={onEndNow} style={{ flex: 1, padding: 8, background: "#ef4444", color: "#fff", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600 }}>
                  End Now
                </button>
              </div>
            </div>
            <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, padding: 16 }}>
              <p style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Timing</p>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div>
                  <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 4 }}>Start Time</label>
                  <input type="datetime-local" style={inp()}
                    value={isNaN(config.startTime.getTime()) ? "" : config.startTime.toISOString().slice(0, 16)}
                    onChange={e => { const d = new Date(e.target.value); if (!isNaN(d.getTime())) set("startTime", d); }} />
                </div>
                <div>
                  <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 4 }}>Duration (hours)</label>
                  <input type="number" style={inp()} min={0.1} step={0.5}
                    value={config.durationMs / 3_600_000}
                    onChange={e => set("durationMs", parseFloat(e.target.value) * 3_600_000)} />
                </div>
              </div>
            </div>
          </>
        )}

        {tab === "chat" && (
          <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, padding: 16 }}>
            <p style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Message Moderation</p>
            {messages.length === 0 && <p style={{ fontSize: 13, color: "#9ca3af" }}>No messages yet.</p>}
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {messages.map(m => {
                const leftColor = m.status === "approved" ? "#22c55e" : m.status === "rejected" ? "#ef4444" : "#f59e0b";
                return (
                  <div key={m.id} style={{ border: "1px solid #e5e7eb", borderRadius: 6, padding: "10px 12px", borderLeft: `3px solid ${leftColor}` }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                      <PixelAvatar username={m.username} size={20} />
                      <span style={{ fontSize: 12, fontWeight: 600 }}>{m.username}</span>
                      <span style={{ marginLeft: "auto", fontSize: 11, color: "#9ca3af", textTransform: "capitalize" }}>{m.status}</span>
                    </div>
                    <p style={{ fontSize: 13, color: "#374151", marginBottom: m.status === "pending" ? 8 : 0 }}>{m.text}</p>
                    {m.status === "pending" && (
                      <div style={{ display: "flex", gap: 6 }}>
                        <button onClick={() => onApprove(m.id)} style={{ fontSize: 12, padding: "4px 10px", background: "#22c55e", color: "#fff", border: "none", borderRadius: 4, fontWeight: 600 }}>
                          Approve
                        </button>
                        <button onClick={() => onReject(m.id)} style={{ fontSize: 12, padding: "4px 10px", background: "#ef4444", color: "#fff", border: "none", borderRadius: 4, fontWeight: 600 }}>
                          Reject
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {tab === "setup" && (
          <>
            <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, padding: 16 }}>
              <p style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Song Info</p>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div>
                  <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 4 }}>Song Title</label>
                  <input style={inp()} value={config.songTitle} onChange={e => set("songTitle", e.target.value)} />
                </div>
              </div>
            </div>
            <UploadCard
              label="Song File"
              hint="MP3, WAV, OGG, FLAC, M4A"
              accept="audio/*"
              currentUrl={config.audioUrl}
              onFile={url => set("audioUrl", url)}
              preview={url => (
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, padding: "6px 10px", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 4 }}>
                  <span style={{ fontSize: 18 }}>🎵</span>
                  <audio controls src={url} style={{ height: 28, flex: 1, minWidth: 0 }} />
                </div>
              )}
            />
            <UploadCard
              label="Artwork"
              hint="JPG, PNG, GIF, WEBP — shown on the upcoming page"
              accept="image/*"
              currentUrl={config.artworkUrl}
              onFile={url => set("artworkUrl", url)}
              preview={url => (
                <img src={url} alt="artwork preview"
                  style={{ width: 80, height: 80, objectFit: "cover", border: "1px solid #e5e7eb", borderRadius: 4, marginTop: 8 }} />
              )}
            />
            <UploadCard
              label="Artist Image (DVD bounce)"
              hint="Bounces across the screen. JPG, PNG, GIF, WEBP"
              accept="image/*"
              currentUrl={config.artistImage}
              onFile={url => set("artistImage", url)}
              preview={url => (
                <img src={url} alt="artist preview"
                  style={{ width: 64, height: 64, objectFit: "cover", border: "1px solid #e5e7eb", borderRadius: 4, marginTop: 8 }} />
              )}
            />
            <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, padding: 16 }}>
              <p style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Finished Page — Support</p>
              <p style={{ fontSize: 12, color: "#9ca3af", marginBottom: 12 }}>
                Section headings always show. Links only appear when filled in.
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div>
                  <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 4 }}>
                    "support me 🤑" → Buy Me a Coffee URL
                  </label>
                  <input style={inp()} placeholder="https://buymeacoffee.com/..."
                    value={config.links.coffee}
                    onChange={e => set("links", { ...config.links, coffee: e.target.value })} />
                </div>
                <div>
                  <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 4 }}>
                    "buy merch 😎" → Shop URL (Shopify, Big Cartel…)
                  </label>
                  <input style={inp()} placeholder="https://yourshop.com"
                    value={config.links.merch}
                    onChange={e => set("links", { ...config.links, merch: e.target.value })} />
                </div>
                <div>
                  <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 4 }}>
                    "pull up to next show:" → Event URL (Resident Advisor, Dice…)
                  </label>
                  <input style={inp()} placeholder="https://ra.co/events/..."
                    value={config.links.liveShow}
                    onChange={e => set("links", { ...config.links, liveShow: e.target.value })} />
                </div>
              </div>
            </div>
            <UploadCard
              label="Merch Image"
              hint="Shown on the finished page under 'buy merch'. JPG, PNG, GIF, WEBP"
              accept="image/*"
              currentUrl={config.merchImage}
              onFile={url => set("merchImage", url)}
              preview={url => (
                <img src={url} alt="merch preview"
                  style={{ width: 100, height: 100, objectFit: "cover", border: "1px solid #e5e7eb", borderRadius: 4, marginTop: 8 }} />
              )}
            />
          </>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════
// APP ROOT
// ══════════════════════════════════════════════════════════
export default function App() {
  const isAdmin = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("admin");

  const [config, setConfig] = useState<EventConfig>({
    songTitle: "Gravity",
    description: "one track. one night. then it's gone.",
    audioUrl: "",
    artworkUrl: "",
    artistImage: "",
    merchImage: "",
    startTime: new Date(Date.now() + 3 * 60 * 1000),
    durationMs: 12 * 60 * 60 * 1000,
    links: { coffee: "", merch: "", liveShow: "", spotify: "", instagram: "", newsletter: "" },
  });

  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const [devState, setDevState] = useState<EventState | null>(null);
  const state: EventState = devState ?? getEventState(config, now);

  const [messages, setMessages] = useState<ChatMessage[]>([]);

  const addMessage = useCallback((username: string, text: string) => {
    setMessages(prev => [...prev, {
      id: Math.random().toString(36).slice(2),
      username, text, status: "pending", ts: Date.now(),
    }]);
  }, []);

  const approveMsg = useCallback((id: string) =>
    setMessages(prev => prev.map(m => m.id === id ? { ...m, status: "approved" } : m)), []);

  const rejectMsg = useCallback((id: string) =>
    setMessages(prev => prev.map(m => m.id === id ? { ...m, status: "rejected" } : m)), []);

  const startNow = useCallback(() =>
    setConfig(c => ({ ...c, startTime: new Date(Date.now() - 1000) })), []);

  const endNow = useCallback(() =>
    setConfig(c => ({ ...c, startTime: new Date(Date.now() - c.durationMs - 1000) })), []);

  if (isAdmin) {
    return (
      <AdminPanel
        config={config}
        onConfigChange={setConfig}
        messages={messages}
        onApprove={approveMsg}
        onReject={rejectMsg}
        currentState={state}
        onStartNow={startNow}
        onEndNow={endNow}
      />
    );
  }

  return (
    <>
      <GlobalStyles />
      <CRTOverlay />
      {state !== "finished" && <DVDBounce imageUrl={config.artistImage} />}
      <DevSwitcher current={state} onSwitch={setDevState} />
      {state === "upcoming" && <UpcomingPage config={config} />}
      {state === "live"     && <LivePage config={config} messages={messages} onSendMessage={addMessage} />}
      {state === "finished" && <FinishedPage config={config} />}
    </>
  );
}
