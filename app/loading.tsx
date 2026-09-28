export default function Loading() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-surface">
      <div className="flex flex-col items-center gap-md">
        {/* Static by design (Checkpoint 4, M3): the route is loading, not
            doing measurable work, so nothing pulses or spins. */}
        <div className="w-12 h-12 rounded-2xl bg-secondary/10 flex items-center justify-center text-secondary">
          <svg
            aria-hidden="true"
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
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
        <p className="text-sm text-on-surface-variant font-medium">
          Loading Academic Nexus...
        </p>
      </div>
    </div>
  );
}
