"use client";

import { useState } from "react";
import { acceptInvitation } from "./actions";

export default function AcceptInviteForm() {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (password !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }

    setLoading(true);
    try {
      await acceptInvitation(password);
      // On success, acceptInvitation redirects server-side — this line
      // only runs if something upstream swallowed that redirect.
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-md">
      <div>
        <label htmlFor="password" className="block text-sm font-medium text-on-surface-variant mb-xs">
          Password
        </label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="At least 8 characters"
          required
          minLength={8}
          className="w-full bg-surface-container-low border border-outline-variant rounded-xl px-md py-md text-sm text-on-surface placeholder:text-outline focus:ring-2 focus:ring-secondary focus:border-secondary outline-none transition-all"
        />
      </div>

      <div>
        <label htmlFor="confirmPassword" className="block text-sm font-medium text-on-surface-variant mb-xs">
          Confirm password
        </label>
        <input
          id="confirmPassword"
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          placeholder="Re-enter your password"
          required
          minLength={8}
          className="w-full bg-surface-container-low border border-outline-variant rounded-xl px-md py-md text-sm text-on-surface placeholder:text-outline focus:ring-2 focus:ring-secondary focus:border-secondary outline-none transition-all"
        />
      </div>

      {error && (
        <div role="status" aria-live="polite" className="p-md rounded-xl text-sm font-medium bg-error-container text-on-error-container border border-error/20">
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={loading}
        className="w-full px-lg py-md bg-secondary text-on-secondary rounded-xl font-semibold text-sm hover:bg-secondary-container transition-colors disabled:opacity-50 shadow-md"
      >
        {loading ? "Setting up your account..." : "Set password & continue"}
      </button>
    </form>
  );
}
