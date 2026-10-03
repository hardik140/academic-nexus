const mockStore = new Map<string, string>();
jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(async (k: string) => mockStore.get(k) ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => void mockStore.set(k, v)),
}));
jest.mock("expo-device", () => ({ modelName: "Pixel 8", deviceName: null, osName: "Android", osVersion: "15" }));

type DeviceModule = typeof import("@/lib/device");

/** A fresh copy of the module, as after an app restart (its in-memory cache is gone). */
function freshLaunch(): DeviceModule {
  let mod: DeviceModule | undefined;
  jest.isolateModules(() => {
    mod = jest.requireActual<DeviceModule>("@/lib/device");
  });
  return mod!;
}

describe("device identity for the session list (migration 054)", () => {
  beforeEach(() => {
    mockStore.clear();
  });

  it("creates one id, stores it, and reuses it across launches", async () => {
    const first = await freshLaunch().getDeviceId();
    const second = await freshLaunch().getDeviceId();
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second).toBe(first);
  });

  it("labels the device by model and OS, and sends both with the client marker", async () => {
    const { clientHeaders, getDeviceLabel } = freshLaunch();
    expect(getDeviceLabel()).toBe("Pixel 8 · Android 15");
    const headers = await clientHeaders();
    expect(headers["x-nexus-client"]).toBe("mobile-app");
    expect(headers["x-nexus-device-label"]).toBe("Pixel 8 · Android 15");
    expect(headers["x-nexus-device-id"]).toBeTruthy();
  });
});
