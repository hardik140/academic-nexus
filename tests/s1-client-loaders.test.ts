import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAsyncResourceController, INITIAL_ASYNC_STATE, type AsyncLoader, type AsyncResourceState } from "@/lib/async-resource";
import { StateView, type StateViewProps } from "@/components/ui/state-view";

const h = vi.hoisted(() => ({
  state: { status: "loading", data: undefined, error: undefined } as AsyncResourceState<unknown>,
  loader: undefined as AsyncLoader<unknown> | undefined,
  reload: () => {},
  briefing: vi.fn(), hostel: vi.fn(), health: vi.fn(), institution: vi.fn(), drives: vi.fn(),
}));
vi.mock("@/hooks/use-async-resource", () => ({ useAsyncResource: (load: AsyncLoader<unknown>) => {
  h.loader = load;
  return { ...h.state, reload: h.reload };
} }));
vi.mock("@/app/(portal)/director/briefing/actions", () => ({ getExecutiveBriefing: h.briefing }));
vi.mock("@/app/(portal)/director/hostel/actions", () => ({ getHostelRollup: h.hostel }));
vi.mock("@/app/(portal)/director/departments/performance/actions", () => ({ listDepartmentHealth: h.health }));
vi.mock("@/app/(portal)/director/placements/funnel/actions", () => ({ getInstitutionPlacementFunnel: h.institution, listDriveFunnels: h.drives }));
vi.mock("@/components/charts/donut-chart", () => ({ DonutChart: () => null }));
vi.mock("@/components/charts/placement-funnel-chart", () => ({ PlacementFunnelChart: () => null }));

import Briefing from "@/app/(portal)/director/briefing/page";
import Hostel from "@/app/(portal)/director/hostel/page";
import Performance from "@/app/(portal)/director/departments/performance/page";
import Funnel from "@/app/(portal)/director/placements/funnel/page";

const emptyBriefing = { latestSnapshot: null, generatedAt: "2026-09-29T00:00:00Z", hasComparison: false, kpiChanges: [], positives: [], risks: [], decisionsWaiting: [], upcomingDeadlines: [], recommendedActions: [], escalationsInProgress: 0 };
const emptyHostel = { blocks: [], totalBlocks: 0, totalCapacity: 0, totalOccupancy: 0, occupancyPct: null, pendingGatePasses: 0, openComplaints: 0 };
const emptyInstitution = { departments: [], totals: { total_students: 0, eligible_count: 0, applied_count: 0, shortlisted_count: 0, selected_count: 0, placed_count: 0 } };

beforeEach(() => {
  vi.clearAllMocks();
  h.state = INITIAL_ASYNC_STATE;
  h.loader = undefined;
  h.reload = () => {};
  h.briefing.mockResolvedValue(emptyBriefing);
  h.hostel.mockResolvedValue(emptyHostel);
  h.health.mockResolvedValue([]);
  h.institution.mockResolvedValue(emptyInstitution);
  h.drives.mockResolvedValue([]);
});

function findView(node: ReactNode): ReactElement<StateViewProps<unknown>> | undefined {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) return node.map(findView).find(Boolean);
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (element.type === StateView) return element as unknown as ReactElement<StateViewProps<unknown>>;
  return findView(element.props?.children);
}

const cases = [
  { name: "briefing", Page: Briefing, action: h.briefing, empty: "No briefing yet", data: { ...emptyBriefing, latestSnapshot: { overall_score: 80 } } },
  { name: "hostel", Page: Hostel, action: h.hostel, empty: "No hostel data yet", data: { ...emptyHostel, pendingGatePasses: 1 } },
  { name: "performance", Page: Performance, action: h.health, empty: "No departments yet", data: [{ departmentId: "d", departmentName: "Science", departmentCode: "SCI", attendancePct: 80, backlogRate: 0, feeCollectionPct: 90, placementRate: 70, openRiskCount: 0 }] },
  { name: "funnel", Page: Funnel, action: h.institution, empty: "No placement data yet", data: { ...emptyInstitution, departments: [{ department_id: "d", department_name: "Science", total_students: 1 }] } },
];

for (const { name, Page, action, empty, data } of cases) {
  describe(`D5 ${name} loader`, () => {
    const render = () => renderToStaticMarkup(createElement(Page));
    it("renders loading, failed read, retry, legitimate empty, then records", async () => {
      expect(render()).toContain('data-view="loading"');
      action.mockRejectedValueOnce(new Error('relation "secret_internal_table" does not exist'));
      const controller = createAsyncResourceController(h.loader!, (state) => { h.state = state; });
      h.reload = () => controller.run();
      controller.run();
      await vi.waitFor(() => expect(h.state.status).toBe("error"));
      const failed = render();
      expect(failed).toContain('data-view="error"');
      expect(failed).toContain("Try again");
      expect(failed).not.toContain(empty);
      expect(failed).not.toContain("secret_internal_table");
      // Use the retry wired by the actual page into StateView.
      const view = findView(Page());
      expect(view).toBeDefined();
      view!.props.state.reload!();
      await vi.waitFor(() => expect(h.state.status).toBe("success"));
      expect(render()).toContain('data-view="empty"');
      expect(render()).toContain(empty);
      action.mockResolvedValue(data);
      h.reload();
      await vi.waitFor(() => expect(h.state.status).toBe("success"));
      expect(render()).toContain('data-view="data"');
      expect(render()).not.toContain(empty);
      controller.dispose();
    });
  });
}

it("funnel rejects a failed drives read even if the institution read succeeds", async () => {
  renderToStaticMarkup(createElement(Funnel));
  h.drives.mockRejectedValueOnce(new Error("Read failed"));
  const controller = createAsyncResourceController(h.loader!, (state) => { h.state = state; });
  controller.run();
  await vi.waitFor(() => expect(h.state.status).toBe("error"));
  expect(renderToStaticMarkup(createElement(Funnel))).toContain('data-view="error"');
  controller.dispose();
});
