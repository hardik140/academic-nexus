/**
 * The toast queue (M6.2), free of React so it is unit-tested in Node.
 * components/ui/toast.tsx renders it and drives its clock.
 *
 * Rules (M6 decision 3):
 *   • success and info only — there is no error toast: an error belongs
 *     next to what failed (Alert, ErrorState), where it stays;
 *   • at most MAX_VISIBLE on screen; further toasts wait their turn, none
 *     is dropped;
 *   • a duplicate — the same `id`, or the same text — does not stack: the
 *     toast already shown starts its time again (a waiting one is left as is);
 *   • each is shown for at least MIN_DURATION_MS, longer for longer text;
 *   • time only passes while the queue is not paused (the provider pauses it
 *     while a toast is hovered or focused, while the tab is hidden, and
 *     while a modal dialog is open).
 */

export type ToastTone = "success" | "info";

export interface ToastInput {
  tone: ToastTone;
  message: string;
  /** A stable identity: a second toast with the same id is a duplicate. */
  id?: string;
}

export interface QueuedToast {
  id: string;
  /** What duplicates are recognised by: the id if given, else the normalised text. */
  key: string;
  tone: ToastTone;
  message: string;
  /** How long it is shown, in ms of unpaused time. */
  duration: number;
  /** How much of that is left. */
  remaining: number;
}

export interface ToastQueue {
  visible: QueuedToast[];
  waiting: QueuedToast[];
}

export const MAX_VISIBLE = 3;
export const MIN_DURATION_MS = 6000;
/** Reading time on top of the minimum: 60ms a character past the first 100. */
const MS_PER_EXTRA_CHARACTER = 60;
const MAX_DURATION_MS = 15000;

export const EMPTY_QUEUE: ToastQueue = { visible: [], waiting: [] };

export function durationFor(message: string): number {
  const extra = Math.max(0, message.length - 100) * MS_PER_EXTRA_CHARACTER;
  return Math.min(MAX_DURATION_MS, MIN_DURATION_MS + extra);
}

export function normalise(message: string): string {
  return message.trim().replace(/\s+/g, " ").toLowerCase();
}

export function keyFor(input: ToastInput): string {
  return input.id !== undefined ? `id:${input.id}` : `text:${normalise(input.message)}`;
}

/** Adds a toast, or restarts the one it duplicates. `newId` names a new toast. */
export function addToast(queue: ToastQueue, input: ToastInput, newId: string): ToastQueue {
  const message = input.message.trim();
  if (!message) return queue;
  const key = keyFor(input);

  const shown = queue.visible.find((t) => t.key === key);
  if (shown) {
    const duration = durationFor(message);
    return {
      ...queue,
      visible: queue.visible.map((t) => (t === shown ? { ...t, message, tone: input.tone, duration, remaining: duration } : t)),
    };
  }
  if (queue.waiting.some((t) => t.key === key)) return queue;

  const duration = durationFor(message);
  const toast: QueuedToast = { id: input.id ?? newId, key, tone: input.tone, message, duration, remaining: duration };
  return queue.visible.length < MAX_VISIBLE
    ? { ...queue, visible: [...queue.visible, toast] }
    : { ...queue, waiting: [...queue.waiting, toast] };
}

/** Removes a toast (shown or waiting); the first waiting one takes a free place. */
export function dismissToast(queue: ToastQueue, id: string): ToastQueue {
  const visible = queue.visible.filter((t) => t.id !== id);
  const waiting = queue.waiting.filter((t) => t.id !== id);
  const free = MAX_VISIBLE - visible.length;
  return { visible: [...visible, ...waiting.slice(0, free)], waiting: waiting.slice(free) };
}

/** Lets `ms` of unpaused time pass: shown toasts whose time is up leave. */
export function elapse(queue: ToastQueue, ms: number): ToastQueue {
  if (ms <= 0) return queue;
  let next: ToastQueue = { ...queue, visible: queue.visible.map((t) => ({ ...t, remaining: t.remaining - ms })) };
  for (const t of next.visible) {
    if (t.remaining <= 0) next = dismissToast(next, t.id);
  }
  return next;
}

/** Time until the next shown toast is due to leave, or null if none is shown. */
export function nextDeadline(queue: ToastQueue): number | null {
  if (queue.visible.length === 0) return null;
  return Math.max(0, Math.min(...queue.visible.map((t) => t.remaining)));
}
