// Route-level loading skeleton for the owner status portal. The page blocks on
// a backend fetch (force-dynamic), so without this the owner stares at a blank
// screen. Pure presentation: neutral pulsing blocks that mirror the page grid.
export default function OwnerStatusLoading() {
  return (
    <main className="min-h-screen bg-background px-4 py-6 text-foreground sm:px-6 lg:px-8">
      <div className="mx-auto max-w-5xl animate-pulse space-y-6" aria-label="Loading property status" role="status">
        <div className="h-36 rounded-2xl border bg-card" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="h-28 rounded-xl bg-muted/40" />
          <div className="h-28 rounded-xl bg-muted/40" />
          <div className="h-28 rounded-xl bg-muted/40" />
          <div className="h-28 rounded-xl bg-muted/40" />
        </div>
        <div className="h-32 rounded-xl bg-muted/40" />
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <div className="h-64 rounded-xl bg-muted/40" />
          <div className="h-64 rounded-xl bg-muted/40" />
        </div>
      </div>
    </main>
  );
}
