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

type StorageRef = {
  bucket: "audio" | "artwork" | "artist-images" | "merch-images";
  column: keyof Pick<EventRow, "audio_path" | "artwork_path" | "artist_image_path" | "merch_image_path">;
  path: string;
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

function cleanPath(path: string | null) {
  const trimmed = path?.trim() ?? "";
  if (!trimmed || /^https?:\/\//i.test(trimmed) || trimmed.includes("/storage/v1/object/")) return "";
  return trimmed.replace(/^\/+/, "");
}

function eventStorageRefs(event: EventRow): StorageRef[] {
  const refs: StorageRef[] = [];
  const audioPath = cleanPath(event.audio_path);
  const artworkPath = cleanPath(event.artwork_path);
  const artistImagePath = cleanPath(event.artist_image_path);
  const merchImagePath = cleanPath(event.merch_image_path);

  if (audioPath) refs.push({ bucket: "audio", column: "audio_path", path: audioPath });
  if (artworkPath) refs.push({ bucket: "artwork", column: "artwork_path", path: artworkPath });
  if (artistImagePath) refs.push({ bucket: "artist-images", column: "artist_image_path", path: artistImagePath });
  if (merchImagePath) refs.push({ bucket: "merch-images", column: "merch_image_path", path: merchImagePath });

  return refs;
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

  const refs = eventStorageRefs(event);
  const { data: otherEvents, error: otherEventsError } = await adminClient
    .from("events")
    .select("id, audio_path, artwork_path, artist_image_path, merch_image_path")
    .neq("id", event.id)
    .returns<Partial<EventRow>[]>();

  if (otherEventsError) {
    await writeAudit(adminClient, event, requester.id, "reference_check_failed", [], { error: otherEventsError.message });
    return json({ error: otherEventsError.message }, 500);
  }

  const exclusiveRefs = refs.filter(ref => !(otherEvents ?? []).some(otherEvent => cleanPath(String(otherEvent[ref.column] ?? "")) === ref.path));

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

  const storageFailures: Array<{ bucket: string; path: string; error: string }> = [];
  const removedStorage: Array<{ bucket: string; path: string }> = [];
  const grouped = new Map<string, string[]>();

  for (const ref of exclusiveRefs) {
    grouped.set(ref.bucket, [...(grouped.get(ref.bucket) ?? []), ref.path]);
  }

  for (const [bucket, paths] of grouped.entries()) {
    const { data, error } = await adminClient.storage.from(bucket).remove(paths);
    const removedPaths = new Set((data ?? []).map(item => item.name));

    for (const path of paths) {
      if (!error && removedPaths.has(path)) {
        removedStorage.push({ bucket, path });
      }
    }

    if (error) {
      for (const path of paths) {
        storageFailures.push({ bucket, path, error: error.message });
      }
    }
  }

  const result = storageFailures.length > 0 ? "partial_success_storage_failed" : "success";
  await writeAudit(adminClient, event, requester.id, result, storageFailures, {
    deleted_chat_messages: chatCount ?? 0,
    removed_storage: removedStorage,
    preserved_shared_storage: refs.filter(ref => !exclusiveRefs.includes(ref)).map(ref => ({ bucket: ref.bucket, path: ref.path })),
  });

  return json({
    deleted: true,
    eventId: event.id,
    deletedChatMessages: chatCount ?? 0,
    removedStorage,
    storageFailures,
  });
});
