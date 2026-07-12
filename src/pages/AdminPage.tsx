import { FormEvent, useEffect, useMemo, useState } from "react";
import { Radio } from "lucide-react";
import { dateTimeLocalToUtc, formatDateTimeLocal } from "@/lib/datetime";
import { useEventChat } from "@/hooks/useEventChat";
import { logout } from "@/services/authService";
import { deleteChatMessage, sendAdminMessage, setMessageStatus, updateMessageFlags } from "@/services/chatService";
import { createEvent, endEvent, getAdminEvents, startEvent, updateEvent } from "@/services/eventService";
import { getPublicImageUrl, getSignedAudioUrl, uploadArtistImage, uploadArtwork, uploadAudio, uploadMerchImage } from "@/services/storageService";
import type { ChatMessage } from "@/types/chat";
import type { MusicEvent, UpdateEventInput } from "@/types/event";
import FilePicker from "@/components/admin/FilePicker";
import EventStatusBadge from "@/components/public/EventStatusBadge";

type AdminTab = "event" | "chat";

type FormState = {
  title: string;
  artist_name: string;
  starts_at: string;
  ends_at: string;
  support_url: string;
  merch_url: string;
  event_url: string;
};

type PendingFiles = {
  artistImage: File | null;
  artwork: File | null;
  merchImage: File | null;
  audio: File | null;
};

const emptyForm: FormState = {
  title: "",
  artist_name: "",
  starts_at: "",
  ends_at: "",
  support_url: "",
  merch_url: "",
  event_url: "",
};

const emptyFiles: PendingFiles = {
  artistImage: null,
  artwork: null,
  merchImage: null,
  audio: null,
};

export default function AdminPage() {
  const [event, setEvent] = useState<MusicEvent | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [pendingFiles, setPendingFiles] = useState<PendingFiles>(emptyFiles);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [uploadStatus, setUploadStatus] = useState("");
  const [audioPreviewUrl, setAudioPreviewUrl] = useState("");
  const [audioPreviewLoading, setAudioPreviewLoading] = useState(false);
  const [audioPreviewError, setAudioPreviewError] = useState("");
  const [audioPreviewAttempt, setAudioPreviewAttempt] = useState(0);
  const [artistImageWarning, setArtistImageWarning] = useState("");
  const [activeTab, setActiveTab] = useState<AdminTab>("event");
  const chat = useEventChat(event?.id, "admin");
  const localArtistImageUrl = useObjectUrl(pendingFiles.artistImage);
  const localArtworkUrl = useObjectUrl(pendingFiles.artwork);
  const localMerchImageUrl = useObjectUrl(pendingFiles.merchImage);
  const localAudioUrl = useObjectUrl(pendingFiles.audio);

  useEffect(() => {
    getAdminEvents()
      .then(events => {
        const current = events[0] ?? null;
        setEvent(current);
        if (current) setForm(fromEvent(current));
      })
      .catch(err => setError(err instanceof Error ? err.message : "Unable to load events."))
      .finally(() => setLoading(false));
  }, []);

  const disabled = loading || busy;
  const hasRequiredMedia = Boolean(event?.audio_path || pendingFiles.audio) && Boolean(event?.artwork_path || event?.artist_image_path || pendingFiles.artwork || pendingFiles.artistImage);

  useEffect(() => {
    if (localAudioUrl) {
      setAudioPreviewUrl("");
      setAudioPreviewError("");
      setAudioPreviewLoading(false);
      return;
    }

    let active = true;
    setAudioPreviewUrl("");
    setAudioPreviewError("");

    if (!event?.audio_path) return;

    setAudioPreviewLoading(true);
    getSignedAudioUrl(event.audio_path, 3600)
      .then(url => {
        if (active) setAudioPreviewUrl(url);
      })
      .catch(err => {
        const message = err instanceof Error ? err.message : "Unable to load private audio preview.";
        console.error("Unable to create signed audio preview URL:", err);
        if (active) setAudioPreviewError(message);
      })
      .finally(() => {
        if (active) setAudioPreviewLoading(false);
      });

    return () => {
      active = false;
    };
  }, [event?.audio_path, localAudioUrl, audioPreviewAttempt]);

  useEffect(() => {
    if (!localArtistImageUrl) {
      setArtistImageWarning("");
      return;
    }

    let active = true;
    const image = new Image();
    image.onload = () => {
      if (!active || image.naturalHeight === 0) return;
      const ratio = image.naturalWidth / image.naturalHeight;
      setArtistImageWarning(Math.abs(ratio - 0.8) > 0.04 ? "This artist image is not 4:5. It will be cropped in the bouncing public preview." : "");
    };
    image.onerror = () => {
      if (active) setArtistImageWarning("Unable to inspect artist image dimensions.");
    };
    image.src = localArtistImageUrl;

    return () => {
      active = false;
    };
  }, [localArtistImageUrl]);

  const setField = (key: keyof FormState, value: string) => {
    setForm(current => ({ ...current, [key]: value }));
  };

  async function ensureEvent() {
    if (event) return event;
    const created = await createEvent({ title: form.title.trim() || "Untitled Event" });
    setEvent(created);
    return created;
  }

  async function uploadPendingFiles(baseEvent: MusicEvent) {
    const updates: UpdateEventInput = {};
    const nextFiles = { ...pendingFiles };

    if (pendingFiles.audio) {
      setUploadStatus("Uploading audio...");
      updates.audio_path = await uploadAudio(baseEvent.id, pendingFiles.audio);
      nextFiles.audio = null;
    }
    if (pendingFiles.artwork) {
      setUploadStatus("Uploading artwork...");
      updates.artwork_path = await uploadArtwork(baseEvent.id, pendingFiles.artwork);
      nextFiles.artwork = null;
    }
    if (pendingFiles.artistImage) {
      setUploadStatus("Uploading artist image...");
      updates.artist_image_path = await uploadArtistImage(baseEvent.id, pendingFiles.artistImage);
      nextFiles.artistImage = null;
    }
    if (pendingFiles.merchImage) {
      setUploadStatus("Uploading merch image...");
      updates.merch_image_path = await uploadMerchImage(baseEvent.id, pendingFiles.merchImage);
      nextFiles.merchImage = null;
    }

    setPendingFiles(nextFiles);
    setUploadStatus("");
    return updates;
  }

  function validateUrls() {
    for (const [label, value] of [["support URL", form.support_url], ["merch URL", form.merch_url], ["event URL", form.event_url]]) {
      if (!value) continue;
      try {
        const url = new URL(value);
        if (!["http:", "https:"].includes(url.protocol)) throw new Error();
      } catch {
        throw new Error(`Enter a valid ${label}.`);
      }
    }
  }

  function validateEventWindow() {
    if (!form.starts_at) throw new Error("Choose an event start date and time.");
    if (!form.ends_at) throw new Error("Choose an event end date and time.");

    const startsAt = new Date(form.starts_at).getTime();
    const endsAt = new Date(form.ends_at).getTime();

    if (Number.isNaN(startsAt)) throw new Error("Enter a valid event start date and time.");
    if (Number.isNaN(endsAt)) throw new Error("Enter a valid event end date and time.");
    if (endsAt <= startsAt) throw new Error("Event End Date and Time must be later than Event Start Date and Time.");
  }

  function toUpdateInput(extra?: UpdateEventInput): UpdateEventInput {
    const startsAt = dateTimeLocalToUtc(form.starts_at);
    const endsAt = dateTimeLocalToUtc(form.ends_at);
    return {
      title: form.title.trim() || "Untitled Event",
      artist_name: form.artist_name.trim() || null,
      starts_at: startsAt,
      ends_at: endsAt,
      support_url: form.support_url.trim() || null,
      merch_url: form.merch_url.trim() || null,
      event_url: form.event_url.trim() || null,
      ...extra,
    };
  }

  async function runAction(label: string, action: (baseEvent: MusicEvent, updates: UpdateEventInput) => Promise<MusicEvent>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      validateUrls();
      validateEventWindow();
      const baseEvent = await ensureEvent();
      const uploadUpdates = await uploadPendingFiles(baseEvent);
      const latest = toUpdateInput(uploadUpdates);
      const saved = await action(baseEvent, latest);
      setEvent(saved);
      setForm(fromEvent(saved));
      setMessage(label);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setUploadStatus("");
      setBusy(false);
    }
  }

  async function handleSaveDraft(eventArg?: FormEvent) {
    eventArg?.preventDefault();
    await runAction("Draft saved.", async (baseEvent, updates) => updateEvent(baseEvent.id, { ...updates, status: "draft" }));
  }

  async function handleStartEvent() {
    if (!hasRequiredMedia) {
      setError("Upload audio and artwork or an artist image before starting.");
      return;
    }
    await runAction(
      `Event started from ${formatAdminDateTime(form.starts_at)} to ${formatAdminDateTime(form.ends_at)}.`,
      async (baseEvent, updates) => startEvent(baseEvent.id, updates),
    );
  }

  async function handleEndNow() {
    if (!event) return;
    if (!window.confirm("End this event now?")) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const saved = await endEvent(event.id);
      setEvent(saved);
      setForm(fromEvent(saved));
      setMessage("Event ended.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to end event.");
    } finally {
      setBusy(false);
    }
  }

  const fileLabels = useMemo(() => ({
    audio: event?.audio_path ? "Audio uploaded" : "",
    artwork: event?.artwork_path ? "Artwork uploaded" : "",
    artistImage: event?.artist_image_path ? "Artist image uploaded" : "",
    merchImage: event?.merch_image_path ? "Merch image uploaded" : "",
  }), [event]);

  const mediaPreviews = useMemo(() => ({
    artwork: localArtworkUrl || getPublicImageUrl("artwork", event?.artwork_path),
    artistImage: localArtistImageUrl || getPublicImageUrl("artist-images", event?.artist_image_path),
    merchImage: localMerchImageUrl || getPublicImageUrl("merch-images", event?.merch_image_path),
    audio: localAudioUrl || audioPreviewUrl,
  }), [audioPreviewUrl, event?.artist_image_path, event?.artwork_path, event?.merch_image_path, localArtistImageUrl, localArtworkUrl, localAudioUrl, localMerchImageUrl]);

  if (loading) {
    return <main style={pageStyle}>Loading admin...</main>;
  }

  return (
    <main style={pageStyle}>
      <header style={{ background: "#fff", borderBottom: "1px solid #e5e7eb", padding: "12px 24px", display: "flex", alignItems: "center", gap: 12 }}>
        <Radio size={18} color="#6366f1" />
        <span style={{ fontWeight: 600, fontSize: 15 }}>Event Admin</span>
        <span style={{ marginLeft: "auto" }}>{event ? <EventStatusBadge status={event.status} /> : <EventStatusBadge status="draft" />}</span>
        <button onClick={() => logout()} style={secondaryButton}>Logout</button>
      </header>

      <div style={{ background: "#fff", borderBottom: "1px solid #e5e7eb", display: "flex", padding: "0 16px" }}>
        {(["event", "chat"] as AdminTab[]).map(tab => (
          <button key={tab} type="button" onClick={() => setActiveTab(tab)} style={tabButtonStyle(activeTab === tab)}>
            {tab === "event" ? "Event" : `Chat${chat.grouped.pending.length > 0 ? ` (${chat.grouped.pending.length})` : ""}`}
          </button>
        ))}
      </div>

      {activeTab === "event" ? (
        <form onSubmit={handleSaveDraft} style={{ padding: 24, maxWidth: 680, display: "flex", flexDirection: "column", gap: 20 }}>
          <Panel title="Event Controls">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
              <button disabled={disabled} type="submit" style={buttonStyle("#374151")}>Save Draft</button>
              <button disabled={disabled} type="button" onClick={handleStartEvent} style={buttonStyle("#6366f1")}>Start Event</button>
              <button disabled={disabled || !event} type="button" onClick={handleEndNow} style={buttonStyle("#ef4444")}>End Now</button>
            </div>
            {uploadStatus && <p style={noteStyle}>{uploadStatus}</p>}
            {message && <p style={{ ...noteStyle, color: "#15803d" }}>{message}</p>}
            {error && <p style={{ ...noteStyle, color: "#b91c1c" }}>{error}</p>}
          </Panel>

          <Panel title="Song Info">
            <Grid>
              <Field label="Event Title" value={form.title} onChange={value => setField("title", value)} />
              <Field label="Artist Name" value={form.artist_name} onChange={value => setField("artist_name", value)} />
              <Field label="Event Start Date and Time" type="datetime-local" value={form.starts_at} onChange={value => setField("starts_at", value)} />
              <Field label="Event End Date and Time" type="datetime-local" value={form.ends_at} onChange={value => setField("ends_at", value)} />
            </Grid>
          </Panel>

          <FilePicker
            label="Song File"
            hint="MP3, WAV, OGG, FLAC, M4A. Audio remains private and uses signed URLs."
            accept="audio/*"
            disabled={disabled}
            currentLabel={fileLabels.audio}
            pendingFile={pendingFiles.audio}
            previewType="audio"
            previewUrl={mediaPreviews.audio}
            previewLoading={audioPreviewLoading}
            previewError={audioPreviewError}
            onPreviewRetry={() => setAudioPreviewAttempt(attempt => attempt + 1)}
            onFile={file => setPendingFiles(current => ({ ...current, audio: file }))}
          />
          <FilePicker
            label="Artwork"
            hint="JPG, PNG, GIF, WEBP. Shown on the upcoming page."
            accept="image/*"
            disabled={disabled}
            currentLabel={fileLabels.artwork}
            pendingFile={pendingFiles.artwork}
            previewType="image"
            previewUrl={mediaPreviews.artwork}
            previewAlt="Artwork preview"
            onFile={file => setPendingFiles(current => ({ ...current, artwork: file }))}
          />
          <FilePicker
            label="Artist Image"
            hint="Recommended: 4:5 vertical, 1080 × 1350 px. JPG, PNG, GIF, WEBP. Used on the teaser page."
            accept="image/*"
            disabled={disabled}
            currentLabel={fileLabels.artistImage}
            pendingFile={pendingFiles.artistImage}
            previewType="image"
            previewUrl={mediaPreviews.artistImage}
            previewAlt="Artist image preview"
            previewAspectRatio="4 / 5"
            warning={artistImageWarning}
            onFile={file => setPendingFiles(current => ({ ...current, artistImage: file }))}
          />
          <FilePicker
            label="Merch Image"
            hint="JPG, PNG, GIF, WEBP. Used after the event finishes."
            accept="image/*"
            disabled={disabled}
            currentLabel={fileLabels.merchImage}
            pendingFile={pendingFiles.merchImage}
            previewType="image"
            previewUrl={mediaPreviews.merchImage}
            previewAlt="Merch image preview"
            onFile={file => setPendingFiles(current => ({ ...current, merchImage: file }))}
          />

          <Panel title="Support Links">
            <Grid>
              <Field label="Support URL" value={form.support_url} onChange={value => setField("support_url", value)} />
              <Field label="Merchandise URL" value={form.merch_url} onChange={value => setField("merch_url", value)} />
              <Field label="Event URL" value={form.event_url} onChange={value => setField("event_url", value)} />
            </Grid>
          </Panel>
        </form>
      ) : (
        <ChatModerationPanel
          event={event}
          ensureEvent={ensureEvent}
          chat={chat}
          busy={busy}
          setBusy={setBusy}
          setError={setError}
          setMessage={setMessage}
          error={error}
          message={message}
        />
      )}
    </main>
  );
}

function fromEvent(event: MusicEvent): FormState {
  return {
    title: event.title ?? "",
    artist_name: event.artist_name ?? "",
    starts_at: formatDateTimeLocal(event.starts_at),
    ends_at: formatDateTimeLocal(event.ends_at),
    support_url: event.support_url ?? "",
    merch_url: event.merch_url ?? "",
    event_url: event.event_url ?? "",
  };
}

function formatAdminDateTime(value: string) {
  if (!value) return "the selected time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "the selected time";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function useObjectUrl(file: File | null) {
  const [url, setUrl] = useState("");

  useEffect(() => {
    if (!file) {
      setUrl("");
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);

    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  return url;
}

function ChatModerationPanel({
  event,
  ensureEvent,
  chat,
  busy,
  setBusy,
  setError,
  setMessage,
  error,
  message,
}: {
  event: MusicEvent | null;
  ensureEvent: () => Promise<MusicEvent>;
  chat: ReturnType<typeof useEventChat>;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  setError: (error: string) => void;
  setMessage: (message: string) => void;
  error: string;
  message: string;
}) {
  const [body, setBody] = useState("");

  async function run(label: string, action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
      await chat.refetch();
      setMessage(label);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update chat.");
    } finally {
      setBusy(false);
    }
  }

  async function submitAdminMessage(submitEvent: FormEvent) {
    submitEvent.preventDefault();
    await run("Admin message published.", async () => {
      const baseEvent = event ?? await ensureEvent();
      await sendAdminMessage({ event_id: baseEvent.id, body });
      setBody("");
    });
  }

  return (
    <div style={{ padding: 24, maxWidth: 760, display: "flex", flexDirection: "column", gap: 20 }}>
      <Panel title="Composer">
        <form onSubmit={submitAdminMessage} style={{ display: "flex", gap: 8 }}>
          <input
            value={body}
            onChange={event => setBody(event.target.value)}
            maxLength={500}
            placeholder={event ? "Write an admin message..." : "Save or create an event to start chat..."}
            style={inputStyle}
          />
          <button disabled={busy || !body.trim()} type="submit" style={buttonStyle("#6366f1")}>Publish</button>
        </form>
        {chat.loading && <p style={noteStyle}>Loading chat...</p>}
        {chat.error && <p style={{ ...noteStyle, color: "#b91c1c" }}>{chat.error}</p>}
        {message && <p style={{ ...noteStyle, color: "#15803d" }}>{message}</p>}
        {error && <p style={{ ...noteStyle, color: "#b91c1c" }}>{error}</p>}
      </Panel>

      <ChatPreview messages={chat.grouped.approved} busy={busy} run={run} />

      <ChatSection title="Pending moderation queue" empty="No pending messages." messages={chat.grouped.pending}>
        {messageItem => (
          <>
            <SmallButton disabled={busy} onClick={() => run("Message approved.", () => setMessageStatus(messageItem.id, "approved").then(() => undefined))}>Approve</SmallButton>
            <SmallButton disabled={busy} color="#ef4444" onClick={() => run("Message rejected.", () => setMessageStatus(messageItem.id, "rejected").then(() => undefined))}>Reject</SmallButton>
            <SmallButton disabled={busy} color="#6b7280" onClick={() => run("Message deleted.", () => deleteChatMessage(messageItem.id))}>Delete</SmallButton>
          </>
        )}
      </ChatSection>

      <ChatSection title="Rejected queue" empty="No rejected messages." messages={chat.grouped.rejected}>
        {messageItem => (
          <>
            <SmallButton disabled={busy} onClick={() => run("Message restored.", () => setMessageStatus(messageItem.id, "approved").then(() => undefined))}>Restore</SmallButton>
            <SmallButton disabled={busy} color="#6b7280" onClick={() => run("Message deleted.", () => deleteChatMessage(messageItem.id))}>Delete</SmallButton>
          </>
        )}
      </ChatSection>
    </div>
  );
}

function ChatPreview({ messages, busy, run }: { messages: ChatMessage[]; busy: boolean; run: (label: string, action: () => Promise<void>) => Promise<void> }) {
  const sorted = useMemo(() => [...messages].sort((a, b) => {
    if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1;
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  }), [messages]);

  return (
    <Panel title={`LIVE CHAT PREVIEW (${sorted.length})`}>
      <div style={{ border: "1px solid #111827", background: "#050505", color: "#f9fafb", borderRadius: 6, padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
        {sorted.length === 0 && <p style={{ fontSize: 13, color: "#9ca3af" }}>No approved messages yet.</p>}
        {sorted.map(message => (
          <div key={message.id} style={{
            border: message.is_highlighted ? "1px solid #00ff41" : "1px solid rgba(255,255,255,0.12)",
            background: message.is_highlighted ? "rgba(0,255,65,0.12)" : "rgba(255,255,255,0.04)",
            borderRadius: 6,
            padding: "10px 12px",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 5 }}>
              <strong style={{ fontSize: 12, color: "#fff" }}>{message.display_name}</strong>
              <span style={{ fontSize: 11, color: "rgba(255,255,255,0.45)" }}>{formatChatTime(message.created_at)}</span>
              {message.is_admin && <span style={darkBadgeStyle}>Admin</span>}
              {message.is_pinned && <span style={darkBadgeStyle}>Pinned</span>}
              {message.is_liked && <span style={darkBadgeStyle}>Liked</span>}
            </div>
            <p style={{ fontSize: 13, color: "rgba(255,255,255,0.82)", overflowWrap: "anywhere" }}>{message.body}</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
              <SmallButton disabled={busy} onClick={() => run(message.is_pinned ? "Message unpinned." : "Message pinned.", () => updateMessageFlags(message.id, { is_pinned: !message.is_pinned }).then(() => undefined))}>{message.is_pinned ? "Unpin" : "Pin"}</SmallButton>
              <SmallButton disabled={busy} onClick={() => run(message.is_highlighted ? "Highlight removed." : "Message highlighted.", () => updateMessageFlags(message.id, { is_highlighted: !message.is_highlighted }).then(() => undefined))}>{message.is_highlighted ? "Remove Highlight" : "Highlight"}</SmallButton>
              <SmallButton disabled={busy} onClick={() => run(message.is_liked ? "Like removed." : "Message liked.", () => updateMessageFlags(message.id, { is_liked: !message.is_liked }).then(() => undefined))}>{message.is_liked ? "Unlike" : "Like"}</SmallButton>
              <SmallButton disabled={busy} color="#6b7280" onClick={() => run("Message deleted.", () => deleteChatMessage(message.id))}>Delete</SmallButton>
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function ChatSection({ title, empty, messages, children }: { title: string; empty: string; messages: ChatMessage[]; children: (message: ChatMessage) => React.ReactNode }) {
  return (
    <Panel title={`${title} (${messages.length})`}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {messages.length === 0 && <p style={{ fontSize: 13, color: "#9ca3af" }}>{empty}</p>}
        {messages.map(message => (
          <div key={message.id} style={chatMessageStyle(message)}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <strong style={{ fontSize: 12 }}>{message.display_name}</strong>
              {message.is_admin && <span style={badgeStyle}>Admin</span>}
              {message.is_pinned && <span style={badgeStyle}>Pinned</span>}
              {message.is_liked && <span style={badgeStyle}>Liked</span>}
            </div>
            <p style={{ fontSize: 13, color: "#374151", overflowWrap: "anywhere" }}>{message.body}</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
              {children(message)}
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function SmallButton({ children, onClick, disabled, color = "#6366f1" }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; color?: string }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} style={{ fontSize: 12, padding: "4px 9px", border: "none", borderRadius: 4, background: color, color: "#fff", fontWeight: 600 }}>
      {children}
    </button>
  );
}

function formatChatTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, padding: 16 }}>
      <p style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>{title}</p>
      {children}
    </section>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>{children}</div>;
}

function Field({ label, value, onChange, type = "text" }: { label: string; value: string; onChange: (value: string) => void; type?: string }) {
  return (
    <label style={{ display: "block" }}>
      <span style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 4 }}>{label}</span>
      <input type={type} value={value} min={type === "number" ? 0.1 : undefined} step={type === "number" ? 0.5 : undefined} onChange={event => onChange(event.target.value)} style={inputStyle} />
    </label>
  );
}

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  background: "#f9fafb",
  fontFamily: "system-ui, -apple-system, sans-serif",
  color: "#111827",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "6px 10px",
  border: "1px solid #d1d5db",
  borderRadius: 4,
  fontSize: 13,
  background: "#fff",
  color: "#111",
};

const noteStyle: React.CSSProperties = {
  marginTop: 10,
  fontSize: 13,
  color: "#6b7280",
};

const secondaryButton: React.CSSProperties = {
  padding: "6px 10px",
  background: "#fff",
  color: "#374151",
  border: "1px solid #d1d5db",
  borderRadius: 6,
  fontWeight: 600,
};

const badgeStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  textTransform: "uppercase",
  background: "#eef2ff",
  color: "#4338ca",
  borderRadius: 999,
  padding: "1px 6px",
};

const darkBadgeStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  textTransform: "uppercase",
  background: "rgba(0,255,65,0.14)",
  color: "#00ff41",
  border: "1px solid rgba(0,255,65,0.42)",
  borderRadius: 999,
  padding: "1px 6px",
};

function tabButtonStyle(active: boolean): React.CSSProperties {
  return {
    padding: "10px 16px",
    fontSize: 13,
    background: "none",
    border: "none",
    borderBottom: active ? "2px solid #6366f1" : "2px solid transparent",
    color: active ? "#6366f1" : "#6b7280",
    fontWeight: active ? 600 : 400,
  };
}

function chatMessageStyle(message: ChatMessage): React.CSSProperties {
  return {
    border: "1px solid #e5e7eb",
    borderLeft: message.is_highlighted ? "4px solid #6366f1" : "3px solid #d1d5db",
    borderRadius: 6,
    padding: "10px 12px",
    background: message.is_highlighted ? "#eef2ff" : "#fff",
  };
}

function buttonStyle(background: string): React.CSSProperties {
  return {
    padding: 8,
    background,
    color: "#fff",
    border: "none",
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 700,
    opacity: 1,
  };
}
