/**
 * One-off operational script — run manually, never in CI.
 *
 * Every account created before this redesign is passwordless (Google OAuth
 * or the now-removed email magic link). This sends each active account a
 * "set your password" email via the same public reset flow a user would
 * trigger themselves from the login page's "Forgot password" link, so they
 * can sign in with a password afterward.
 *
 * SHARP EDGE: Supabase's default mailer has a low rate limit (roughly a
 * handful of emails/hour without custom SMTP configured in the Supabase
 * dashboard). Configure custom SMTP before running this against more than a
 * couple of accounts — otherwise most of these will silently queue or fail.
 *
 * Usage: npm run cutover-password-reset
 */
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { getPublicAppUrl } from "../lib/app-url";
import { prompt } from "./lib/prompt";

dotenv.config({ path: ".env.local" });

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  let appUrl: string;

  try {
    appUrl = getPublicAppUrl();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }

  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    console.error("Missing Supabase env vars in .env.local.");
    process.exit(1);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  // resetPasswordForEmail is a public Auth method — deliberately using the
  // anon-key client for it, not the service-role one.
  const anon = createClient(supabaseUrl, anonKey);

  const { data: profiles, error } = await admin
    .from("profiles")
    .select("email, full_name")
    .eq("status", "active");

  if (error) {
    console.error("Failed to list active profiles:", error.message);
    process.exit(1);
  }
  if (!profiles || profiles.length === 0) {
    console.log("No active profiles found.");
    return;
  }

  console.log(`About to send a password-reset email to ${profiles.length} account(s):`);
  for (const p of profiles) {
    console.log(`  - ${p.full_name} <${p.email}>`);
  }

  const confirm = await prompt(
    `\nMake sure custom SMTP is configured in the Supabase dashboard first (see the sharp edge above).\nType "yes" to proceed: `
  );
  if (confirm.toLowerCase() !== "yes") {
    console.log("Aborted.");
    return;
  }

  let sent = 0;
  let failed = 0;
  for (const p of profiles) {
    const { error: resetErr } = await anon.auth.resetPasswordForEmail(p.email, {
      redirectTo: `${appUrl}/auth/callback?next=/auth/reset-password`,
    });
    if (resetErr) {
      console.error(`  FAILED: ${p.email} — ${resetErr.message}`);
      failed++;
    } else {
      console.log(`  sent: ${p.email}`);
      sent++;
    }
  }

  console.log(`\nDone. ${sent} sent, ${failed} failed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
