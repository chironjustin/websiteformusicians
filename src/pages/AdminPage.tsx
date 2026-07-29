import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Radio, Trash2 } from "lucide-react";
import { dateTimeLocalToUtc, formatDateTimeLocal } from "@/lib/datetime";
import { EVENT_NOT_READY_MESSAGE, EventReadinessError, validateEventReadiness, type EventReadinessFieldErrors, type EventReadinessInput } from "@/lib/eventReadiness";
import { useEventChat } from "@/hooks/useEventChat";
import { logout } from "@/services/authService";
import { deleteChatMessage, getAdminChatMessages, sendAdminMessage, setMessageHighlighted, setMessagePinned, setMessageStatus, updateMessageFlags } from "@/services/chatService";
import { createEvent, deleteArchivedEvent, endEvent, getAdminEvents, setEventChatAutoPublishSettings, startEvent, updateEvent } from "@/services/eventService";
import { assertStoragePathBelongsToEvent, getPublicImageUrl, getSignedAudioUrl, uploadArtistImage, uploadArtwork, uploadAudio, uploadMerchImage, verifyStorageObjectExists } from "@/services/storageService";
import type { ChatMessage } from "@/types/chat";
import type { MusicEvent, UpdateEventInput } from "@/types/event";
import FilePicker from "@/components/admin/FilePicker";
import EventStatusBadge from "@/components/public/EventStatusBadge";

type AdminTab = "event" | "chat" | "archive";

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

type UploadedMediaResult = {
  updates: UpdateEventInput;
  uploadedKeys: Array<keyof PendingFiles>;
};

const MEDIA_PATH_FIELDS = ["audio_path", "artwork_path", "artist_image_path", "merch_image_path"] as const;

const MEDIA_FIELD_TO_BUCKET = {
  audio_path: "audio",
  artwork_path: "artwork",
  artist_image_path: "artist-images",
  merch_image_path: "merch-images",
} as const;

type ChatCounts = {
  total: number;
  approved: number;
  pending: number;
  queued: number;
  rejected: number;
  pinned: number;
  highlighted: number;
  admin: number;
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
  const [events, setEvents] = useState<MusicEvent[]>([]);
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
  const [fieldErrors, setFieldErrors] = useState<EventReadinessFieldErrors>({});
  const [activeTab, setActiveTab] = useState<AdminTab>("event");
  const mutationInFlight = useRef(false);
  const mutationIdRef = useRef(0);
  const currentChatEvent = event && isActiveChatEvent(event) ? event : null;
  const currentEventId = currentChatEvent?.id ?? null;
  const chat = useEventChat(currentEventId, "admin");
  const localArtistImageUrl = useObjectUrl(pendingFiles.artistImage);
  const localArtworkUrl = useObjectUrl(pendingFiles.artwork);
  const localMerchImageUrl = useObjectUrl(pendingFiles.merchImage);
  const localAudioUrl = useObjectUrl(pendingFiles.audio);

  useEffect(() => {
    getAdminEvents()
      .then(loadedEvents => {
        setEvents(loadedEvents);
        const current = loadedEvents.find(item => !isArchivedEvent(item)) ?? null;
        setEvent(current);
        if (current) setForm(fromEvent(current));
      })
      .catch(err => setError(err instanceof Error ? err.message : "Unable to load events."))
      .finally(() => setLoading(false));
  }, []);

  const disabled = loading || busy;
  const archivedEvents = useMemo(() => events.filter(isArchivedEvent).sort(compareArchivedEvents), [events]);

  function syncSavedEvent(saved: MusicEvent) {
    setEvents(current => upsertEvent(current, saved));
    if (isArchivedEvent(saved)) {
      setEvent(null);
      setForm(emptyForm);
      return;
    }
    setEvent(saved);
    setForm(fromEvent(saved));
  }

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
    setFieldErrors(current => {
      const next = { ...current };
      if (key === "artist_name") delete next.artistName;
      if (key === "starts_at") delete next.startsAt;
      if (key === "ends_at") delete next.endsAt;
      if (key === "merch_url") delete next.merchUrl;
      return next;
    });
    setForm(current => ({ ...current, [key]: value }));
  };

  async function ensureEvent() {
    if (event) return event;
    const created = await createEvent({ title: form.title.trim() || "Untitled Event" });
    syncSavedEvent(created);
    return created;
  }

  function logAdminMutation(mutationId: number, action: string, details: Record<string, unknown>) {
    console.info("[admin-event-mutation]", {
      mutationId,
      action,
      ...details,
    });
  }

  function pendingFileNames() {
    return {
      audio: pendingFiles.audio?.name ?? null,
      artwork: pendingFiles.artwork?.name ?? null,
      artistImage: pendingFiles.artistImage?.name ?? null,
      merchImage: pendingFiles.merchImage?.name ?? null,
    };
  }

  async function uploadPendingFiles(baseEvent: MusicEvent, mutationId: number): Promise<UploadedMediaResult> {
    const updates: UpdateEventInput = {};
    const uploadedKeys: Array<keyof PendingFiles> = [];

    if (pendingFiles.audio) {
      setUploadStatus("Uploading audio...");
      updates.audio_path = await uploadAudio(baseEvent.id, pendingFiles.audio);
      assertStoragePathBelongsToEvent("audio", updates.audio_path, baseEvent.id);
      uploadedKeys.push("audio");
    }
    if (pendingFiles.artwork) {
      setUploadStatus("Uploading artwork...");
      updates.artwork_path = await uploadArtwork(baseEvent.id, pendingFiles.artwork);
      assertStoragePathBelongsToEvent("artwork", updates.artwork_path, baseEvent.id);
      uploadedKeys.push("artwork");
    }
    if (pendingFiles.artistImage) {
      setUploadStatus("Uploading artist image...");
      updates.artist_image_path = await uploadArtistImage(baseEvent.id, pendingFiles.artistImage);
      assertStoragePathBelongsToEvent("artist-images", updates.artist_image_path, baseEvent.id);
      uploadedKeys.push("artistImage");
    }
    if (pendingFiles.merchImage) {
      setUploadStatus("Uploading merch image...");
      updates.merch_image_path = await uploadMerchImage(baseEvent.id, pendingFiles.merchImage);
      assertStoragePathBelongsToEvent("merch-images", updates.merch_image_path, baseEvent.id);
      uploadedKeys.push("merchImage");
    }

    logAdminMutation(mutationId, "upload-complete", {
      eventId: baseEvent.id,
      uploadedPaths: Object.fromEntries(MEDIA_PATH_FIELDS.filter(field => updates[field]).map(field => [field, updates[field]])),
    });
    setUploadStatus("");
    return { updates, uploadedKeys };
  }

  function validateUrl(label: string, value: string, options?: { httpsOnly?: boolean }) {
    if (!value.trim()) return;
    try {
      const url = new URL(value.trim());
      if (options?.httpsOnly) {
        if (url.protocol !== "https:") throw new Error();
      } else if (!["http:", "https:"].includes(url.protocol)) {
        throw new Error();
      }
    } catch {
      throw new Error(options?.httpsOnly ? `Enter a valid HTTPS ${label}.` : `Enter a valid ${label}.`);
    }
  }

  function validateUrls() {
    for (const [label, value] of [["support URL", form.support_url], ["event URL", form.event_url]]) {
      validateUrl(label, value);
    }
    validateUrl("merch link", form.merch_url, { httpsOnly: true });
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

  function getStartReadinessCandidate(): EventReadinessInput {
    return {
      artist_name: form.artist_name,
      starts_at: dateTimeLocalToUtc(form.starts_at),
      ends_at: dateTimeLocalToUtc(form.ends_at),
      audio_path: event?.audio_path || (pendingFiles.audio ? "pending-audio-upload" : null),
      artist_image_path: event?.artist_image_path || (pendingFiles.artistImage ? "pending-artist-image-upload" : null),
      merch_image_path: event?.merch_image_path || (pendingFiles.merchImage ? "pending-merch-image-upload" : null),
      merch_url: form.merch_url,
    };
  }

  function validateStartReadinessForUi() {
    const result = validateEventReadiness(getStartReadinessCandidate());
    setFieldErrors(result.fieldErrors);
    if (!result.ready) {
      setError(EVENT_NOT_READY_MESSAGE);
      return false;
    }
    return true;
  }

  function handleReadinessError(error: EventReadinessError) {
    setFieldErrors(error.fieldErrors);
    setError(error.message);
  }

  function verifyReturnedMediaPaths(expectedEventId: string, saved: MusicEvent, uploadedUpdates: UpdateEventInput) {
    if (saved.id !== expectedEventId) {
      throw new Error(`Saved event ID ${saved.id} did not match expected event ${expectedEventId}.`);
    }

    for (const field of MEDIA_PATH_FIELDS) {
      const expectedPath = uploadedUpdates[field];
      if (!expectedPath) continue;
      if (saved[field] !== expectedPath) {
        throw new Error(`Saved ${field} did not match the uploaded file path. Please save again before starting.`);
      }
      assertStoragePathBelongsToEvent(MEDIA_FIELD_TO_BUCKET[field], saved[field], expectedEventId);
    }
  }

  function clearConfirmedPendingFiles(uploadedKeys: Array<keyof PendingFiles>) {
    if (uploadedKeys.length === 0) return;
    setPendingFiles(current => ({
      ...current,
      ...Object.fromEntries(uploadedKeys.map(key => [key, null])),
    }));
  }

  async function verifyRequiredMediaBeforePublish(saved: MusicEvent) {
    if (!saved.audio_path) {
      throw new Error("Upload audio before starting.");
    }

    assertStoragePathBelongsToEvent("audio", saved.audio_path, saved.id);
    const audioExists = await verifyStorageObjectExists("audio", saved.audio_path);
    if (!audioExists) {
      throw new Error("Uploaded audio could not be verified. Please upload it again.");
    }

    if (!saved.artist_image_path) {
      throw new Error("Uploaded artist image could not be verified. Please upload it again.");
    }

    if (saved.artwork_path) {
      assertStoragePathBelongsToEvent("artwork", saved.artwork_path, saved.id);
      const artworkExists = await verifyStorageObjectExists("artwork", saved.artwork_path);
      if (!artworkExists) throw new Error("Uploaded artwork could not be verified. Please upload it again.");
    }

    assertStoragePathBelongsToEvent("artist-images", saved.artist_image_path, saved.id);
    const artistImageExists = await verifyStorageObjectExists("artist-images", saved.artist_image_path);
    if (!artistImageExists) throw new Error("Uploaded artist image could not be verified. Please upload it again.");

    if (saved.merch_image_path) {
      assertStoragePathBelongsToEvent("merch-images", saved.merch_image_path, saved.id);
      const merchImageExists = await verifyStorageObjectExists("merch-images", saved.merch_image_path);
      if (!merchImageExists) throw new Error("Uploaded merch image could not be verified. Please upload it again.");
    }
  }

  async function runAction(label: string, action: (baseEvent: MusicEvent, updates: UpdateEventInput, mutationId: number) => Promise<MusicEvent>) {
    if (mutationInFlight.current) {
      setError("Another event update is still saving. Please wait.");
      return;
    }
    const mutationId = mutationIdRef.current + 1;
    mutationIdRef.current = mutationId;
    mutationInFlight.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      logAdminMutation(mutationId, "start", {
        pendingFiles: pendingFileNames(),
        currentEventId: event?.id ?? null,
      });
      validateUrls();
      const baseEvent = await ensureEvent();
      logAdminMutation(mutationId, "event-ready", { eventId: baseEvent.id });
      const { updates: uploadUpdates, uploadedKeys } = await uploadPendingFiles(baseEvent, mutationId);
      const latest = toUpdateInput(uploadUpdates);
      logAdminMutation(mutationId, "update-payload-ready", {
        eventId: baseEvent.id,
        mediaKeys: MEDIA_PATH_FIELDS.filter(field => latest[field]),
      });
      const saved = await action(baseEvent, latest, mutationId);
      verifyReturnedMediaPaths(baseEvent.id, saved, uploadUpdates);
      logAdminMutation(mutationId, "saved-row-verified", {
        eventId: saved.id,
        returnedPaths: Object.fromEntries(MEDIA_PATH_FIELDS.map(field => [field, saved[field]])),
      });
      if (mutationId !== mutationIdRef.current) {
        throw new Error("A newer event update finished first. Please refresh and try again.");
      }
      syncSavedEvent(saved);
      clearConfirmedPendingFiles(uploadedKeys);
      setMessage(label);
    } catch (err) {
      if (err instanceof EventReadinessError) {
        handleReadinessError(err);
      } else {
        setError(err instanceof Error ? err.message : "Something went wrong.");
      }
    } finally {
      setUploadStatus("");
      setBusy(false);
      mutationInFlight.current = false;
    }
  }

  async function handleSaveDraft(eventArg?: FormEvent) {
    eventArg?.preventDefault();
    setFieldErrors({});
    await runAction("Draft saved.", async (baseEvent, updates) => updateEvent(baseEvent.id, { ...updates, status: "draft" }));
  }

  async function handleStartEvent() {
    setError("");
    setMessage("");
    if (!validateStartReadinessForUi()) {
      return;
    }
    await runAction(
      `Event started from ${formatAdminDateTime(form.starts_at)} to ${formatAdminDateTime(form.ends_at)}.`,
      async (baseEvent, updates, mutationId) => {
        logAdminMutation(mutationId, "persist-before-start", {
          eventId: baseEvent.id,
          mediaKeys: MEDIA_PATH_FIELDS.filter(field => updates[field]),
        });
        const savedDraft = await updateEvent(baseEvent.id, updates);
        verifyReturnedMediaPaths(baseEvent.id, savedDraft, updates);
        const readiness = validateEventReadiness(savedDraft);
        setFieldErrors(readiness.fieldErrors);
        if (!readiness.ready) throw new EventReadinessError(readiness.fieldErrors);
        logAdminMutation(mutationId, "verify-storage-before-start", {
          eventId: savedDraft.id,
          audioPath: savedDraft.audio_path,
          artworkPath: savedDraft.artwork_path,
          artistImagePath: savedDraft.artist_image_path,
          merchImagePath: savedDraft.merch_image_path,
        });
        await verifyRequiredMediaBeforePublish(savedDraft);
        const started = await startEvent(savedDraft.id);
        await verifyRequiredMediaBeforePublish(started);
        logAdminMutation(mutationId, "status-update-complete", {
          eventId: started.id,
          status: started.status,
          audioPath: started.audio_path,
        });
        return started;
      },
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
      syncSavedEvent(saved);
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
        {(["event", "chat", "archive"] as AdminTab[]).map(tab => (
          <button key={tab} type="button" onClick={() => setActiveTab(tab)} style={tabButtonStyle(activeTab === tab)}>
            {tab === "event" && "Event"}
            {tab === "chat" && `Chat${chat.grouped.pending.length + chat.grouped.queued.length > 0 ? ` (${chat.grouped.pending.length + chat.grouped.queued.length})` : ""}`}
            {tab === "archive" && `Archived Events${archivedEvents.length > 0 ? ` (${archivedEvents.length})` : ""}`}
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
              <Field label="Artist Name" requiredNote="Required to start the event." error={fieldErrors.artistName} value={form.artist_name} onChange={value => setField("artist_name", value)} />
              <Field label="Event Start Date and Time" requiredNote="Required to start the event." error={fieldErrors.startsAt} type="datetime-local" value={form.starts_at} onChange={value => setField("starts_at", value)} />
              <Field label="Event End Date and Time" requiredNote="Required to start the event." error={fieldErrors.endsAt} type="datetime-local" value={form.ends_at} onChange={value => setField("ends_at", value)} />
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
            requiredNote="Required to start the event."
            error={fieldErrors.song}
            onFile={file => {
              setFieldErrors(current => ({ ...current, song: undefined }));
              setPendingFiles(current => ({ ...current, audio: file }));
            }}
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
            requiredNote="Required to start the event."
            error={fieldErrors.artistImage}
            onFile={file => {
              setFieldErrors(current => ({ ...current, artistImage: undefined }));
              setPendingFiles(current => ({ ...current, artistImage: file }));
            }}
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
            error={fieldErrors.merchImage}
            onFile={file => {
              setFieldErrors(current => ({ ...current, merchImage: undefined, merchUrl: undefined }));
              setPendingFiles(current => ({ ...current, merchImage: file }));
            }}
          />

          <Panel title="Support Links">
            <Grid>
              <Field label="Support URL" value={form.support_url} onChange={value => setField("support_url", value)} />
              <Field label="Merchandise URL" error={fieldErrors.merchUrl} value={form.merch_url} onChange={value => setField("merch_url", value)} />
              <Field label="Event URL" value={form.event_url} onChange={value => setField("event_url", value)} />
            </Grid>
          </Panel>
        </form>
      ) : activeTab === "chat" ? (
        <ChatModerationPanel
          event={currentChatEvent}
          chat={chat}
          busy={busy}
          setBusy={setBusy}
          setError={setError}
          setMessage={setMessage}
          error={error}
          message={message}
          onEventUpdated={saved => {
            setEvent(saved);
            setEvents(current => upsertEvent(current, saved));
          }}
        />
      ) : (
        <ArchivedEventsPanel
          events={archivedEvents}
          onDeleted={eventId => {
            setEvents(current => current.filter(item => item.id !== eventId));
            if (event?.id === eventId) {
              setEvent(null);
              setForm(emptyForm);
            }
          }}
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
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function isArchivedEvent(event: MusicEvent) {
  if (event.status === "finished") return true;
  if (!event.ends_at) return false;
  const endsAt = new Date(event.ends_at).getTime();
  return !Number.isNaN(endsAt) && endsAt <= Date.now();
}

function isActiveChatEvent(event: MusicEvent) {
  return !isArchivedEvent(event) && event.status !== "draft";
}

function compareArchivedEvents(a: MusicEvent, b: MusicEvent) {
  return archivedSortTime(b) - archivedSortTime(a);
}

function archivedSortTime(event: MusicEvent) {
  const value = event.ends_at || event.starts_at || event.updated_at || event.created_at;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function upsertEvent(events: MusicEvent[], saved: MusicEvent) {
  const exists = events.some(event => event.id === saved.id);
  const nextEvents = exists
    ? events.map(event => event.id === saved.id ? saved : event)
    : [saved, ...events];
  return [...nextEvents].sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
}

function countMessages(messages: ChatMessage[] = []): ChatCounts {
  return messages.reduce<ChatCounts>((counts, message) => ({
    total: counts.total + 1,
    approved: counts.approved + (message.status === "approved" ? 1 : 0),
    pending: counts.pending + (message.status === "pending" ? 1 : 0),
    queued: counts.queued + (message.status === "queued" ? 1 : 0),
    rejected: counts.rejected + (message.status === "rejected" ? 1 : 0),
    pinned: counts.pinned + (message.is_pinned ? 1 : 0),
    highlighted: counts.highlighted + (message.is_highlighted ? 1 : 0),
    admin: counts.admin + (message.is_admin ? 1 : 0),
  }), {
    total: 0,
    approved: 0,
    pending: 0,
    queued: 0,
    rejected: 0,
    pinned: 0,
    highlighted: 0,
    admin: 0,
  });
}

function formatQueuedAge(messages: ChatMessage[]) {
  const queuedTimes = messages
    .map(message => message.queued_at ? new Date(message.queued_at).getTime() : 0)
    .filter(time => time > 0);
  if (queuedTimes.length === 0) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - Math.min(...queuedTimes)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function formatDelay(milliseconds: number | null | undefined) {
  if (!milliseconds || milliseconds <= 0) return "";
  if (milliseconds < 1000) return `${milliseconds}ms`;
  return `${(milliseconds / 1000).toFixed(milliseconds % 1000 === 0 ? 0 : 1)}s`;
}

function formatRelativeTime(value: string | null | undefined) {
  if (!value) return "";
  const deltaSeconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const absSeconds = Math.abs(deltaSeconds);
  const suffix = deltaSeconds >= 0 ? "from now" : "ago";
  if (absSeconds < 60) return `${absSeconds}s ${suffix}`;
  return `${Math.floor(absSeconds / 60)}m ${absSeconds % 60}s ${suffix}`;
}

function queuePaceLabel(band: string | null | undefined) {
  switch (band) {
    case "0-30":
      return "about 1 every 3s";
    case "31-100":
      return "about 1 every 2s";
    case "101-200":
      return "about 1/s";
    case "over-200":
      return "fast, capped";
    case "empty":
      return "waiting";
    default:
      return "not calculated";
  }
}

function getTrustedEventMessages(event: MusicEvent, messages: ChatMessage[] = []) {
  return messages.filter(message => message.event_id === event.id);
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

function ArchivedEventsPanel({ events, onDeleted }: { events: MusicEvent[]; onDeleted: (eventId: string) => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(events[0]?.id ?? null);
  const [messagesByEvent, setMessagesByEvent] = useState<Record<string, ChatMessage[]>>({});
  const [loading, setLoading] = useState(false);
  const [deletingId, setDeletingId] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<MusicEvent | null>(null);
  const [deleteStep, setDeleteStep] = useState<1 | 2>(1);
  const [deletePhrase, setDeletePhrase] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const eventKey = useMemo(() => events.map(event => event.id).join("|"), [events]);

  useEffect(() => {
    if (!events.some(event => event.id === selectedId)) {
      setSelectedId(events[0]?.id ?? null);
    }
  }, [events, selectedId]);

  useEffect(() => {
    if (events.length === 0) {
      setMessagesByEvent({});
      setError("");
      return;
    }

    let active = true;
    setLoading(true);
    setError("");
    Promise.all(events.map(async event => {
        const messages = await getAdminChatMessages(event.id);
        return [event.id, messages] as const;
      }))
      .then(entries => {
        if (!active) return;
        setMessagesByEvent(Object.fromEntries(entries));
      })
      .catch(err => {
        if (active) setError(err instanceof Error ? err.message : "Unable to load archived messages.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [eventKey, events]);

  const selectedEvent = events.find(event => event.id === selectedId) ?? null;
  const selectedMessages = selectedEvent ? getTrustedEventMessages(selectedEvent, messagesByEvent[selectedEvent.id] ?? []) : [];
  const selectedCounts = countMessages(selectedMessages);

  function openDeleteDialog(event: MusicEvent) {
    setDeleteTarget(event);
    setDeleteStep(1);
    setDeletePhrase("");
    setError("");
    setNotice("");
  }

  function closeDeleteDialog() {
    if (deletingId) return;
    setDeleteTarget(null);
    setDeleteStep(1);
    setDeletePhrase("");
  }

  async function permanentlyDeleteArchivedEvent() {
    if (!deleteTarget || deletePhrase !== "DELETE") return;
    setDeletingId(deleteTarget.id);
    setError("");
    setNotice("");
    try {
      const result = await deleteArchivedEvent(deleteTarget.id);
      const storageIssueCount = result.storageFailures.length
        + result.invalidStorageRefs.length
        + result.notFoundBeforeDelete.length
        + result.stillPresentStorage.length;
      setMessagesByEvent(current => {
        const next = { ...current };
        delete next[deleteTarget.id];
        return next;
      });
      if (selectedId === deleteTarget.id) {
        const nextEvent = events.find(event => event.id !== deleteTarget.id) ?? null;
        setSelectedId(nextEvent?.id ?? null);
      }
      onDeleted(deleteTarget.id);
      setDeleteTarget(null);
      setDeleteStep(1);
      setDeletePhrase("");
      setNotice(storageIssueCount > 0
        ? `Archived event deleted, but ${storageIssueCount} storage cleanup issue${storageIssueCount === 1 ? "" : "s"} need review. Check deletion audit for exact bucket/path details.`
        : "Archived event permanently deleted.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to permanently delete archived event.");
    } finally {
      setDeletingId("");
    }
  }

  return (
    <div style={{ padding: 24, maxWidth: 980, display: "flex", flexDirection: "column", gap: 20 }}>
      <Panel title="Archived Events">
        {loading && <p style={noteStyle}>Loading archive...</p>}
        {notice && <p style={{ ...noteStyle, color: "#15803d" }}>{notice}</p>}
        {error && <p style={{ ...noteStyle, color: "#b91c1c" }}>{error}</p>}
        {events.length === 0 && <p style={{ fontSize: 13, color: "#6b7280" }}>No finished events are archived yet.</p>}
        {events.length > 0 && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
            {events.map(archiveEvent => {
              const counts = countMessages(getTrustedEventMessages(archiveEvent, messagesByEvent[archiveEvent.id] ?? []));
              const artworkUrl = getPublicImageUrl("artwork", archiveEvent.artwork_path);
              return (
                <div
                  key={archiveEvent.id}
                  style={{
                    ...archiveCardStyle,
                    borderColor: selectedId === archiveEvent.id ? "#6366f1" : "#e5e7eb",
                    boxShadow: selectedId === archiveEvent.id ? "0 0 0 1px #6366f1" : "none",
                  }}
                >
                  <button
                    type="button"
                    onClick={() => setSelectedId(archiveEvent.id)}
                    style={archiveOpenButtonStyle}
                  >
                    {artworkUrl ? (
                      <img src={artworkUrl} alt="" style={{ width: 54, height: 54, borderRadius: 6, objectFit: "cover", border: "1px solid #e5e7eb", flexShrink: 0 }} />
                    ) : (
                      <span style={{ width: 54, height: 54, borderRadius: 6, background: "#f3f4f6", border: "1px solid #e5e7eb", flexShrink: 0 }} />
                    )}
                    <span style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 4, textAlign: "left" }}>
                      <strong style={{ fontSize: 13, color: "#111827", overflowWrap: "anywhere" }}>{archiveEvent.title}</strong>
                      <span style={{ fontSize: 12, color: "#6b7280" }}>{archiveEvent.artist_name || "Unknown artist"}</span>
                      <span style={{ fontSize: 11, color: "#6b7280" }}>{formatAdminDateTime(archiveEvent.starts_at ?? "")} - {formatAdminDateTime(archiveEvent.ends_at ?? "")}</span>
                      <span style={{ fontSize: 11, color: "#374151" }}>{archiveEvent.status} · {counts.total} messages · {counts.approved} approved · {counts.pending + counts.queued + counts.rejected} pending/queued/rejected</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete archived event ${archiveEvent.title}`}
                    disabled={Boolean(deletingId)}
                    onClick={() => openDeleteDialog(archiveEvent)}
                    style={trashButtonStyle}
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      {selectedEvent && (
        <Panel title="Archived Event Detail">
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 160px) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
            <ArchiveImagePreview event={selectedEvent} />
            <div style={{ display: "grid", gap: 8 }}>
              <h2 style={{ margin: 0, fontSize: 18 }}>{selectedEvent.title}</h2>
              <p style={{ margin: 0, color: "#6b7280", fontSize: 13 }}>{selectedEvent.artist_name || "Unknown artist"}</p>
              <p style={{ margin: 0, color: "#374151", fontSize: 13 }}>Start: {formatAdminDateTime(selectedEvent.starts_at ?? "")}</p>
              <p style={{ margin: 0, color: "#374151", fontSize: 13 }}>End: {formatAdminDateTime(selectedEvent.ends_at ?? "")}</p>
              <p style={{ margin: 0, color: "#374151", fontSize: 13 }}>Status: {selectedEvent.status}</p>
              <p style={{ margin: 0, color: "#374151", fontSize: 13 }}>Audio: {selectedEvent.audio_path ? selectedEvent.audio_path.split("/").pop() : "No audio uploaded"}</p>
              <p style={{ margin: 0, color: "#374151", fontSize: 13 }}>
                {selectedCounts.total} total · {selectedCounts.approved} approved · {selectedCounts.pending} pending · {selectedCounts.queued} queued · {selectedCounts.rejected} rejected · {selectedCounts.pinned} pinned · {selectedCounts.highlighted} highlighted · {selectedCounts.admin} admin
              </p>
            </div>
          </div>
        </Panel>
      )}

      {selectedEvent && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16 }}>
          {selectedMessages.length === 0 && (
            <Panel title="Messages">
              <p style={{ fontSize: 13, color: "#9ca3af" }}>No event-scoped messages.</p>
            </Panel>
          )}
          {selectedMessages.length > 0 && (
            <>
              <ArchiveMessageSection event={selectedEvent} title="Approved" messages={selectedMessages.filter(message => message.status === "approved")} />
              <ArchiveMessageSection event={selectedEvent} title="Pending" messages={selectedMessages.filter(message => message.status === "pending")} />
              <ArchiveMessageSection event={selectedEvent} title="Queued" messages={selectedMessages.filter(message => message.status === "queued")} />
              <ArchiveMessageSection event={selectedEvent} title="Rejected" messages={selectedMessages.filter(message => message.status === "rejected")} />
              <ArchiveMessageSection event={selectedEvent} title="Pinned" messages={selectedMessages.filter(message => message.is_pinned)} />
              <ArchiveMessageSection event={selectedEvent} title="Highlighted" messages={selectedMessages.filter(message => message.is_highlighted)} />
              <ArchiveMessageSection event={selectedEvent} title="Admin Published" messages={selectedMessages.filter(message => message.is_admin)} />
            </>
          )}
        </div>
      )}

      {deleteTarget && (
        <DeleteArchivedEventDialog
          event={deleteTarget}
          step={deleteStep}
          phrase={deletePhrase}
          deleting={deletingId === deleteTarget.id}
          onPhraseChange={setDeletePhrase}
          onCancel={closeDeleteDialog}
          onContinue={() => {
            setDeleteStep(2);
            setDeletePhrase("");
          }}
          onDelete={permanentlyDeleteArchivedEvent}
        />
      )}
    </div>
  );
}

function DeleteArchivedEventDialog({
  event,
  step,
  phrase,
  deleting,
  onPhraseChange,
  onCancel,
  onContinue,
  onDelete,
}: {
  event: MusicEvent;
  step: 1 | 2;
  phrase: string;
  deleting: boolean;
  onPhraseChange: (value: string) => void;
  onCancel: () => void;
  onContinue: () => void;
  onDelete: () => void;
}) {
  const canDelete = phrase === "DELETE" && !deleting;

  return (
    <div role="presentation" style={dialogBackdropStyle}>
      <section role="dialog" aria-modal="true" aria-labelledby="delete-archive-title" style={dialogStyle}>
        {step === 1 ? (
          <>
            <h2 id="delete-archive-title" style={dialogTitleStyle}>Delete archived event?</h2>
            <p style={dialogCopyStyle}>
              Delete "{event.title}"? This will permanently remove the event, its chat history, and event-owned media.
            </p>
            <div style={dialogActionsStyle}>
              <button type="button" disabled={deleting} onClick={onCancel} style={secondaryButton}>Cancel</button>
              <button type="button" disabled={deleting} onClick={onContinue} style={buttonStyle("#b91c1c")}>Continue</button>
            </div>
          </>
        ) : (
          <>
            <h2 id="delete-archive-title" style={dialogTitleStyle}>Permanent deletion cannot be undone.</h2>
            <p style={dialogCopyStyle}>Type DELETE to continue.</p>
            <input
              value={phrase}
              onChange={input => onPhraseChange(input.target.value)}
              autoFocus
              autoComplete="off"
              aria-label="Type DELETE to confirm permanent deletion"
              style={inputStyle}
            />
            <div style={dialogActionsStyle}>
              <button type="button" disabled={deleting} onClick={onCancel} style={secondaryButton}>Cancel</button>
              <button type="button" disabled={!canDelete} onClick={onDelete} style={{ ...buttonStyle("#b91c1c"), opacity: canDelete ? 1 : 0.45 }}>
                {deleting ? "Deleting..." : "Permanently Delete"}
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function ArchiveImagePreview({ event }: { event: MusicEvent }) {
  const artworkUrl = getPublicImageUrl("artwork", event.artwork_path);
  const artistUrl = getPublicImageUrl("artist-images", event.artist_image_path);

  return (
    <div style={{ display: "grid", gap: 10 }}>
      {artworkUrl ? (
        <img src={artworkUrl} alt="Archived artwork preview" style={{ width: "100%", aspectRatio: "1 / 1", objectFit: "cover", borderRadius: 8, border: "1px solid #e5e7eb" }} />
      ) : (
        <div style={{ width: "100%", aspectRatio: "1 / 1", borderRadius: 8, border: "1px solid #e5e7eb", background: "#f3f4f6", display: "grid", placeItems: "center", color: "#6b7280", fontSize: 12 }}>No artwork</div>
      )}
      {artistUrl && <img src={artistUrl} alt="Archived artist preview" style={{ width: "54%", aspectRatio: "4 / 5", objectFit: "cover", borderRadius: 8, border: "1px solid #e5e7eb" }} />}
    </div>
  );
}

function ArchiveMessageSection({ event, title, messages }: { event: MusicEvent; title: string; messages: ChatMessage[] }) {
  const artistName = event.artist_name || "artist";
  const artistUrl = getPublicImageUrl("artist-images", event.artist_image_path);

  return (
    <Panel title={`${title} (${messages.length})`}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: 360, overflowY: "auto" }}>
        {messages.length === 0 && <p style={{ fontSize: 13, color: "#9ca3af" }}>No messages.</p>}
        {messages.map(message => (
          <div key={`${title}-${message.id}`} style={chatMessageStyle(message)}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
              {message.is_admin && <ArchiveArtistAvatar artistUrl={artistUrl} />}
              <strong style={{ fontSize: 12 }}>{message.is_admin ? artistName : message.display_name}</strong>
              <span style={{ fontSize: 11, color: "#6b7280" }}>{formatChatTime(message.created_at)}</span>
              <span style={badgeStyle}>{message.status}</span>
              {message.is_pinned && <span style={badgeStyle}>Pinned</span>}
              {message.is_highlighted && <span style={badgeStyle}>Highlighted</span>}
            </div>
            <p style={{ fontSize: 13, color: "#374151", overflowWrap: "anywhere" }}>{message.body}</p>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function ArchiveArtistAvatar({ artistUrl }: { artistUrl: string }) {
  if (!artistUrl) return null;

  return (
    <img
      src={artistUrl}
      alt=""
      aria-hidden="true"
      style={{
        width: 22,
        aspectRatio: "4 / 5",
        objectFit: "cover",
        borderRadius: 5,
        display: "block",
        flexShrink: 0,
      }}
    />
  );
}

function ChatModerationPanel({
  event,
  chat,
  busy,
  setBusy,
  setError,
  setMessage,
  error,
  message,
  onEventUpdated,
}: {
  event: MusicEvent | null;
  chat: ReturnType<typeof useEventChat>;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  setError: (error: string) => void;
  setMessage: (message: string) => void;
  error: string;
  message: string;
  onEventUpdated: (event: MusicEvent) => void;
}) {
  const [body, setBody] = useState("");
  const queuedCount = chat.grouped.queued.length;
  const oldestQueuedAge = formatQueuedAge(chat.grouped.queued);
  const schedulerBand = event?.current_queue_band ?? "not calculated";
  const schedulerDelay = formatDelay(event?.last_calculated_delay_ms);
  const nextRelease = formatRelativeTime(event?.next_auto_publish_at);
  const recentPublishes = event?.recent_fan_publish_count ?? 0;
  const publishBudget = event?.publication_budget_per_minute ?? 20;
  const lastReleaseSize = event?.last_release_size ?? 0;

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
      if (!event) throw new Error("Start an active event before publishing admin chat messages.");
      await sendAdminMessage({ event_id: event.id, body });
      setBody("");
    });
  }

  async function setAutoPublish(enabled: boolean) {
    await run(enabled ? "Auto publish enabled." : "Auto publish disabled.", async () => {
      if (!event) throw new Error("Start an active event before changing auto-publish settings.");
      const saved = await setEventChatAutoPublishSettings(event.id, { auto_publish_enabled: enabled });
      onEventUpdated(saved);
    });
  }

  async function setQueuePaused(paused: boolean) {
    await run(paused ? "Queue paused." : "Queue resumed.", async () => {
      if (!event) throw new Error("Start an active event before changing queue settings.");
      const saved = await setEventChatAutoPublishSettings(event.id, { queue_paused: paused });
      onEventUpdated(saved);
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
            disabled={!event || busy}
            placeholder={event ? "Write an admin message..." : "No active event is available for chat."}
            style={inputStyle}
          />
          <button disabled={busy || !event || !body.trim()} type="submit" style={buttonStyle("#6366f1")}>Publish</button>
        </form>
        {!event && <p style={noteStyle}>The active Chat tab only shows messages for the current upcoming or live event. Finished events are available in Archived Events.</p>}
        {chat.loading && <p style={noteStyle}>Loading chat...</p>}
        {chat.error && <p style={{ ...noteStyle, color: "#b91c1c" }}>{chat.error}</p>}
        {message && <p style={{ ...noteStyle, color: "#15803d" }}>{message}</p>}
        {error && <p style={{ ...noteStyle, color: "#b91c1c" }}>{error}</p>}
      </Panel>

      <Panel title="Auto Publish Queue">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <SmallButton disabled={busy || !event || event.auto_publish_enabled} onClick={() => setAutoPublish(true)}>Auto Publish On</SmallButton>
          <SmallButton disabled={busy || !event || !event.auto_publish_enabled} color="#6b7280" onClick={() => setAutoPublish(false)}>Auto Publish Off</SmallButton>
          <SmallButton disabled={busy || !event || event.queue_paused} color="#f59e0b" onClick={() => setQueuePaused(true)}>Pause Queue</SmallButton>
          <SmallButton disabled={busy || !event || !event.queue_paused} onClick={() => setQueuePaused(false)}>Resume Queue</SmallButton>
        </div>
        <p style={noteStyle}>
          {event?.auto_publish_enabled ? "Auto publish is on" : "Auto publish is off"} · {event?.queue_paused ? "paused" : "not paused"} · {queuedCount} queued{oldestQueuedAge ? ` · oldest ${oldestQueuedAge}` : ""}
        </p>
        <p style={noteStyle}>
          Band {schedulerBand} · pace {queuePaceLabel(schedulerBand)} · recent {recentPublishes}/{publishBudget}/min · last release {lastReleaseSize || "none"}{schedulerDelay ? ` · next delay ${schedulerDelay}` : ""}{nextRelease ? ` · next ${nextRelease}` : ""}
        </p>
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

      <ChatSection title="Auto-publish queue" empty="No queued low-risk messages." messages={chat.grouped.queued}>
        {messageItem => (
          <>
            <SmallButton disabled={busy} onClick={() => run("Queued message approved.", () => setMessageStatus(messageItem.id, "approved").then(() => undefined))}>Approve Now</SmallButton>
            <SmallButton disabled={busy} color="#ef4444" onClick={() => run("Queued message rejected.", () => setMessageStatus(messageItem.id, "rejected").then(() => undefined))}>Reject</SmallButton>
            <SmallButton disabled={busy} color="#6b7280" onClick={() => run("Queued message deleted.", () => deleteChatMessage(messageItem.id))}>Delete</SmallButton>
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
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const bottomAnchorRef = useRef<HTMLDivElement | null>(null);
  const nearBottomRef = useRef(true);
  const [showNewMessages, setShowNewMessages] = useState(false);
  const chronologicalMessages = useMemo(() => [...messages].sort(comparePublishedTuple), [messages]);
  const pinnedMessage = useMemo(() => chronologicalMessages.find(message => message.is_pinned), [chronologicalMessages]);
  const highlightedMessage = useMemo(
    () => chronologicalMessages.find(message => message.is_highlighted && message.id !== pinnedMessage?.id),
    [chronologicalMessages, pinnedMessage?.id],
  );
  const timelineMessages = useMemo(() => chronologicalMessages.filter(message => (
    message.id !== pinnedMessage?.id
    && message.id !== highlightedMessage?.id
  )), [chronologicalMessages, highlightedMessage?.id, pinnedMessage?.id]);
  const latestTimelineKey = timelineMessages.at(-1)?.id ?? "";

  function updateNearBottom() {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    const nearBottom = distanceFromBottom < 96;
    nearBottomRef.current = nearBottom;
    if (nearBottom) setShowNewMessages(false);
  }

  function scrollToBottom(behavior: ScrollBehavior = "smooth") {
    bottomAnchorRef.current?.scrollIntoView({ block: "end", behavior });
    nearBottomRef.current = true;
    setShowNewMessages(false);
  }

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !latestTimelineKey) return;
    if (nearBottomRef.current) {
      requestAnimationFrame(() => scrollToBottom("auto"));
    } else {
      setShowNewMessages(true);
    }
  }, [latestTimelineKey]);

  return (
    <Panel title={`LIVE CHAT PREVIEW (${messages.length})`}>
      <div style={{ position: "relative" }}>
        <div
          ref={viewportRef}
          onScroll={updateNearBottom}
          tabIndex={0}
          aria-label="Live chat preview messages"
          style={{
            border: "1px solid #111827",
            background: "#050505",
            color: "#f9fafb",
            borderRadius: 6,
            padding: 12,
            display: "flex",
            flexDirection: "column",
            gap: 10,
            maxHeight: "clamp(360px, 70vh, 720px)",
            overflowY: "auto",
            overflowX: "hidden",
            overscrollBehavior: "contain",
          }}
        >
          {(pinnedMessage || highlightedMessage) && (
            <div
              style={{
                position: "sticky",
                top: -12,
                zIndex: 2,
                display: "flex",
                flexDirection: "column",
                gap: 10,
                margin: "-12px -12px 0",
                padding: "12px 12px 10px",
                background: "#050505",
                borderBottom: "1px solid rgba(255,255,255,0.16)",
                boxShadow: "0 10px 24px rgba(0,0,0,0.34)",
              }}
            >
              {pinnedMessage && <ChatPreviewMessageCard message={pinnedMessage} busy={busy} run={run} variant="pinned" />}
              {highlightedMessage && <ChatPreviewMessageCard message={highlightedMessage} busy={busy} run={run} variant="highlighted" />}
            </div>
          )}

          {messages.length === 0 && <p style={{ fontSize: 13, color: "#9ca3af" }}>No approved messages yet.</p>}
          {timelineMessages.map(message => (
            <ChatPreviewMessageCard key={message.id} message={message} busy={busy} run={run} variant="normal" />
          ))}
          <div ref={bottomAnchorRef} aria-hidden="true" />
        </div>
        {showNewMessages && (
          <button
            type="button"
            onClick={() => scrollToBottom()}
            style={{
              position: "absolute",
              left: "50%",
              bottom: 14,
              transform: "translateX(-50%)",
              border: "1px solid rgba(0,255,65,0.55)",
              background: "#07140b",
              color: "#00ff41",
              borderRadius: 999,
              padding: "6px 12px",
              fontSize: 12,
              fontWeight: 700,
              boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
            }}
          >
            New messages
          </button>
        )}
      </div>
    </Panel>
  );
}

function ChatPreviewMessageCard({ message, busy, run, variant }: { message: ChatMessage; busy: boolean; run: (label: string, action: () => Promise<void>) => Promise<void>; variant: "pinned" | "highlighted" | "normal" }) {
  const emphasized = variant === "pinned" || variant === "highlighted" || message.is_highlighted;
  const borderColor = variant === "pinned"
    ? "rgba(0,255,65,0.7)"
    : emphasized
      ? "#00ff41"
      : "rgba(255,255,255,0.12)";
  const background = variant === "pinned"
    ? "rgba(0,255,65,0.18)"
    : emphasized
      ? "rgba(0,255,65,0.12)"
      : "rgba(255,255,255,0.04)";

  return (
    <div style={{
      border: `1px solid ${borderColor}`,
      background,
      borderRadius: 6,
      padding: "10px 12px",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 5 }}>
        <strong style={{ fontSize: 12, color: "#fff" }}>{message.display_name}</strong>
        <span style={{ fontSize: 11, color: "rgba(255,255,255,0.45)" }}>{formatChatTime(message.published_at ?? message.created_at)}</span>
        {message.is_admin && <span style={darkBadgeStyle}>Admin</span>}
        {message.is_pinned && <span style={darkBadgeStyle}>Pinned</span>}
        {message.is_highlighted && <span style={darkBadgeStyle}>Highlighted</span>}
      </div>
      <p style={{ fontSize: 13, color: "rgba(255,255,255,0.82)", overflowWrap: "anywhere" }}>{message.body}</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
        <SmallButton disabled={busy} onClick={() => run(message.is_pinned ? "Message unpinned." : "Message pinned.", () => setMessagePinned(message.id, !message.is_pinned))}>{message.is_pinned ? "Unpin" : "Pin"}</SmallButton>
        <SmallButton disabled={busy} onClick={() => run(message.is_highlighted ? "Highlight removed." : "Message highlighted.", () => setMessageHighlighted(message.id, !message.is_highlighted))}>{message.is_highlighted ? "Remove Highlight" : "Highlight"}</SmallButton>
        <SmallButton disabled={busy} onClick={() => run(message.is_liked ? "Artist reaction removed." : "Artist reaction added.", () => updateMessageFlags(message.id, { is_liked: !message.is_liked }).then(() => undefined))}>{message.is_liked ? "Unlike" : "Like as Artist"}</SmallButton>
        <SmallButton disabled={busy} color="#6b7280" onClick={() => run("Message deleted.", () => deleteChatMessage(message.id))}>Delete</SmallButton>
      </div>
    </div>
  );
}

function comparePublishedTuple(left: ChatMessage, right: ChatMessage) {
  if (left.published_at && right.published_at) {
    const byPublishedAt = left.published_at.localeCompare(right.published_at);
    if (byPublishedAt !== 0) return byPublishedAt;
  } else if (left.published_at !== right.published_at) {
    return left.published_at ? -1 : 1;
  }

  return left.id.localeCompare(right.id);
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
            </div>
            <RiskSummary message={message} />
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

function RiskSummary({ message }: { message: ChatMessage }) {
  if (message.is_admin) return null;

  const level = message.risk_level?.toUpperCase() ?? "UNCLASSIFIED";
  const flags = message.risk_flags?.length ? message.risk_flags.map(formatRiskFlag).join(" · ") : "No risk flags";
  const version = message.classifier_version ? ` · ${message.classifier_version}` : "";

  return (
    <p style={{ fontSize: 11, color: "#6b7280", marginBottom: 6 }}>
      <strong>{level}</strong> · {flags}{version}
    </p>
  );
}

function formatRiskFlag(flag: string) {
  return flag
    .toLowerCase()
    .split("_")
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function SmallButton({ children, onClick, disabled, color = "#6366f1" }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; color?: string }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} style={{ fontSize: 12, padding: "4px 9px", border: "none", borderRadius: 4, background: color, color: "#fff", fontWeight: 600 }}>
      {children}
    </button>
  );
}

function formatChatTime(value: string) {
  return new Intl.DateTimeFormat("en-GB", {
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

function Field({ label, value, onChange, type = "text", requiredNote, error }: { label: string; value: string; onChange: (value: string) => void; type?: string; requiredNote?: string; error?: string }) {
  return (
    <label style={{ display: "block" }}>
      <span style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 4 }}>{label}</span>
      {requiredNote && <span style={{ fontSize: 11, color: "#9ca3af", display: "block", marginBottom: 4 }}>{requiredNote}</span>}
      <input type={type} value={value} min={type === "number" ? 0.1 : undefined} step={type === "number" ? 0.5 : undefined} onChange={event => onChange(event.target.value)} style={inputStyle} />
      {error && <span style={{ fontSize: 12, color: "#b91c1c", display: "block", marginTop: 4 }}>{error}</span>}
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

const archiveCardStyle: React.CSSProperties = {
  width: "100%",
  display: "flex",
  gap: 12,
  alignItems: "flex-start",
  padding: 12,
  border: "1px solid #e5e7eb",
  borderRadius: 8,
  background: "#fff",
};

const archiveOpenButtonStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: "flex",
  gap: 12,
  alignItems: "flex-start",
  padding: 0,
  border: "none",
  background: "transparent",
  cursor: "pointer",
};

const trashButtonStyle: React.CSSProperties = {
  width: 34,
  height: 34,
  display: "grid",
  placeItems: "center",
  border: "1px solid #fecaca",
  borderRadius: 6,
  background: "#fff",
  color: "#b91c1c",
  cursor: "pointer",
  flexShrink: 0,
};

const dialogBackdropStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 50,
  background: "rgba(17,24,39,0.48)",
  display: "grid",
  placeItems: "center",
  padding: 20,
};

const dialogStyle: React.CSSProperties = {
  width: "min(100%, 440px)",
  borderRadius: 10,
  border: "1px solid #fecaca",
  background: "#fff",
  boxShadow: "0 20px 60px rgba(15,23,42,0.28)",
  padding: 20,
  display: "grid",
  gap: 14,
};

const dialogTitleStyle: React.CSSProperties = {
  margin: 0,
  color: "#991b1b",
  fontSize: 18,
};

const dialogCopyStyle: React.CSSProperties = {
  margin: 0,
  color: "#374151",
  fontSize: 14,
  lineHeight: 1.5,
};

const dialogActionsStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  flexWrap: "wrap",
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
