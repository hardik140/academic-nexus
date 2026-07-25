export default function Loading() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-surface">
      <div className="flex flex-col items-center gap-md">
        <div className="w-12 h-12 rounded-2xl bg-secondary/10 flex items-center justify-center animate-pulse">
          <div className="w-6 h-6 rounded-lg bg-secondary animate-spin" />
        </div>
        <p className="text-sm text-on-surface-variant font-medium">
          Loading Academic Nexus...
        </p>
      </div>
    </div>
  );
}
