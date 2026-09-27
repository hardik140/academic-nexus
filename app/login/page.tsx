"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [mode, setMode] = useState<"sign-in" | "forgot-password">("sign-in");
  const supabase = createClient();

  const handleGoogleLogin = async () => {
    setLoading(true);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    });
    if (error) setMessage(error.message);
    setLoading(false);
  };

  const handlePasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMessage("");

    const { error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      setMessage(error.message);
      setLoading(false);
      return;
    }

    // signInWithPassword only sets the session cookie — it doesn't navigate
    // anywhere by itself. A hard reload (rather than router.push) ensures
    // the server re-reads the fresh cookie rather than serving a cached
    // pre-login response for "/". app/page.tsx then does the role-based
    // redirect server-side.
    window.location.href = "/";
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMessage("");

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=/auth/reset-password`,
    });

    if (error) {
      setMessage(error.message);
    } else {
      setMessage("Check your email for a password reset link.");
    }
    setLoading(false);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface p-md">
      {/* Background decoration */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -right-40 w-96 h-96 rounded-full bg-secondary/5 blur-3xl" />
        <div className="absolute -bottom-40 -left-40 w-96 h-96 rounded-full bg-secondary/5 blur-3xl" />
      </div>

      <div className="relative w-full max-w-[28rem]">
        {/* Logo & Title */}
        <div className="text-center mb-xl">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-secondary text-on-secondary mb-md shadow-lg">
            <svg
              aria-hidden="true"
              xmlns="http://www.w3.org/2000/svg"
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M22 10v6M2 10l10-5 10 5-10 5z" />
              <path d="M6 12v5c0 2 4 3 6 3s6-1 6-3v-5" />
            </svg>
          </div>
          <h1 className="text-3xl font-extrabold text-on-surface tracking-tight">
            Academic Nexus
          </h1>
          <p className="text-on-surface-variant mt-xs text-sm">
            Enterprise Student Information System
          </p>
        </div>

        {/* Login Card */}
        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-xl p-xl">
          <h2 className="text-xl font-bold text-on-surface mb-lg">
            {mode === "sign-in" ? "Sign in to your portal" : "Reset your password"}
          </h2>

          {mode === "sign-in" && (
            <>
              {/* Google OAuth */}
              <button
                onClick={handleGoogleLogin}
                disabled={loading}
                className="w-full flex items-center justify-center gap-sm px-lg py-md bg-surface-container-low border border-outline-variant rounded-xl font-medium text-on-surface hover:bg-surface-container-high transition-colors disabled:opacity-50"
              >
                <svg aria-hidden="true" className="w-5 h-5" viewBox="0 0 24 24">
                  <path
                    d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
                    fill="#4285F4"
                  />
                  <path
                    d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                    fill="#34A853"
                  />
                  <path
                    d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                    fill="#FBBC05"
                  />
                  <path
                    d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                    fill="#EA4335"
                  />
                </svg>
                Continue with Google
              </button>

              {/* Divider */}
              <div className="flex items-center gap-md my-lg">
                <div className="flex-1 h-px bg-outline-variant" />
                <span className="text-xs text-outline font-medium uppercase tracking-wider">
                  or
                </span>
                <div className="flex-1 h-px bg-outline-variant" />
              </div>

              {/* Email + password */}
              <form onSubmit={handlePasswordLogin} className="space-y-md">
                <div>
                  <label
                    htmlFor="email"
                    className="block text-sm font-medium text-on-surface-variant mb-xs"
                  >
                    Institutional Email
                  </label>
                  <input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@university.edu"
                    required
                    className="w-full bg-surface-container-low border border-border-control rounded-xl px-md py-md text-sm text-on-surface placeholder:text-outline focus:ring-2 focus:ring-secondary focus:border-secondary outline-none motion-feedback"
                  />
                </div>

                <div>
                  <label
                    htmlFor="password"
                    className="block text-sm font-medium text-on-surface-variant mb-xs"
                  >
                    Password
                  </label>
                  <input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Your password"
                    required
                    className="w-full bg-surface-container-low border border-border-control rounded-xl px-md py-md text-sm text-on-surface placeholder:text-outline focus:ring-2 focus:ring-secondary focus:border-secondary outline-none motion-feedback"
                  />
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full px-lg py-md bg-secondary text-on-secondary rounded-xl font-semibold text-sm hover:bg-secondary-container transition-colors disabled:opacity-50 shadow-md"
                >
                  {loading ? "Signing in..." : "Sign In"}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setMode("forgot-password");
                    setMessage("");
                  }}
                  className="w-full text-center text-sm text-secondary hover:underline"
                >
                  Forgot your password?
                </button>
              </form>
            </>
          )}

          {mode === "forgot-password" && (
            <form onSubmit={handleForgotPassword} className="space-y-md">
              <div>
                <label
                  htmlFor="reset-email"
                  className="block text-sm font-medium text-on-surface-variant mb-xs"
                >
                  Institutional Email
                </label>
                <input
                  id="reset-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@university.edu"
                  required
                  className="w-full bg-surface-container-low border border-border-control rounded-xl px-md py-md text-sm text-on-surface placeholder:text-outline focus:ring-2 focus:ring-secondary focus:border-secondary outline-none motion-feedback"
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full px-lg py-md bg-secondary text-on-secondary rounded-xl font-semibold text-sm hover:bg-secondary-container transition-colors disabled:opacity-50 shadow-md"
              >
                {loading ? "Sending..." : "Send Reset Link"}
              </button>

              <button
                type="button"
                onClick={() => {
                  setMode("sign-in");
                  setMessage("");
                }}
                className="w-full text-center text-sm text-secondary hover:underline"
              >
                Back to sign in
              </button>
            </form>
          )}

          {/* Status message */}
          {message && (
            <div
              role="status"
              aria-live="polite"
              className={`mt-md p-md rounded-xl text-sm font-medium ${
                message.includes("Check")
                  ? "bg-success/10 text-success border border-success/20"
                  : "bg-error-container text-on-error-container border border-error/20"
              }`}
            >
              {message}
            </div>
          )}
        </div>

        {/* Footer */}
        <p className="text-center text-xs text-outline mt-lg">
          Academic Nexus SIS v3.0 • Multi-Tenant Enterprise Platform
        </p>
      </div>
    </div>
  );
}
