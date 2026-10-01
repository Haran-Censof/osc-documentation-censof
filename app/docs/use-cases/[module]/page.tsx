import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { ChevronLeft, TriangleAlert } from 'lucide-react';
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/layouts/docs/page';
import { UseCaseExplorer } from '@/components/usecases/explorer';
import { getModule, getModules } from '@/lib/usecases';

type Props = { params: Promise<{ module: string }> };

export const dynamicParams = false;

export function generateStaticParams() {
  return getModules().map((m) => ({ module: m.id }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const data = getModule((await params).module);
  return { title: data ? `Use Cases – ${data.module.name}` : 'Use Cases' };
}

export default async function Page({ params }: Props) {
  const data = getModule((await params).module);
  if (!data) notFound();

  return (
    <DocsPage full>
      <Link href="/docs/use-cases" className="inline-flex items-center gap-1 text-sm text-fd-muted-foreground hover:text-fd-foreground">
        <ChevronLeft className="size-4" /> All modules
      </Link>
      <DocsTitle>{data.module.name}</DocsTitle>
      <DocsDescription className="mb-0">
        {data.useCases.length} use cases · {data.screens.length} screens · source: SDS v{data.module.version} ({data.module.sourceFile})
      </DocsDescription>
      <DocsBody>
        {data.sdsIssues.length > 0 && (
          <div className="not-prose mb-4 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
            <p className="flex items-center gap-2 font-medium">
              <TriangleAlert className="size-4 text-amber-500" /> Issues found in the SDS source
            </p>
            <ul className="mt-1 list-disc pl-8 text-fd-muted-foreground">
              {data.sdsIssues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          </div>
        )}
        <UseCaseExplorer data={data} />
      </DocsBody>
    </DocsPage>
  );
}
