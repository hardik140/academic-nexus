/** Default cap for list queries that don't otherwise paginate, so a growing
 * college doesn't silently pull an entire high-traffic table into the browser. */
export const DEFAULT_QUERY_LIMIT = 500;
