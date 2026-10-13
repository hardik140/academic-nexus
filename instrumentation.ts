import type { Instrumentation } from "next";
import { reportServerError } from "@/lib/observability/server-report";

// Every server-side failure Next.js captures: renders, Route Handlers,
// Server Actions, proxy. Awaited, as Next requires; never throws.
export const onRequestError: Instrumentation.onRequestError = (err, request, context) =>
  reportServerError(err, request, context);
