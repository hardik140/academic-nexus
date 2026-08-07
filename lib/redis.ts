import { Redis } from "@upstash/redis";

/**
 * Shared Upstash Redis client — HTTP-based, safe to call from any serverless
 * invocation with no connection-pool management.
 *
 * `null` when UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN aren't set
 * (e.g. Upstash hasn't been provisioned yet) rather than throwing at import
 * time — every caller (lib/cache.ts, lib/rate-limit.ts) treats a missing
 * client the same as a Redis-down error and fails open, so the app runs
 * correctly (just uncached/unlimited) before or during an Upstash outage.
 */
const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;

export const redis = url && token ? new Redis({ url, token }) : null;
