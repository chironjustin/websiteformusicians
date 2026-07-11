import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { getCurrentPublicEvent } from "@/services/eventService";
import type { MusicEvent } from "@/types/event";

export function useCurrentEvent() {
  const [event, setEvent] = useState<MusicEvent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      const nextEvent = await getCurrentPublicEvent();
      setEvent(nextEvent);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load event.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refetch();

    const channel = supabase
      .channel("public-events")
      .on("postgres_changes", { event: "*", schema: "public", table: "events" }, () => {
        refetch();
      })
      .subscribe();

    const fallback = window.setInterval(refetch, 60_000);

    return () => {
      window.clearInterval(fallback);
      supabase.removeChannel(channel);
    };
  }, [refetch]);

  return { event, loading, error, refetch };
}
