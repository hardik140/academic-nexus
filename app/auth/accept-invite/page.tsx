import { createClient } from "@/lib/supabase/server";
import AcceptInviteForm from "./AcceptInviteForm";

const ROLE_LABELS: Record<string, string> = {
  student: "Student",
  teacher: "Teacher",
  hod: "HOD",
  finance: "Finance",
  director: "Director",
  admin: "College Admin",
  warden: "Warden",
  super_admin: "Super Admin",
};

export default async function AcceptInvitePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return (
      <InviteMessage
        title="This link has expired"
        message="Open the invitation email again, or ask whoever invited you to resend it."
      />
    );
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, email, role, college_id, status")
    .eq("id", user.id)
    .single();

  if (!profile) {
    return (
      <InviteMessage
        title="No invitation found"
        message="This account doesn't have a pending invitation."
      />
    );
  }

  if (profile.status !== "pending") {
    return (
      <InviteMessage
        title="Already accepted"
        message="This invitation has already been accepted. Sign in normally instead."
        linkHref="/login"
        linkLabel="Go to sign in"
      />
    );
  }

  const { data: college } = await supabase
    .from("colleges")
    .select("name")
    .eq("id", profile.college_id)
    .single();

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface p-md">
      <div className="relative w-full max-w-[28rem]">
        <div className="text-center mb-xl">
          <h1 className="text-3xl font-extrabold text-on-surface tracking-tight">
            Welcome to Academic Nexus
          </h1>
          <p className="text-on-surface-variant mt-xs text-sm">
            You&apos;ve been invited as {ROLE_LABELS[profile.role] ?? profile.role}
            {college ? ` at ${college.name}` : ""}
          </p>
        </div>

        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-xl p-xl">
          <h2 className="text-xl font-bold text-on-surface mb-lg">Set your password</h2>
          <AcceptInviteForm />
        </div>
      </div>
    </div>
  );
}

function InviteMessage({
  title,
  message,
  linkHref,
  linkLabel,
}: {
  title: string;
  message: string;
  linkHref?: string;
  linkLabel?: string;
}) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-surface p-md">
      <div className="w-full max-w-[28rem] bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-xl p-xl text-center">
        <h1 className="text-xl font-bold text-on-surface mb-sm">{title}</h1>
        <p className="text-on-surface-variant text-sm">{message}</p>
        {linkHref && linkLabel && (
          <a
            href={linkHref}
            className="inline-block mt-lg px-lg py-md bg-secondary text-on-secondary rounded-xl font-semibold text-sm hover:bg-secondary-container transition-colors"
          >
            {linkLabel}
          </a>
        )}
      </div>
    </div>
  );
}
