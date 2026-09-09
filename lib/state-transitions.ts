/**
 * Pure, deterministic state-transition-graph enforcement — no DB access.
 *
 * Several workflow entities in this app only ever guarded against
 * re-applying the exact same status (an idempotency guard) — which still
 * let a caller jump backward or sideways to a status that makes no
 * business sense (e.g. marking a rejected placement application
 * "selected"). This gives an entity's actions.ts a single, unit-tested
 * place to declare "from this status, these are the only valid next
 * statuses" and enforce it consistently, rather than scattering ad hoc
 * if-chains. See app/(portal)/placement-cell/drives/actions.ts's
 * updateApplicationStatus for the first real caller.
 */

export type TransitionGraph<S extends string> = Readonly<Record<S, readonly S[]>>;

export function isValidTransition<S extends string>(graph: TransitionGraph<S>, from: S, to: S): boolean {
  return graph[from]?.includes(to) ?? false;
}

/**
 * Throws a clear, user-facing error if `to` isn't a valid next status from
 * `from` per `graph`. `entityLabel` names the entity in the message (e.g.
 * "application").
 */
export function assertValidTransition<S extends string>(
  graph: TransitionGraph<S>,
  from: S,
  to: S,
  entityLabel: string
): void {
  if (from === to) {
    throw new Error(`This ${entityLabel} is already marked ${to}.`);
  }
  if (!isValidTransition(graph, from, to)) {
    throw new Error(`Cannot move this ${entityLabel} from "${from}" to "${to}".`);
  }
}

export type PlacementApplicationStatus =
  | "applied"
  | "shortlisted"
  | "interview"
  | "selected"
  | "rejected"
  | "offer_declined";

/**
 * applied -> shortlisted -> interview -> selected -> offer_declined
 * (candidate declines the offer after being selected). "rejected" is
 * reachable from any non-terminal stage. "rejected" and "offer_declined"
 * are terminal — once a candidate is rejected or has declined, the
 * application cannot move again. This also closes a real data-integrity
 * gap: "selected" writes a row into the `placements` ledger, and moving
 * *off* selected afterward used to leave that row stranded with no
 * reversal, quietly corrupting placement-rate analytics.
 */
export const PLACEMENT_APPLICATION_TRANSITIONS: TransitionGraph<PlacementApplicationStatus> = {
  applied: ["shortlisted", "interview", "rejected"],
  shortlisted: ["interview", "rejected"],
  interview: ["selected", "rejected"],
  selected: ["offer_declined"],
  rejected: [],
  offer_declined: [],
};
