/**
 * One-off operational script — run manually, never in CI.
 *
 * With self-service signup removed entirely (see the auth/RBAC redesign
 * plan), nothing in the app can invite the very first super_admin — there's
 * no one to invite them. This creates that account directly via the
 * service-role Admin API, with the operator running the script entering
 * their own password interactively (never a CLI arg or log line). Run this
 * exactly once per environment.
 *
 * Usage: npm run bootstrap-super-admin
 */
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { prompt, promptHidden } from "./lib/prompt";

dotenv.config({ path: ".env.local" });

const PLATFORM_COLLEGE_ID = "00000000-0000-0000-0000-000000000000";

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local.");
    process.exit(1);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log("Bootstrap the first Super Admin account.\n");

  // SUPER_ADMIN_* env vars are an opt-in convenience for local/dev use —
  // skips the interactive prompts entirely when all three are set. Prefer
  // the interactive prompts for anything beyond local dev: an env var
  // still means the password sits in a plaintext file on disk.
  const envEmail = process.env.SUPER_ADMIN_EMAIL;
  const envPassword = process.env.SUPER_ADMIN_PASSWORD;
  const envFullName = process.env.SUPER_ADMIN_FULL_NAME;

  let email: string;
  let fullName: string;
  let password: string;

  if (envEmail && envPassword) {
    console.log(`Using SUPER_ADMIN_EMAIL/SUPER_ADMIN_PASSWORD from .env.local (email: ${envEmail}).`);
    email = envEmail;
    fullName = envFullName || "Super Admin";
    password = envPassword;
  } else {
    email = await prompt("Email: ");
    fullName = await prompt("Full name: ");
    const promptedPassword = await promptHidden("Password (min 8 chars, not shown as you type): ");
    const confirmPassword = await promptHidden("Confirm password: ");
    if (promptedPassword !== confirmPassword) {
      console.error("\nPasswords don't match. Aborting.");
      process.exit(1);
    }
    password = promptedPassword;
  }

  if (password.length < 8) {
    console.error("\nPassword must be at least 8 characters. Aborting.");
    process.exit(1);
  }
  if (!email || !fullName) {
    console.error("\nEmail and full name are required. Aborting.");
    process.exit(1);
  }

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      full_name: fullName,
      role: "super_admin",
      college_id: PLATFORM_COLLEGE_ID,
      status: "active",
    },
  });

  if (error || !data.user) {
    console.error("\nFailed to create super_admin:", error?.message);
    process.exit(1);
  }

  // handle_new_user() no longer honours role/status from user_metadata
  // (migration 043 — it was a client-forgeable path to an admin account), so
  // every new profile lands as an inert pending student. Promote it here,
  // through the service-role client, which migration 042's trigger exempts.
  const { error: promoteErr } = await admin
    .from("profiles")
    .update({ role: "super_admin", status: "active" })
    .eq("id", data.user.id);

  if (promoteErr) {
    console.error(
      `\nAccount ${email} was created but could not be promoted to super_admin: ${promoteErr.message}` +
        `\nFix it with:  UPDATE public.profiles SET role='super_admin', status='active' WHERE id='${data.user.id}';`
    );
    process.exit(1);
  }

  console.log(`\nSuper Admin created: ${email} (${data.user.id}). Sign in at /login.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
