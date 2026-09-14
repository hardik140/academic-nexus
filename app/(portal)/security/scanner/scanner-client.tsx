"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { Button, FormField } from "@/components/ui/modal";
import { scanGatePass, securityScanFeed, type ScanFeedRow, type ScanResult } from "../actions";

/**
 * The gate scanner.
 *
 * Read the one rule first: nothing on this screen decides anything. The
 * camera turns a picture into a string, the string goes to the server, and
 * every word the guard reads afterwards came back from the database. There
 * is no local validation, no cached pass list, no "looks valid" state — a
 * scanner that could decide would be a scanner that could be made to decide
 * wrongly by anyone holding the device.
 *
 * DECODING
 *
 * Two paths, because one is not enough in a real gatehouse:
 *
 *   BarcodeDetector   native, hardware-accelerated, Chrome/Edge/Android.
 *                     Used when present.
 *   jsQR              a pure-JS fallback over a canvas frame, for Safari
 *                     and iOS, where BarcodeDetector still does not exist.
 *
 * And a third that is not a fallback but a requirement: MANUAL ENTRY. A
 * camera that will not focus in the dark, a cracked lens, a student whose
 * screen is too dim — the guard types the code and the server does exactly
 * the same thing with it. The manual path is not a weaker path; it reaches
 * the identical server action with the identical checks.
 *
 * ONE PRESENTATION, ONE REQUEST
 *
 * A decoder run against a live video fires 30-60 times a second and returns
 * the same string every time while the phone is in front of the lens. Each
 * of those is a candidate HTTP request. The cooldown below collapses a
 * physical presentation into a single server call, keyed on the payload, so
 * a student standing at the gate for fifteen seconds costs one request
 * rather than four. The server refuses duplicates regardless — this is a
 * load and legibility control, not a security one, and it is deliberately
 * DROPPED when a request fails so the guard can retry immediately.
 */

type Decoder = (video: HTMLVideoElement, canvas: HTMLCanvasElement) => Promise<string | null>;

interface NativeDetector {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}

function nativeDecoder(): Decoder | null {
  const ctor = (globalThis as unknown as {
    BarcodeDetector?: new (opts: { formats: string[] }) => NativeDetector;
  }).BarcodeDetector;
  if (!ctor) return null;
  const detector = new ctor({ formats: ["qr_code"] });
  return async (video) => {
    try {
      const found = await detector.detect(video);
      return found[0]?.rawValue ?? null;
    } catch {
      return null;
    }
  };
}

const canvasDecoder: Decoder = async (video, canvas) => {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return null;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, w, h);
  const image = ctx.getImageData(0, 0, w, h);
  const found = jsQR(image.data, w, h, { inversionAttempts: "dontInvert" });
  return found?.data ?? null;
};

/** One presentation of one QR costs one request for this long. */
const PAYLOAD_COOLDOWN_MS = 10_000;

/** Outcome -> how it should look and read at a gate, at a glance. */
const PRESENTATION: Record<string, { tone: "ok" | "warn" | "bad"; mark: string; headline: string }> = {
  RECORDED: { tone: "ok", mark: "✓", headline: "AUTHORIZED" },
  // The movement exists — recorded by the scan whose response this guard
  // never saw, or by the guard beside them. Operationally this is a PASS:
  // the ledger has the crossing, and the student may go. It reads green for
  // that reason, with the time so the guard can see it was a moment ago.
  ALREADY_RECORDED: { tone: "ok", mark: "✓", headline: "ALREADY RECORDED" },
  ALREADY_OUTSIDE: { tone: "warn", mark: "⚠", headline: "ALREADY OUTSIDE" },
  ALREADY_RETURNED: { tone: "warn", mark: "⚠", headline: "ALREADY RETURNED" },
  DUPLICATE_SCAN: { tone: "warn", mark: "⚠", headline: "JUST SCANNED" },
  NOT_YET_VALID: { tone: "warn", mark: "⚠", headline: "NOT YET VALID" },
  // Not a refusal and not a success: the request did not complete, so the
  // only honest thing the screen can say is that it does not know.
  UNCONFIRMED: { tone: "warn", mark: "?", headline: "NOT CONFIRMED" },
  INVALID_QR: { tone: "bad", mark: "✕", headline: "INVALID QR" },
  EXPIRED: { tone: "bad", mark: "✕", headline: "EXPIRED" },
  REVOKED: { tone: "bad", mark: "✕", headline: "REVOKED" },
  NOT_APPROVED: { tone: "bad", mark: "✕", headline: "NOT APPROVED" },
  PASS_REJECTED: { tone: "bad", mark: "✕", headline: "REJECTED" },
  UNAUTHORIZED_GATE: { tone: "bad", mark: "✕", headline: "UNAUTHORIZED GATE" },
  PERMISSION_DENIED: { tone: "bad", mark: "✕", headline: "NOT PERMITTED" },
  INVALID_MOVEMENT: { tone: "bad", mark: "✕", headline: "INVALID MOVEMENT" },
};

const TONE_CLASS = {
  ok: "bg-success/10 border-success/30 text-success",
  warn: "bg-warning/10 border-warning/30 text-warning",
  bad: "bg-error/10 border-error/30 text-error",
};

const BLANK: Omit<ScanResult, "outcome" | "detail"> = {
  movement: null,
  gatePassId: null,
  passCode: null,
  studentName: null,
  enrollmentNumber: null,
  destination: null,
  purpose: null,
  expectedReturn: null,
  occurredAt: null,
  gateName: null,
};

/**
 * Why getUserMedia said no, in words a guard can act on.
 *
 * The browser's own message is a DOMException name; the difference between
 * "you denied the permission" and "there is no camera on this machine"
 * decides whether the guard taps the address bar or switches to typing the
 * code, so it is worth spelling out.
 */
function cameraFailure(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Camera permission was denied for this site. Allow it in the browser's address bar, then press Scan QR again — or type the code below.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "No camera was found on this device. Type the code from the student's screen below.";
    case "NotReadableError":
      return "The camera is already in use by another app. Close it and try again, or type the code below.";
    default:
      return "The camera could not be started. Type the code from the student's screen below.";
  }
}

export function ScannerClient({ gates }: { gates: { id: string; code: string; name: string }[] }) {
  const [gateId, setGateId] = useState(gates[0]?.id ?? "");
  const [scanning, setScanning] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [manual, setManual] = useState("");
  const [feed, setFeed] = useState<ScanFeedRow[]>([]);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>("");

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const loopRef = useRef<number | null>(null);
  const gateIdRef = useRef(gateId);
  // In-flight guard. A ref and NOT the `busy` state: the decode loop closes
  // over `submit` once, at start(), so a state value read inside it is
  // frozen at whatever it was when the camera opened — the guard would be
  // permanently false and two students presenting in quick succession would
  // both be in flight at once. The ref is read live.
  const inFlightRef = useRef(false);
  // payload -> when we last sent it. Collapses a presentation into one
  // request; cleared for that payload if the request fails.
  const cooldownRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    gateIdRef.current = gateId;
  }, [gateId]);

  const refreshFeed = useCallback(async (gate: string) => {
    if (!gate) return;
    try {
      setFeed(await securityScanFeed(gate, 12));
    } catch {
      /* the feed is context, never the decision — a failure here is silent */
    }
  }, []);

  useEffect(() => {
    void refreshFeed(gateId);
  }, [gateId, refreshFeed]);

  const submit = useCallback(
    async (payload: string, source: "camera" | "manual") => {
      const gate = gateIdRef.current;
      if (!gate || !payload || inFlightRef.current) return;

      const now = Date.now();
      if (source === "camera") {
        const last = cooldownRef.current.get(payload);
        if (last !== undefined && now - last < PAYLOAD_COOLDOWN_MS) return;
        // Keep the map from growing for the length of a shift.
        if (cooldownRef.current.size > 64) cooldownRef.current.clear();
        cooldownRef.current.set(payload, now);
      }

      inFlightRef.current = true;
      setBusy(true);
      try {
        const outcome = await scanGatePass({
          payload,
          gateId: gate,
          device: { source, userAgent: navigator.userAgent.slice(0, 300) },
        });
        setResult(outcome);
        void refreshFeed(gate);
      } catch (e) {
        // The request did not complete. The movement may or may not have
        // been written — the server is the only thing that knows, and a
        // client that guesses here is exactly what section 34 forbids. Say
        // so, drop the cooldown so the next scan is allowed straight away,
        // and let that scan come back ALREADY RECORDED if it landed.
        cooldownRef.current.delete(payload);
        setResult({
          ...BLANK,
          outcome: "UNCONFIRMED",
          detail:
            e instanceof Error && /not configured/i.test(e.message)
              ? e.message
              : "The scan did not reach the server, so it is not known whether the movement was recorded. Scan the same QR again — if it was recorded, the next scan will say so.",
        });
      } finally {
        inFlightRef.current = false;
        setBusy(false);
      }
    },
    [refreshFeed]
  );

  const stop = useCallback(() => {
    if (loopRef.current !== null) {
      cancelAnimationFrame(loopRef.current);
      loopRef.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    // Without this the element keeps a reference to the stopped stream and
    // some browsers leave the camera indicator lit after a shift ends.
    if (videoRef.current) videoRef.current.srcObject = null;
    setScanning(false);
  }, []);

  const start = useCallback(
    async (preferredDeviceId?: string) => {
      setCameraError(null);

      // getUserMedia is undefined on an insecure origin, which is a
      // deployment fault and not a browser limitation — worth saying,
      // because "this browser cannot open a camera" would send the guard
      // looking for a different browser they will not find.
      if (typeof window !== "undefined" && !window.isSecureContext) {
        setCameraError(
          "Cameras are only available over HTTPS. This page was served over an insecure connection — tell your administrator, and type the code below in the meantime."
        );
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraError("This browser cannot open a camera. Type the code from the student's screen below.");
        return;
      }

      // Re-entrant by design: switching cameras calls start() again, and
      // the old stream has to be released or the device stays busy.
      stop();

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: preferredDeviceId
            ? { deviceId: { exact: preferredDeviceId } }
            : { facingMode: { ideal: "environment" } },
          audio: false,
        });
        streamRef.current = stream;

        const video = videoRef.current;
        if (!video) {
          // The component unmounted between the prompt and the grant. Give
          // the camera back rather than leaving the light on.
          stream.getTracks().forEach((t) => t.stop());
          streamRef.current = null;
          return;
        }

        video.srcObject = stream;
        try {
          await video.play();
        } catch {
          /* autoplay interrupted by a re-render; the loop below still reads frames */
        }
        setScanning(true);

        // Labels are only populated once permission has been granted, so
        // this is deliberately after getUserMedia and not before it.
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const videoInputs = devices.filter((d) => d.kind === "videoinput");
          setCameras(videoInputs);
          const active = stream.getVideoTracks()[0]?.getSettings().deviceId;
          if (active) setDeviceId(active);
        } catch {
          /* enumeration is a convenience; scanning works without it */
        }

        const decode = nativeDecoder() ?? canvasDecoder;
        const tick = async () => {
          const canvas = canvasRef.current;
          if (video.readyState === video.HAVE_ENOUGH_DATA && canvas && !inFlightRef.current) {
            const text = await decode(video, canvas);
            if (text) await submit(text, "camera");
          }
          loopRef.current = requestAnimationFrame(() => void tick());
        };
        loopRef.current = requestAnimationFrame(() => void tick());
      } catch (err) {
        setCameraError(cameraFailure(err));
        stop();
      }
    },
    [submit, stop]
  );

  // Release the camera when the gatehouse tab is backgrounded — the guard
  // is not scanning anyone, and a live stream is a lit indicator plus a
  // decode loop draining the battery of whatever is propped up at the gate.
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === "hidden") stop();
    };
    document.addEventListener("visibilitychange", onHidden);
    return () => document.removeEventListener("visibilitychange", onHidden);
  }, [stop]);

  useEffect(() => stop, [stop]);

  const presentation = result
    ? (PRESENTATION[result.outcome] ?? { tone: "bad" as const, mark: "✕", headline: "REFUSED" })
    : null;

  if (gates.length === 0) {
    return (
      <div className="bg-error/10 border border-error/20 text-error rounded-2xl p-lg text-sm font-medium">
        You are not assigned to an active gate. Ask the Director to assign one before starting a shift.
      </div>
    );
  }

  return (
    <div className="grid gap-lg lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="space-y-md">
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-lg space-y-md">
          <div className="flex items-end gap-md flex-wrap">
            <div className="min-w-[14rem]">
              <FormField
                label="Gate"
                id="scan-gate"
                type="select"
                value={gateId}
                onChange={(v) => { setGateId(v); setResult(null); }}
                options={gates.map((g) => ({ value: g.id, label: `${g.code} — ${g.name}` }))}
              />
            </div>
            <Button size="lg" onClick={() => (scanning ? stop() : void start())} disabled={!gateId}>
              {scanning ? "Stop camera" : "Scan QR"}
            </Button>
            {busy && <span className="text-xs font-semibold text-on-surface-variant pb-sm">Checking…</span>}
          </div>

          {scanning && cameras.length > 1 && (
            <div className="max-w-[20rem]">
              <FormField
                label="Camera"
                id="scan-camera"
                type="select"
                value={deviceId}
                onChange={(v) => { setDeviceId(v); void start(v); }}
                options={cameras.map((c, i) => ({
                  value: c.deviceId,
                  label: c.label || `Camera ${i + 1}`,
                }))}
              />
            </div>
          )}

          {cameraError && <p className="text-xs text-warning font-medium">{cameraError}</p>}

          <div className={scanning ? "relative rounded-xl overflow-hidden bg-black aspect-video" : "hidden"}>
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video ref={videoRef} className="w-full h-full object-cover" playsInline muted />
            <div className="absolute inset-0 pointer-events-none border-[3px] border-white/40 m-[12%] rounded-xl" />
          </div>
          <canvas ref={canvasRef} className="hidden" />

          <div className="flex items-end gap-sm">
            <div className="flex-1">
              <FormField
                label="Or type the code from the student's screen"
                id="scan-manual"
                value={manual}
                onChange={setManual}
                placeholder="ANGP1..."
              />
            </div>
            <Button
              variant="secondary"
              onClick={() => { void submit(manual.trim(), "manual"); setManual(""); }}
              disabled={!manual.trim() || !gateId || busy}
            >
              Check
            </Button>
          </div>
        </div>

        {result && presentation && (
          <div className={`rounded-2xl border p-lg ${TONE_CLASS[presentation.tone]}`} aria-live="assertive">
            <div className="flex items-baseline gap-sm">
              <span className="text-2xl leading-none">{presentation.mark}</span>
              <span className="text-lg font-extrabold tracking-tight">{presentation.headline}</span>
              {result.movement && (
                <span className="ml-auto text-sm font-bold">
                  {result.movement === "OUT" ? "EXIT RECORDED" : "RETURN RECORDED"}
                </span>
              )}
            </div>
            <p className="text-sm mt-sm opacity-90">{result.detail}</p>

            {result.studentName && (
              <dl className="mt-md grid grid-cols-2 gap-sm text-sm text-on-surface">
                <div>
                  <dt className="text-xs text-on-surface-variant">Student</dt>
                  <dd className="font-semibold">{result.studentName}</dd>
                </div>
                <div>
                  <dt className="text-xs text-on-surface-variant">Enrollment</dt>
                  <dd className="font-semibold">{result.enrollmentNumber}</dd>
                </div>
                <div>
                  <dt className="text-xs text-on-surface-variant">Pass</dt>
                  <dd className="font-semibold">{result.passCode}</dd>
                </div>
                <div>
                  <dt className="text-xs text-on-surface-variant">Destination</dt>
                  <dd className="font-semibold">{result.destination}</dd>
                </div>
                {result.expectedReturn && (
                  <div>
                    <dt className="text-xs text-on-surface-variant">Due back</dt>
                    <dd className="font-semibold">{new Date(result.expectedReturn).toLocaleString()}</dd>
                  </div>
                )}
                {result.occurredAt && (
                  <div>
                    <dt className="text-xs text-on-surface-variant">Recorded</dt>
                    <dd className="font-semibold tabular-nums">{new Date(result.occurredAt).toLocaleTimeString()}</dd>
                  </div>
                )}
              </dl>
            )}
          </div>
        )}
      </div>

      <aside className="bg-surface-container-lowest border border-outline-variant rounded-2xl">
        <div className="px-lg py-md border-b border-outline-variant">
          <h2 className="text-sm font-bold text-on-surface">Recent scans at this gate</h2>
        </div>
        <ul className="divide-y divide-outline-variant max-h-[32rem] overflow-y-auto">
          {feed.length === 0 && <li className="p-lg text-sm text-outline">Nothing recorded here yet today.</li>}
          {feed.map((m) => (
            <li key={m.movement_id} className="px-lg py-sm flex items-center gap-sm">
              <span
                className={`text-xs font-bold px-sm py-[2px] rounded-full ${
                  m.movement_type === "OUT" ? "bg-warning/15 text-warning" : "bg-success/15 text-success"
                }`}
              >
                {m.movement_type}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-on-surface truncate">{m.student_name}</div>
                <div className="text-xs text-outline truncate">
                  {m.pass_code} · {m.destination}
                  {m.is_override && " · manual"}
                </div>
              </div>
              <span className="text-xs text-outline tabular-nums shrink-0">
                {new Date(m.occurred_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
