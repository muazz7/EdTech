/**
 * Placeholder root. The real catalog lands in Phase 3 (Section 21.2); this
 * exists so `npm run dev` boots and the token layer is visible while Phase 0
 * work is verified.
 */
export default function Home() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <p className="text-sm font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">
        Phase 0 — Foundations
      </p>
      <h1 className="mt-2 text-3xl font-semibold text-[var(--color-foreground)]">
        Master EdTech Platform
      </h1>
      <p className="prose-measure mt-4 text-[var(--color-muted-foreground)]">
        Monorepo, schema, session guard and entitlement engine are in place. The
        student catalog arrives in Phase 3.
      </p>

      <dl className="mt-10 grid gap-4 sm:grid-cols-2">
        {[
          ['Database', 'Drizzle schema + RLS baseline'],
          ['Auth', 'Phone OTP, single live session'],
          ['Device policy', '4 fingerprints / 30 days'],
          ['Entitlements', 'checkLessonAccess wired'],
        ].map(([term, detail]) => (
          <div
            key={term}
            className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
          >
            <dt className="text-sm font-medium text-[var(--color-foreground)]">{term}</dt>
            <dd className="mt-1 text-sm text-[var(--color-muted-foreground)]">{detail}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
