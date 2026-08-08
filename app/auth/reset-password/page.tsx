import ResetPasswordForm from "./ResetPasswordForm";

export default function ResetPasswordPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-surface p-md">
      <div className="relative w-full max-w-md min-w-[320px]">
        <div className="text-center mb-xl">
          <h1 className="text-3xl font-extrabold text-on-surface tracking-tight">
            Reset your password
          </h1>
          <p className="text-on-surface-variant mt-xs text-sm">Choose a new password for your account</p>
        </div>

        <div className="bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-xl p-xl">
          <ResetPasswordForm />
        </div>
      </div>
    </div>
  );
}
