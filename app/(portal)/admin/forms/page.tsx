export default function AdminForms() {
  return (
    <div className="space-y-lg animate-[fade-in_0.3s_ease-out]">
      <div>
        <h1 className="text-2xl font-extrabold text-on-surface tracking-tight">Web Forms</h1>
        <p className="text-sm text-on-surface-variant mt-xs">Custom form builder for admissions, feedback, and surveys</p>
      </div>

      <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-sm p-2xl text-center">
        <div className="text-4xl mb-md">📋</div>
        <h2 className="text-sm font-bold text-on-surface mb-xs">Coming Soon</h2>
        <p className="text-sm text-on-surface-variant max-w-md mx-auto">
          The form builder module isn&apos;t wired up yet — it needs a dedicated schema (form definitions, fields,
          submissions) before it can go live. Flagging as a follow-up.
        </p>
      </div>
    </div>
  );
}
