import { useCallback, useEffect, useState } from "react";
import { onAccessRefused } from "@/lib/api";
import { registerSession, type Admission } from "@/lib/session";

/**
 * Admission of this app session (migration 054): checked when the
 * authenticated app mounts — sign-in and every cold start with a stored
 * session — and again whenever any API call is refused for an access reason
 * (the college went into maintenance, the session was revoked).
 */
export function useAdmission() {
  const [admission, setAdmission] = useState<Admission | null>(null);

  const recheck = useCallback(async () => {
    setAdmission(await registerSession());
  }, []);

  useEffect(() => {
    let live = true;
    registerSession().then((result) => {
      if (live) setAdmission(result);
    });
    const unsubscribe = onAccessRefused(() => {
      registerSession().then((result) => {
        if (live) setAdmission(result);
      });
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  return { admission, recheck };
}
