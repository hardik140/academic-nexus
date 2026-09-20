import { useEffect } from "react";
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import { AndroidImportance } from "expo-notifications";
import * as Device from "expo-device";
import { apiPost } from "@/lib/api";

/**
 * Registers this device for push notifications and upserts the Expo push
 * token into device_tokens (see app/api/mobile/push-token/route.ts and
 * migration 017). sendAnnouncement (director/dashboard/actions.ts) reads
 * this table to actually deliver a push once a notification is created —
 * this hook is the other half of that flow.
 */
export function usePushRegistration(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    if (!Device.isDevice) return; // push tokens aren't meaningful on a simulator without an APNs/FCM setup

    (async () => {
      const { status: existing } = await Notifications.getPermissionsAsync();
      let status = existing;
      if (status !== "granted") {
        const req = await Notifications.requestPermissionsAsync();
        status = req.status;
      }
      if (status !== "granted") return;

      if (Platform.OS === "android") {
        await Notifications.setNotificationChannelAsync("default", {
          name: "default",
          importance: AndroidImportance.DEFAULT,
        });
      }

      const { data: token } = await Notifications.getExpoPushTokenAsync();
      try {
        await apiPost("/api/mobile/push-token", { token, platform: Platform.OS });
      } catch {
        // Non-fatal — the app still works without push, just no native alerts.
      }
    })();
  }, [enabled]);
}
