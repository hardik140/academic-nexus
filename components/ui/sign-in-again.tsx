"use client";

import { usePathname } from "next/navigation";
import { signInHref } from "@/lib/auth/safe-redirect";
import { cn } from "@/lib/utils";

/**
 * "Sign in again", after a session has expired (M6). A plain link in the
 * same tab to /login?next=<this page>, so signing in returns the user here.
 * The page's query string is added when the link is used, so the link's
 * server and client markup agree.
 *
 * `next` is checked by lib/auth/safe-redirect.ts before it is written, and
 * again by the login page before it is followed. Whether the user may see
 * the page they return to is still decided when it loads.
 */
export function SignInAgainLink({ className }: { className?: string }) {
  const pathname = usePathname() ?? "/";
  return (
    <a
      href={signInHref(pathname)}
      onClick={(e) => {
        e.currentTarget.href = signInHref(`${window.location.pathname}${window.location.search}`);
      }}
      className={cn(
        "motion-feedback inline-flex items-center rounded-control border border-border-control bg-surface-container-lowest px-sm py-xs text-sm font-medium text-on-surface hover:bg-surface-container-high",
        className
      )}
    >
      Sign in again
    </a>
  );
}
