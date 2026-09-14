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

/** Outcome -> how it should look and read at a gate, at a glance. */
const PRESENTATION: Record<string, { tone: "ok" | "warn" | "bad"; mark: string; headline: string }> = {
  RECORDED: { tone: "ok", mark: "✓", headline: "AUTHORIZED" },
  ALREADY_OUTSIDE: { tone: "warn", mark: "⚠", headline: "ALREADY OUTSIDE" },
  ALREADY_RETURNED: { tone: "warn", mark: "⚠", headline: "ALREADY RETURNED" },
  DUPLICATE_SCAN: { tone: "warn", mark: "⚠", headline: "JUST SCANNED" },
  NOT_YET_VALID: { tone: "warn", mark: "⚠", headline: "NOT YET VALID" },
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

export function ScannerClient({ gates }: { gates: { id: string; code: string; name: string }[] }) {
  const [gateId, setGateId] = useState(gates[0]?.id ?? "");
  const [scanning, setScanning] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [manual, setManual] = useState("");
  const [feed, setFeed] = useState<ScanFeedRow[]>([]);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const loopRef = useRef<number | null>(null);
  // Guards against the same physical presentation firing several server
  // calls while the QR is still in frame. The server refuses the duplicate
  // anyway (050 §12) — this only stops the guard's screen flickering
  // between "authorized" and "just scanned" thirty times a second.
  const lastSentRef = useRef<{ payload: string; at: number } | null>(null);

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
      if (!gateId || busy) return;
      const now = Date.now();
      if (source === "camera" && lastSentRef.current?.payload === payload && now - lastSentRef.current.at < 4000) return;
      lastSentRef.current = { payload, at: now };

      setBusy(true);
      try {
        const outcome = await scanGatePass({
          payload,
          gateId,
          device: { source, userAgent: navigator.userAgent.slice(0, 300) },
        });
        setResult(outcome);
        void refreshFeed(gateId);
      } catch (e) {
        setResult({
          outcome: "ERROR",
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
          detail: e instanceof Error ? e.message : "The scan could not be completed.",
        });
      } finally {
        setBusy(false);
      }
    },
    [gateId, busy, refreshFeed]
  );

  const stop = useCallback(() => {
    if (loopRef.current !== null) {
      cancelAnimationFrame(loopRef.current);
      loopRef.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setScanning(false);
  }, []);

  const start = useCallback(async () => {
    setCameraError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError("This browser cannot open a camera. Type the code below instead.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play();
      setScanning(true);

      const decode = nativeDecoder() ?? canvasDecoder;
      const tick = async () => {
        const canvas = canvasRef.current;
        if (video.readyState === video.HAVE_ENOUGH_DATA && canvas) {
          const text = await decode(video, canvas);
          if (text) await submit(text, "camera");
        }
        loopRef.current = requestAnimationFrame(() => void tick());
      };
      loopRef.current = requestAnimationFrame(() => void tick());
    } catch {
      setCameraError("Camera access was refused. Type the code below instead.");
    }
  }, [submit]);

  useEffect(() => stop, [stop]);

  const presentation = result ? (PRESENTATION[result.outcome] ?? { tone: "bad" as const, mark: "✕", headline: "REFUSED" }) : null;

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
          </div>

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
          <div className={`rounded-2xl border p-lg ${TONE_CLASS[presentation.tone]}`} aria-live="polite">
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
