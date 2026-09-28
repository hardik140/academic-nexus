import { describe, expect, it } from "vitest";
import { createAsyncResourceController, INITIAL_ASYNC_STATE, type AsyncResourceState } from "@/lib/async-resource";

// The state machine behind useAsyncResource. The hook itself is verified in a
// real browser through the component gallery (e2e/gallery.spec.ts).

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness<T>(loader: (signal: AbortSignal) => Promise<T>) {
  const states: AsyncResourceState<T>[] = [];
  const signals: AbortSignal[] = [];
  const controller = createAsyncResourceController<T>((signal) => {
    signals.push(signal);
    return loader(signal);
  }, (s) => states.push(s));
  return { controller, states, signals, last: () => states[states.length - 1] };
}

describe("async resource controller", () => {
  it("starts from loading with no data", () => {
    expect(INITIAL_ASYNC_STATE).toEqual({ status: "loading", data: undefined, error: undefined });
    const d = deferred<string[]>();
    const h = harness(() => d.promise);
    h.controller.run();
    expect(h.last()).toEqual({ status: "loading", data: undefined, error: undefined });
  });

  it("loading → success carries the data, including a genuinely empty result", async () => {
    const h = harness(async () => [] as string[]);
    h.controller.run();
    await flush();
    expect(h.states.map((s) => s.status)).toEqual(["loading", "success"]);
    expect(h.last()).toEqual({ status: "success", data: [], error: undefined });
  });

  it("a rejected load ends in error — never in success with empty data", async () => {
    const failure = new Error("database unavailable");
    const h = harness<string[]>(async () => {
      throw failure;
    });
    h.controller.run();
    await flush();
    expect(h.states.map((s) => s.status)).toEqual(["loading", "error"]);
    expect(h.last()).toEqual({ status: "error", data: undefined, error: failure });
  });

  it("a loader that throws synchronously is reported as an error, not thrown", async () => {
    const h = harness<string[]>(() => {
      throw new Error("sync failure");
    });
    expect(() => h.controller.run()).not.toThrow();
    await flush();
    expect(h.last().status).toBe("error");
  });

  it("reload goes back through loading, keeping the last good data until it resolves", async () => {
    let call = 0;
    const second = deferred<string[]>();
    const h = harness(() => (++call === 1 ? Promise.resolve(["a"]) : second.promise));
    h.controller.run();
    await flush();
    h.controller.run();
    expect(h.last()).toEqual({ status: "loading", data: ["a"], error: undefined });
    second.resolve(["a", "b"]);
    await flush();
    expect(h.last()).toEqual({ status: "success", data: ["a", "b"], error: undefined });
  });

  it("a failed reload reports the error and keeps the last good data alongside it", async () => {
    let call = 0;
    const failure = new Error("timeout");
    const h = harness(() => (++call === 1 ? Promise.resolve(["a"]) : Promise.reject(failure)));
    h.controller.run();
    await flush();
    h.controller.run();
    await flush();
    expect(h.last()).toEqual({ status: "error", data: ["a"], error: failure });
  });

  it("stale result protection: a superseded load that resolves later is ignored", async () => {
    const slow = deferred<string>();
    const fast = deferred<string>();
    let call = 0;
    const h = harness(() => (++call === 1 ? slow.promise : fast.promise));
    h.controller.run();
    await flush(); // the slow load is now in flight
    h.controller.run();
    fast.resolve("fast");
    await flush();
    slow.resolve("slow");
    await flush();
    expect(h.last()).toEqual({ status: "success", data: "fast", error: undefined });
    expect(h.states.filter((s) => s.status === "success")).toHaveLength(1);
  });

  it("stale result protection: a superseded load that fails later is ignored too", async () => {
    const slow = deferred<string>();
    let call = 0;
    const h = harness(() => (++call === 1 ? slow.promise : Promise.resolve("fresh")));
    h.controller.run();
    await flush(); // the slow load is now in flight
    h.controller.run();
    await flush();
    slow.reject(new Error("late failure"));
    await flush();
    expect(h.last()).toEqual({ status: "success", data: "fresh", error: undefined });
  });

  it("aborts the signal of an in-flight load when it is superseded", async () => {
    const h = harness(() => new Promise<string>(() => {}));
    h.controller.run();
    await flush();
    h.controller.run();
    await flush();
    expect(h.signals).toHaveLength(2);
    expect(h.signals[0].aborted).toBe(true);
    expect(h.signals[1].aborted).toBe(false);
  });

  it("never invokes a load that is superseded before it starts", async () => {
    let calls = 0;
    const h = harness(async () => ++calls);
    h.controller.run();
    h.controller.run();
    h.controller.run();
    await flush();
    expect(calls).toBe(1);
    expect(h.last()).toEqual({ status: "success", data: 1, error: undefined });
  });

  it("never invokes a load that is disposed before it starts", async () => {
    const h = harness(async () => "never");
    h.controller.run();
    h.controller.dispose();
    await flush();
    expect(h.signals).toHaveLength(0);
    expect(h.states).toHaveLength(1);
  });

  it("after dispose, results are ignored, the in-flight load is aborted, and run() is a no-op", async () => {
    const d = deferred<string>();
    const h = harness(() => d.promise);
    h.controller.run();
    await flush();
    h.controller.dispose();
    expect(h.signals[0].aborted).toBe(true);
    d.resolve("too late");
    await flush();
    h.controller.run();
    expect(h.states).toHaveLength(1);
    expect(h.last().status).toBe("loading");
  });
});
