import * as SecureStore from "expo-secure-store";
import * as Device from "expo-device";

/**
 * How this installation describes itself to the server's session registry
 * (migration 054). A LABEL for the "your devices" list, never an
 * authorization input: the server counts GoTrue session ids, so a cleared or
 * forged value here cannot make room under a device limit.
 */

const DEVICE_ID_KEY = "nexus.device_id";
let cached: string | null = null;

function randomId(): string {
  // Not a secret and not a security control (see above): uniqueness is all
  // that matters, so Math.random is sufficient.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export async function getDeviceId(): Promise<string> {
  if (cached) return cached;
  try {
    const stored = await SecureStore.getItemAsync(DEVICE_ID_KEY);
    if (stored) return (cached = stored);
    const created = randomId();
    await SecureStore.setItemAsync(DEVICE_ID_KEY, created);
    return (cached = created);
  } catch {
    // Storage unavailable: a per-launch id still labels the session.
    return (cached = randomId());
  }
}

export function getDeviceLabel(): string {
  const model = Device.modelName || Device.deviceName || null;
  const os = Device.osName ? `${Device.osName}${Device.osVersion ? ` ${Device.osVersion}` : ""}` : null;
  return [model, os].filter(Boolean).join(" · ").slice(0, 120) || "Mobile app";
}

/** Sent on every mobile API call. "mobile-app" marks the updated client that registers its sessions. */
export async function clientHeaders(): Promise<Record<string, string>> {
  return {
    "x-nexus-client": "mobile-app",
    "x-nexus-device-id": await getDeviceId(),
    "x-nexus-device-label": getDeviceLabel(),
  };
}
