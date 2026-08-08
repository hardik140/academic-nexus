/** Default cap for list queries that don't otherwise paginate, so a growing
 * college doesn't silently pull an entire high-traffic table into the browser. */
export const DEFAULT_QUERY_LIMIT = 500;

/** The one non-tenant "colleges" row super_admin profiles belong to (they
 * aren't scoped to any real college — see migration 018). Never used as a
 * college_id filter for actual tenant data. */
export const PLATFORM_COLLEGE_ID = "00000000-0000-0000-0000-000000000000";
