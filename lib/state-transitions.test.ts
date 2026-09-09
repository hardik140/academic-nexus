import { describe, it, expect } from "vitest";
import {
  isValidTransition,
  assertValidTransition,
  PLACEMENT_APPLICATION_TRANSITIONS,
  type TransitionGraph,
} from "@/lib/state-transitions";

type Light = "red" | "yellow" | "green";
const LIGHT_GRAPH: TransitionGraph<Light> = {
  red: ["green"],
  green: ["yellow"],
  yellow: ["red"],
};

describe("isValidTransition / assertValidTransition (generic)", () => {
  it("allows an edge declared in the graph", () => {
    expect(isValidTransition(LIGHT_GRAPH, "red", "green")).toBe(true);
    expect(() => assertValidTransition(LIGHT_GRAPH, "red", "green", "light")).not.toThrow();
  });

  it("rejects an edge not declared in the graph", () => {
    expect(isValidTransition(LIGHT_GRAPH, "red", "yellow")).toBe(false);
    expect(() => assertValidTransition(LIGHT_GRAPH, "red", "yellow", "light")).toThrow(
      /Cannot move this light from "red" to "yellow"/
    );
  });

  it("rejects re-applying the same status before checking the graph", () => {
    expect(() => assertValidTransition(LIGHT_GRAPH, "red", "red", "light")).toThrow(/already marked red/);
  });
});

describe("PLACEMENT_APPLICATION_TRANSITIONS", () => {
  it.each([
    ["applied", "shortlisted"],
    ["applied", "interview"],
    ["applied", "rejected"],
    ["shortlisted", "interview"],
    ["shortlisted", "rejected"],
    ["interview", "selected"],
    ["interview", "rejected"],
    ["selected", "offer_declined"],
  ] as const)("allows %s -> %s", (from, to) => {
    expect(isValidTransition(PLACEMENT_APPLICATION_TRANSITIONS, from, to)).toBe(true);
    expect(() => assertValidTransition(PLACEMENT_APPLICATION_TRANSITIONS, from, to, "application")).not.toThrow();
  });

  it.each([
    ["rejected", "selected"],
    ["selected", "applied"],
    ["offer_declined", "shortlisted"],
    ["shortlisted", "applied"],
    ["interview", "applied"],
  ] as const)("rejects the invalid jump %s -> %s", (from, to) => {
    expect(isValidTransition(PLACEMENT_APPLICATION_TRANSITIONS, from, to)).toBe(false);
    expect(() => assertValidTransition(PLACEMENT_APPLICATION_TRANSITIONS, from, to, "application")).toThrow();
  });

  it.each(["rejected", "offer_declined"] as const)("'%s' is terminal — no outgoing edges", (status) => {
    expect(PLACEMENT_APPLICATION_TRANSITIONS[status]).toHaveLength(0);
  });
});
