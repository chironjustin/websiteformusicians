import { supabase, supabaseAnonKey, supabaseUrl } from "@/lib/supabase";

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const AUDIO_TYPES = ["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/ogg", "audio/flac", "audio/mp4", "audio/aac"];
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_AUDIO_BYTES = 100 * 1024 * 1024;

type Bucket = "artist-images" | "artwork" | "merch-images" | "audio";

export type SafeSessionState = {
  clientInitialized: boolean;
  projectHost: string;
  session: "anon" | "authenticated" | "none";
  getSessionResolved: boolean;
  online: boolean | null;
  visibilityState: string;
  errorMessage: string;
};

export type DirectSignedAudioUrlDiagnostic = {
  state: "resolved" | "rejected" | "timed-out";
  elapsedMs: number;
  status: number | null;
  signedUrlPresent: boolean;
  signedUrlPath: string;
  errorMessage: string;
};

type SignedAudioUrlOptions = {
  requestId?: number;
  attempt?: number;
  eventId?: string | null;
  sourceKey?: string;
  timeoutMs?: number;
  startedAt?: number;
};

async function requireUserId() {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new Error("You must be signed in to upload files.");
  return data.user.id;
}

function sanitizeFilename(name: string) {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "upload";
}

function normalizeObjectPath(bucket: Bucket, path: string | null | undefined) {
  if (!path) return "";
  const trimmed = path.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed) || trimmed.includes("/storage/v1/object/")) {
    throw new Error("Stored file path must be a storage object path, not a URL.");
  }
  if (trimmed.startsWith(`${bucket}/`)) {
    throw new Error(`Stored file path should not include the ${bucket} bucket prefix.`);
  }
  return trimmed.replace(/^\/+/, "");
}

export function getAudioObjectPath(path: string | null | undefined) {
  return normalizeObjectPath("audio", path);
}

export function getSupabaseProjectHost() {
  try {
    return new URL(supabaseUrl).host;
  } catch {
    return "";
  }
}

function sanitizeUrlPath(value: string) {
  if (!value) return "";
  try {
    return new URL(value).pathname;
  } catch {
    return value.split("?")[0]?.split("#")[0] ?? "";
  }
}

function encodeStoragePath(path: string) {
  return path.split("/").map(part => encodeURIComponent(part)).join("/");
}

export class SignedAudioUrlTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignedAudioUrlTimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new SignedAudioUrlTimeoutError(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  });
}

function getBrowserOnlineState() {
  return typeof navigator === "undefined" ? null : navigator.onLine;
}

function getBrowserVisibilityState() {
  return typeof document === "undefined" ? "unknown" : document.visibilityState;
}

export async function getSafeSupabaseSessionState(): Promise<SafeSessionState> {
  const base = {
    clientInitialized: Boolean(supabaseUrl && supabaseAnonKey),
    projectHost: getSupabaseProjectHost(),
    online: getBrowserOnlineState(),
    visibilityState: getBrowserVisibilityState(),
  };

  try {
    const { data, error } = await supabase.auth.getSession();
    if (error) {
      return {
        ...base,
        session: "none",
        getSessionResolved: false,
        errorMessage: error.message,
      };
    }

    return {
      ...base,
      session: data.session ? "authenticated" : "anon",
      getSessionResolved: true,
      errorMessage: "",
    };
  } catch (error) {
    return {
      ...base,
      session: "none",
      getSessionResolved: false,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

export function getStoragePathInfo(bucket: Bucket, path: string | null | undefined) {
  const objectPath = normalizeObjectPath(bucket, path);
  if (!objectPath) return null;
  const parts = objectPath.split("/").filter(Boolean);
  const basename = parts.at(-1) ?? "";
  const parentFolder = parts.slice(0, -1).join("/");
  return {
    bucket,
    path: objectPath,
    ownerId: parts[0] ?? "",
    eventId: parts[1] ?? "",
    parentFolder,
    basename,
  };
}

export function assertStoragePathBelongsToEvent(bucket: Bucket, path: string | null | undefined, eventId: string) {
  const info = getStoragePathInfo(bucket, path);
  if (!info) throw new Error(`Missing ${bucket} storage path.`);
  if (info.eventId !== eventId) {
    throw new Error(`Uploaded ${bucket} file belongs to event ${info.eventId || "unknown"}, not the current event ${eventId}.`);
  }
  return info;
}

function validateFile(file: File, kind: "image" | "audio") {
  const allowed = kind === "image" ? IMAGE_TYPES : AUDIO_TYPES;
  const maxSize = kind === "image" ? MAX_IMAGE_BYTES : MAX_AUDIO_BYTES;
  if (!allowed.includes(file.type)) throw new Error(`Unsupported ${kind} file type.`);
  if (file.size > maxSize) throw new Error(`${kind === "image" ? "Image" : "Audio"} file is too large.`);
}

async function uploadFile(bucket: Bucket, eventId: string, file: File, kind: "image" | "audio") {
  validateFile(file, kind);
  const userId = await requireUserId();
  const path = `${userId}/${eventId}/${crypto.randomUUID()}-${sanitizeFilename(file.name)}`;
  const { error } = await supabase.storage.from(bucket).upload(path, file, {
    cacheControl: "3600",
    upsert: false,
    contentType: file.type,
  });
  if (error) throw new Error(error.message);
  return path;
}

export function uploadArtistImage(eventId: string, file: File) {
  return uploadFile("artist-images", eventId, file, "image");
}

export function uploadArtwork(eventId: string, file: File) {
  return uploadFile("artwork", eventId, file, "image");
}

export function uploadMerchImage(eventId: string, file: File) {
  return uploadFile("merch-images", eventId, file, "image");
}

export function uploadAudio(eventId: string, file: File) {
  // TODO: For very large releases, replace standard upload with Supabase resumable uploads.
  return uploadFile("audio", eventId, file, "audio");
}

export async function removeFile(bucket: Bucket, path: string) {
  const { error } = await supabase.storage.from(bucket).remove([path]);
  if (error) throw new Error(error.message);
}

export async function verifyStorageObjectExists(bucket: Bucket, path: string | null | undefined) {
  const info = getStoragePathInfo(bucket, path);
  if (!info) return false;
  if (!info.parentFolder || !info.basename) return false;
  const { data, error } = await supabase.storage.from(bucket).list(info.parentFolder, {
    search: info.basename,
    limit: 100,
  });
  if (error) throw new Error(error.message);
  return (data ?? []).some(item => item.name === info.basename);
}

export function getPublicImageUrl(bucket: Exclude<Bucket, "audio">, path: string | null | undefined) {
  const objectPath = normalizeObjectPath(bucket, path);
  if (!objectPath) return "";
  return supabase.storage.from(bucket).getPublicUrl(objectPath).data.publicUrl;
}

export async function getSignedAudioUrl(path: string | null | undefined, expiresIn = 3600, options: SignedAudioUrlOptions = {}) {
  const objectPath = normalizeObjectPath("audio", path);
  if (!objectPath) return "";
  const timeoutMs = options.timeoutMs ?? 10000;
  const startedAt = options.startedAt ?? Date.now();
  console.info("[signed-audio-url-request] started", {
    requestId: options.requestId ?? null,
    attempt: options.attempt ?? null,
    eventId: options.eventId ?? null,
    sourceKey: options.sourceKey ?? "",
    normalizedAudioPath: objectPath,
    projectHost: getSupabaseProjectHost(),
    startedAt: new Date(startedAt).toISOString(),
    timeoutMs,
    online: getBrowserOnlineState(),
    visibilityState: getBrowserVisibilityState(),
  });

  try {
    const { data, error } = await withTimeout(
      supabase.storage.from("audio").createSignedUrl(objectPath, expiresIn),
      timeoutMs,
      `Timed out creating signed audio URL after ${timeoutMs}ms.`,
    );
    const elapsedMs = Date.now() - startedAt;
    if (error) throw new Error(error.message);
    console.info("[signed-audio-url-request] resolved", {
      requestId: options.requestId ?? null,
      attempt: options.attempt ?? null,
      eventId: options.eventId ?? null,
      normalizedAudioPath: objectPath,
      elapsedMs,
      signedUrlPresent: Boolean(data.signedUrl),
      signedUrlPath: sanitizeUrlPath(data.signedUrl),
    });
    return data.signedUrl;
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    console.info("[signed-audio-url-request] rejected", {
      requestId: options.requestId ?? null,
      attempt: options.attempt ?? null,
      eventId: options.eventId ?? null,
      normalizedAudioPath: objectPath,
      elapsedMs,
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function getSignedAudioUrlViaRestDiagnostic(path: string | null | undefined, expiresIn = 3600, timeoutMs = 10000): Promise<DirectSignedAudioUrlDiagnostic> {
  const objectPath = normalizeObjectPath("audio", path);
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const sessionState = await getSafeSupabaseSessionState();
  const { data } = await supabase.auth.getSession();
  const bearer = data.session?.access_token ?? supabaseAnonKey;
  const endpoint = `${supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/sign/audio/${encodeStoragePath(objectPath)}`;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        apikey: supabaseAnonKey,
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
        "cache-control": "no-store",
      },
      body: JSON.stringify({ expiresIn }),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload: { signedURL?: string; signedUrl?: string; error?: string; message?: string } = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { message: text };
    }
    const rawSignedUrl = payload.signedURL ?? payload.signedUrl ?? "";
    const signedUrl = rawSignedUrl.startsWith("/") ? `${supabaseUrl.replace(/\/+$/, "")}${rawSignedUrl}` : rawSignedUrl;
    const errorMessage = response.ok ? "" : payload.error || payload.message || `HTTP ${response.status}`;
    const result: DirectSignedAudioUrlDiagnostic = {
      state: response.ok && Boolean(signedUrl) ? "resolved" : "rejected",
      elapsedMs: Date.now() - startedAt,
      status: response.status,
      signedUrlPresent: Boolean(signedUrl),
      signedUrlPath: sanitizeUrlPath(signedUrl),
      errorMessage,
    };
    console.info("[signed-audio-url-rest-diagnostic] completed", {
      normalizedAudioPath: objectPath,
      projectHost: sessionState.projectHost,
      session: sessionState.session,
      ...result,
    });
    return result;
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    const result: DirectSignedAudioUrlDiagnostic = {
      state: timedOut ? "timed-out" : "rejected",
      elapsedMs: Date.now() - startedAt,
      status: null,
      signedUrlPresent: false,
      signedUrlPath: "",
      errorMessage: timedOut ? `Timed out after ${timeoutMs}ms.` : error instanceof Error ? error.message : String(error),
    };
    console.info("[signed-audio-url-rest-diagnostic] failed", {
      normalizedAudioPath: objectPath,
      projectHost: sessionState.projectHost,
      session: sessionState.session,
      ...result,
    });
    return result;
  } finally {
    clearTimeout(timeoutId);
  }
}
