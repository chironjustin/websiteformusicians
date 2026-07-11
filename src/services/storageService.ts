import { supabase } from "@/lib/supabase";

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const AUDIO_TYPES = ["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/ogg", "audio/flac", "audio/mp4", "audio/aac"];
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_AUDIO_BYTES = 100 * 1024 * 1024;

type Bucket = "artist-images" | "artwork" | "merch-images" | "audio";

async function requireUserId() {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new Error("You must be signed in to upload files.");
  return data.user.id;
}

function sanitizeFilename(name: string) {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "upload";
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

export function getPublicImageUrl(bucket: Exclude<Bucket, "audio">, path: string | null | undefined) {
  if (!path) return "";
  return supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl;
}

export async function getSignedAudioUrl(path: string | null | undefined, expiresIn = 60 * 30) {
  if (!path) return "";
  const { data, error } = await supabase.storage.from("audio").createSignedUrl(path, expiresIn);
  if (error) throw new Error(error.message);
  return data.signedUrl;
}
