import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type EventRow = {
  id: string;
  owner_id: string | null;
  title: string;
  status: string;
  ends_at: string | null;
  audio_path: string | null;
  artwork_path: string | null;
  artist_image_path: string | null;
  merch_image_path: string | null;
};

type Bucket = "audio" | "artwork" | "artist-images" | "merch-images";
type MediaColumn = keyof Pick<EventRow, "audio_path" | "artwork_path" | "artist_image_path" | "merch_image_path">;

type StorageRef = {
  bucket: Bucket;
  column: MediaColumn;
  path: string;
  originalValue: string;
};

type InvalidStorageRef = {
  bucket: Bucket;
  column: MediaColumn;
  originalValue: string;
  reason: string;
};

type StorageRefCollection = {
  refs: StorageRef[];
  invalidRefs: InvalidStorageRef[];
};

type StorageFailure = {
  bucket: string;
  path: string;
  column?: string;
  originalValue?: string;
  error: string;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function isArchived(event: EventRow) {
  if (event.status === "finished") return true;
  if (!event.ends_at) return false;
  return new Date(event.ends_at).getTime() <= Date.now();
}

function stripQueryForLog(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return trimmed;
  }
}

function decodePathname(pathname: string) {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

function normalizePathSegments(path: string) {
  const segments = path.split("/").filter(Boolean);
  if (segments.some(segment => segment === "." || segment === "..")) {
    throw new Error("Storage path cannot contain relative path segments.");
  }
  return segments.join("/");
}

function normalizeStoragePath(storedValue: string | null, bucket: Bucket) {
  const trimmed = storedValue?.trim() ?? "";
  if (!trimmed) return "";

  let candidate = trimmed;

  try {
    const url = new URL(trimmed);
    const decodedPath = decodePathname(url.pathname).replace(/^\/+/, "");
    const storagePrefixMatch = decodedPath.match(/^storage\/v1\/object\/(?:public|sign|authenticated)\/(.+)$/);
    if (!storagePrefixMatch) {
      throw new Error("URL is not a Supabase Storage object URL.");
    }
    candidate = storagePrefixMatch[1];
  } catch (error) {
    if (/^https?:\/\//i.test(trimmed)) {
      throw error instanceof Error ? error : new Error("Invalid Storage URL.");
    }
  }

  candidate = normalizePathSegments(decodePathname(candidate).replace(/^\/+/, ""));
  if (!candidate) return "";

  const knownBuckets: Bucket[] = ["audio", "artwork", "artist-images", "merch-images"];
  const firstSegment = candidate.split("/")[0];

  if (firstSegment === bucket) {
    candidate = candidate.slice(bucket.length).replace(/^\/+/, "");
  } else if (knownBuckets.includes(firstSegment as Bucket)) {
    throw new Error(`Storage path points at bucket "${firstSegment}", expected "${bucket}".`);
  }

  candidate = normalizePathSegments(candidate);
  if (!candidate) throw new Error("Storage path is empty after bucket normalization.");
  return candidate;
}

function collectStorageRef(event: EventRow, column: MediaColumn, bucket: Bucket, collection: StorageRefCollection) {
  const originalValue = event[column]?.trim() ?? "";
  if (!originalValue) return;

  try {
    const path = normalizeStoragePath(originalValue, bucket);
    if (path) {
      collection.refs.push({ bucket, column, path, originalValue: stripQueryForLog(originalValue) });
      return;
    }
    collection.invalidRefs.push({ bucket, column, originalValue: stripQueryForLog(originalValue), reason: "Storage path is empty." });
  } catch (error) {
    collection.invalidRefs.push({
      bucket,
      column,
      originalValue: stripQueryForLog(originalValue),
      reason: error instanceof Error ? error.message : "Unable to normalize storage path.",
    });
  }
}

function eventStorageRefs(event: EventRow): StorageRefCollection {
  const collection: StorageRefCollection = { refs: [], invalidRefs: [] };
  collectStorageRef(event, "audio_path", "audio", collection);
  collectStorageRef(event, "artwork_path", "artwork", collection);
  collectStorageRef(event, "artist_image_path", "artist-images", collection);
  collectStorageRef(event, "merch_image_path", "merch-images", collection);
  return collection;
}

function otherEventReferencesStoragePath(otherEvent: Partial<EventRow>, ref: StorageRef) {
  const otherValue = otherEvent[ref.column];
  if (!otherValue) return false;
  try {
    return normalizeStoragePath(otherValue, ref.bucket) === ref.path;
  } catch {
    return false;
  }
}

function originalMediaFields(event: EventRow) {
  return {
    audio_path: stripQueryForLog(event.audio_path),
    artwork_path: stripQueryForLog(event.artwork_path),
    artist_image_path: stripQueryForLog(event.artist_image_path),
    merch_image_path: stripQueryForLog(event.merch_image_path),
  };
}

async function writeAudit(
  adminClient: ReturnType<typeof createClient>,
  event: Partial<EventRow> | null,
  requesterId: string | null,
  result: string,
  storageFailures: unknown[] = [],
  detail: Record<string, unknown> = {},
) {
  await adminClient.from("event_deletion_audit").insert({
    event_id: event?.id ?? null,
    event_title: event?.title ?? null,
    requester_id: requesterId,
    result,
    storage_failures: storageFailures,
    detail,
  });
}

Deno.serve(async request => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    return json({ error: "Delete function is not configured." }, 500);
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const { data: userData, error: userError } = await adminClient.auth.getUser(token);
  const requester = userData.user;

  if (userError || !requester) {
    await writeAudit(adminClient, null, null, "unauthorized", [], { reason: userError?.message ?? "missing user" });
    return json({ error: "You must be signed in to delete archived events." }, 401);
  }

  let eventId = "";
  try {
    const body = await request.json();
    eventId = typeof body?.eventId === "string" ? body.eventId : "";
  } catch {
    await writeAudit(adminClient, null, requester.id, "bad_request", [], { reason: "invalid json" });
    return json({ error: "Invalid delete request." }, 400);
  }

  if (!eventId) {
    await writeAudit(adminClient, null, requester.id, "bad_request", [], { reason: "missing event id" });
    return json({ error: "Missing event id." }, 400);
  }

  const { data: event, error: eventError } = await adminClient
    .from("events")
    .select("id, owner_id, title, status, ends_at, audio_path, artwork_path, artist_image_path, merch_image_path")
    .eq("id", eventId)
    .maybeSingle<EventRow>();

  if (eventError) {
    await writeAudit(adminClient, { id: eventId }, requester.id, "load_failed", [], { error: eventError.message });
    return json({ error: eventError.message }, 500);
  }

  if (!event) {
    await writeAudit(adminClient, { id: eventId }, requester.id, "not_found");
    return json({ error: "Archived event not found." }, 404);
  }

  if (event.owner_id !== requester.id) {
    await writeAudit(adminClient, event, requester.id, "forbidden");
    return json({ error: "You are not allowed to delete this event." }, 403);
  }

  if (!isArchived(event)) {
    await writeAudit(adminClient, event, requester.id, "rejected_not_archived", [], { status: event.status, ends_at: event.ends_at });
    return json({ error: "Only finished or archived events can be permanently deleted." }, 409);
  }

  const storageCollection = eventStorageRefs(event);
  const refs = storageCollection.refs;
  const invalidStorageRefs = storageCollection.invalidRefs;

  console.log("delete-archived-event media refs", {
    eventId: event.id,
    originalMediaFields: originalMediaFields(event),
    normalizedRefs: refs.map(ref => ({ bucket: ref.bucket, column: ref.column, path: ref.path })),
    invalidStorageRefs,
  });

  const { data: otherEvents, error: otherEventsError } = await adminClient
    .from("events")
    .select("id, audio_path, artwork_path, artist_image_path, merch_image_path")
    .neq("id", event.id)
    .returns<Partial<EventRow>[]>();

  if (otherEventsError) {
    await writeAudit(adminClient, event, requester.id, "reference_check_failed", [], { error: otherEventsError.message });
    return json({ error: otherEventsError.message }, 500);
  }

  const exclusiveRefs = refs.filter(ref => !(otherEvents ?? []).some(otherEvent => otherEventReferencesStoragePath(otherEvent, ref)));
  const preservedSharedStorage = refs
    .filter(ref => !exclusiveRefs.includes(ref))
    .map(ref => ({ bucket: ref.bucket, column: ref.column, path: ref.path }));

  console.log("delete-archived-event shared storage check", {
    eventId: event.id,
    exclusiveRefs: exclusiveRefs.map(ref => ({ bucket: ref.bucket, column: ref.column, path: ref.path })),
    preservedSharedStorage,
  });

  const { count: chatCount, error: chatCountError } = await adminClient
    .from("chat_messages")
    .select("id", { count: "exact", head: true })
    .eq("event_id", event.id);

  if (chatCountError) {
    await writeAudit(adminClient, event, requester.id, "chat_count_failed", [], { error: chatCountError.message });
    return json({ error: chatCountError.message }, 500);
  }

  const { error: eventDeleteError } = await adminClient
    .from("events")
    .delete()
    .eq("id", event.id);

  if (eventDeleteError) {
    await writeAudit(adminClient, event, requester.id, "event_delete_failed", [], { error: eventDeleteError.message, chat_count: chatCount ?? 0 });
    return json({ error: eventDeleteError.message }, 500);
  }

  const storageFailures: StorageFailure[] = invalidStorageRefs.map(ref => ({
    bucket: ref.bucket,
    path: "",
    column: ref.column,
    originalValue: ref.originalValue,
    error: ref.reason,
  }));
  const removedStorage: Array<{ bucket: string; path: string }> = [];
  const grouped = new Map<string, string[]>();

  for (const ref of exclusiveRefs) {
    grouped.set(ref.bucket, [...(grouped.get(ref.bucket) ?? []), ref.path]);
  }

  for (const [bucket, paths] of grouped.entries()) {
    console.log("delete-archived-event storage remove request", { eventId: event.id, bucket, paths });
    const { data, error } = await adminClient.storage.from(bucket).remove(paths);
    console.log("delete-archived-event storage remove response", {
      eventId: event.id,
      bucket,
      requestedPaths: paths,
      removedObjects: data?.map(item => item.name) ?? [],
      error: error?.message ?? null,
    });

    if (!error) {
      for (const path of paths) {
        removedStorage.push({ bucket, path });
      }
      continue;
    }

    for (const path of paths) {
      storageFailures.push({ bucket, path, error: error.message });
    }
  }

  const result = storageFailures.length > 0 ? "partial_success_storage_failed" : "success";
  await writeAudit(adminClient, event, requester.id, result, storageFailures, {
    deleted_chat_messages: chatCount ?? 0,
    original_media_fields: originalMediaFields(event),
    collected_storage_refs: refs.map(ref => ({ bucket: ref.bucket, column: ref.column, path: ref.path })),
    invalid_storage_refs: invalidStorageRefs,
    removed_storage: removedStorage,
    preserved_shared_storage: preservedSharedStorage,
  });

  return json({
    deleted: true,
    eventId: event.id,
    deletedChatMessages: chatCount ?? 0,
    collectedStorageRefs: refs.map(ref => ({ bucket: ref.bucket, column: ref.column, path: ref.path })),
    removedStorage,
    preservedSharedStorage,
    invalidStorageRefs,
    storageFailures,
  });
});
