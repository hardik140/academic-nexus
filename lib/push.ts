const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const BATCH_SIZE = 100; // Expo's documented per-request cap

interface PushMessage {
  to: string;
  title: string;
  body: string;
}

/**
 * Sends push notifications via Expo's push service — no separate
 * FCM/APNs credentials needed, Expo brokers delivery for tokens obtained
 * through expo-notifications (see mobile/src/hooks/usePushRegistration.ts).
 * Best-effort: failures here never block the caller's own write (e.g.
 * sendAnnouncement's `notifications` insert already succeeded by the time
 * this runs) — a push-delivery failure shouldn't look like the whole
 * announcement failed.
 */
export async function sendExpoPushNotifications(tokens: string[], title: string, body: string) {
  if (tokens.length === 0) return;

  const messages: PushMessage[] = tokens.map((to) => ({ to, title, body }));

  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const batch = messages.slice(i, i + BATCH_SIZE);
    try {
      await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(batch),
      });
    } catch {
      // Best-effort — see doc comment above.
    }
  }
}
