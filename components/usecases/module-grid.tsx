import Link from 'next/link';
import { TriangleAlert } from 'lucide-react';
import { getModules } from '@/lib/usecases';

/** Module cards for the Use Cases landing page; counts come straight from the SDS extract. */
export function UseCaseModules() {
  const modules = getModules();
  const total = modules.reduce((sum, m) => sum + m.useCases, 0);

  return (
    <div className="not-prose">
      <p className="mb-4 text-sm text-fd-muted-foreground">
        {total} use cases across {modules.length} modules, read directly from the SDS transaction tables.
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        {modules.map((m) => (
          <Link
            key={m.id}
            href={`/docs/use-cases/${m.id}`}
            className="group rounded-lg border border-fd-border bg-fd-card p-4 transition-colors hover:border-fd-primary/60 hover:bg-fd-accent"
          >
            <div className="flex items-start justify-between gap-2">
              <h3 className="font-semibold leading-tight group-hover:text-fd-primary">{m.name}</h3>
              <code className="shrink-0 rounded bg-fd-muted px-1.5 py-0.5 text-[10px]">SDS v{m.version}</code>
            </div>
            <dl className="mt-3 grid grid-cols-4 gap-2 text-center">
              {[
                ['Use cases', m.useCases],
                ['Screens', m.screens],
                ['Rules', m.businessRules],
                ['DB tables', m.dbTablesReferenced],
              ].map(([label, value]) => (
                <div key={label}>
                  <dd className="text-lg font-semibold tabular-nums">{value}</dd>
                  <dt className="text-[10px] uppercase tracking-wide text-fd-muted-foreground">{label}</dt>
                </div>
              ))}
            </dl>
            {m.sdsIssues.length > 0 && (
              <p className="mt-3 flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                <TriangleAlert className="size-3.5" /> {m.sdsIssues.length} issue{m.sdsIssues.length > 1 ? 's' : ''} in the SDS source
              </p>
            )}
          </Link>
        ))}
      </div>
    </div>
  );
}
