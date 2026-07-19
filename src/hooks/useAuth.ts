import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { getActiveSession, listenForAuthChanges } from "@/services/authService";

export function useAuth() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    getActiveSession()
      .then(currentSession => {
        if (active) {
          setSession(currentSession);
          setError(null);
        }
      })
      .catch(err => {
        if (active) setError(err instanceof Error ? err.message : "Unable to read session.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    const subscription = listenForAuthChanges((_event, nextSession) => {
      setSession(nextSession);
      setLoading(false);
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  return { session, loading, error, isAuthenticated: Boolean(session) };
}
