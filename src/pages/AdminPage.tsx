import { FormEvent, useEffect, useMemo, useState } from "react";
import { Radio } from "lucide-react";
import { logout } from "@/services/authService";
import { createEvent, endEvent, getAdminEvents, scheduleEvent, startEvent, updateEvent } from "@/services/eventService";
import { uploadArtistImage, uploadArtwork, uploadAudio, uploadMerchImage } from "@/services/storageService";
import type { MusicEvent, UpdateEventInput } from "@/types/event";
import FilePicker from "@/components/admin/FilePicker";
import EventStatusBadge from "@/components/public/EventStatusBadge";

type FormState = {
  title: string;
  artist_name: string;
  starts_at: string;
  duration_hours: string;
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
  duration_hours: "12",
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

  function toUpdateInput(extra?: UpdateEventInput): UpdateEventInput {
    const startsAt = form.starts_at ? new Date(form.starts_at).toISOString() : null;
    const duration = Number.parseFloat(form.duration_hours);
    return {
      title: form.title.trim() || "Untitled Event",
      artist_name: form.artist_name.trim() || null,
      starts_at: startsAt,
      duration_hours: Number.isFinite(duration) ? duration : null,
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

  async function handleSchedule() {
    if (!hasRequiredMedia) {
      setError("Upload audio and artwork or an artist image before scheduling.");
      return;
    }
    await runAction("Event scheduled.", async (baseEvent, updates) => scheduleEvent(baseEvent.id, updates));
  }

  async function handleStartNow() {
    if (!hasRequiredMedia) {
      setError("Upload audio and artwork or an artist image before starting.");
      return;
    }
    await runAction("Event started.", async (baseEvent, updates) => startEvent(baseEvent.id, updates));
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

      <form onSubmit={handleSaveDraft} style={{ padding: 24, maxWidth: 680, display: "flex", flexDirection: "column", gap: 20 }}>
        <Panel title="Event Controls">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 8 }}>
            <button disabled={disabled} type="submit" style={buttonStyle("#374151")}>Save Draft</button>
            <button disabled={disabled} type="button" onClick={handleSchedule} style={buttonStyle("#0f766e")}>Schedule Event</button>
            <button disabled={disabled} type="button" onClick={handleStartNow} style={buttonStyle("#6366f1")}>Start Now</button>
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
            <Field label="Start Date and Time" type="datetime-local" value={form.starts_at} onChange={value => setField("starts_at", value)} />
            <Field label="Duration (hours)" type="number" value={form.duration_hours} onChange={value => setField("duration_hours", value)} />
          </Grid>
        </Panel>

        <FilePicker label="Song File" hint="MP3, WAV, OGG, FLAC, M4A. Audio remains private and uses signed URLs." accept="audio/*" disabled={disabled} currentLabel={fileLabels.audio} pendingFile={pendingFiles.audio} onFile={file => setPendingFiles(current => ({ ...current, audio: file }))} />
        <FilePicker label="Artwork" hint="JPG, PNG, GIF, WEBP. Shown on the upcoming page." accept="image/*" disabled={disabled} currentLabel={fileLabels.artwork} pendingFile={pendingFiles.artwork} onFile={file => setPendingFiles(current => ({ ...current, artwork: file }))} />
        <FilePicker label="Artist Image" hint="JPG, PNG, GIF, WEBP. Used on the teaser page." accept="image/*" disabled={disabled} currentLabel={fileLabels.artistImage} pendingFile={pendingFiles.artistImage} onFile={file => setPendingFiles(current => ({ ...current, artistImage: file }))} />
        <FilePicker label="Merch Image" hint="JPG, PNG, GIF, WEBP. Used after the event finishes." accept="image/*" disabled={disabled} currentLabel={fileLabels.merchImage} pendingFile={pendingFiles.merchImage} onFile={file => setPendingFiles(current => ({ ...current, merchImage: file }))} />

        <Panel title="Support Links">
          <Grid>
            <Field label="Support URL" value={form.support_url} onChange={value => setField("support_url", value)} />
            <Field label="Merchandise URL" value={form.merch_url} onChange={value => setField("merch_url", value)} />
            <Field label="Event URL" value={form.event_url} onChange={value => setField("event_url", value)} />
          </Grid>
        </Panel>
      </form>
    </main>
  );
}

function fromEvent(event: MusicEvent): FormState {
  return {
    title: event.title ?? "",
    artist_name: event.artist_name ?? "",
    starts_at: event.starts_at ? event.starts_at.slice(0, 16) : "",
    duration_hours: event.duration_hours ? String(event.duration_hours) : "12",
    support_url: event.support_url ?? "",
    merch_url: event.merch_url ?? "",
    event_url: event.event_url ?? "",
  };
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
