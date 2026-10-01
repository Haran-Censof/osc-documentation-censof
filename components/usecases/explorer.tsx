'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  CircleCheck,
  CircleX,
  CornerDownRight,
  Database,
  Flag,
  GitBranch,
  Monitor,
  Pause,
  Play,
  ScrollText,
  Search,
  TriangleAlert,
  User,
} from 'lucide-react';
import type { ModuleView, Screen, UseCase } from '@/lib/usecases';
import { cn } from '@/lib/cn';

type NodeKind = 'start' | 'step' | 'end' | 'alt' | 'altHub' | 'sub';
type FlowNodeData = { kind: NodeKind; label: string; text: string; active?: boolean; target?: string };
type FlowNode = Node<FlowNodeData, 'flow'>;

const COLUMN = { sub: -400, main: 0, alt: 400 };
const ROW = 124;
const FIRST_ROW = 116;
const UC_ID = /UC-\s*PL(?:-\s*[A-Z0-9]+)+/g;

const KIND_STYLE: Record<NodeKind, string> = {
  start: 'border-fd-primary/60 bg-fd-primary/10',
  step: 'border-fd-border bg-fd-card',
  end: 'border-emerald-500/60 bg-emerald-500/10',
  alt: 'border-amber-500/60 bg-amber-500/10',
  altHub: 'border-dashed border-amber-500/60 bg-transparent',
  sub: 'border-violet-500/60 bg-violet-500/10',
};

function FlowNodeView({ data, selected }: NodeProps<FlowNode>) {
  const hidden = '!opacity-0 !pointer-events-none';
  return (
    <div
      className={cn(
        'w-[300px] rounded-lg border px-3 py-2 text-left shadow-sm transition-all',
        KIND_STYLE[data.kind],
        selected && 'ring-2 ring-fd-primary',
        data.active && 'ring-2 ring-fd-primary scale-[1.03] shadow-lg',
      )}
    >
      <Handle type="target" position={Position.Top} className={hidden} />
      <Handle type="target" position={Position.Left} id="left-in" className={hidden} />
      <Handle type="target" position={Position.Right} id="right-in" className={hidden} />
      <div className="text-[10px] font-semibold uppercase tracking-wide text-fd-muted-foreground">{data.label}</div>
      <div className="mt-0.5 line-clamp-3 text-xs leading-snug text-fd-foreground">{data.text}</div>
      <Handle type="source" position={Position.Bottom} className={hidden} />
      <Handle type="source" position={Position.Left} id="left-out" className={hidden} />
      <Handle type="source" position={Position.Right} id="right-out" className={hidden} />
    </div>
  );
}

const nodeTypes = { flow: FlowNodeView };

function mentionedUseCases(text: string) {
  return [...text.toUpperCase().matchAll(UC_ID)].map((m) => m[0].replace(/\s+/g, ''));
}

function buildFlow(uc: UseCase, byId: Map<string, UseCase>, children: UseCase[], activeStep: number | null) {
  const nodes: FlowNode[] = [];
  const edges: Edge[] = [];
  const add = (id: string, x: number, y: number, data: FlowNodeData) =>
    nodes.push({ id, type: 'flow', position: { x, y }, data });
  const main = { stroke: 'var(--color-fd-primary)', strokeWidth: 1.5 };

  add('start', COLUMN.main, 0, { kind: 'start', label: 'Actor', text: uc.actors.join(' / ') || 'Not stated in SDS' });
  uc.steps.forEach((text, i) => {
    add(`step-${i}`, COLUMN.main, FIRST_ROW + i * ROW, { kind: 'step', label: `Step ${i + 1}`, text, active: activeStep === i });
    edges.push({ id: `main-${i}`, source: i === 0 ? 'start' : `step-${i - 1}`, target: `step-${i}`, animated: true, style: main });
  });
  const endY = FIRST_ROW + uc.steps.length * ROW;
  add('end', COLUMN.main, endY, { kind: 'end', label: 'Output', text: uc.output || 'Not stated in SDS' });
  edges.push({ id: 'main-end', source: uc.steps.length ? `step-${uc.steps.length - 1}` : 'start', target: 'end', animated: true, style: main });

  // Sub use cases: placed beside the step that invokes them when the SDS names the step.
  const related = new Map<string, UseCase>();
  for (const child of children) related.set(child.id, child);
  for (const id of uc.calls) if (byId.has(id)) related.set(id, byId.get(id)!);
  const taken = new Set<number>();
  for (const sub of related.values()) {
    const callingStep = uc.steps.findIndex((s) => mentionedUseCases(s).includes(sub.id));
    let slot = Math.max(callingStep, 0);
    while (taken.has(slot)) slot += 1;
    taken.add(slot);
    add(`sub-${sub.id}`, COLUMN.sub, FIRST_ROW + slot * ROW, { kind: 'sub', label: sub.id, text: sub.name, target: sub.id });
    edges.push({
      id: `sub-${sub.id}`,
      source: callingStep >= 0 ? `step-${callingStep}` : 'start',
      sourceHandle: 'left-out',
      target: `sub-${sub.id}`,
      targetHandle: 'right-in',
      type: 'smoothstep',
      animated: callingStep >= 0,
      label: callingStep >= 0 ? 'calls' : 'sub use case',
      style: { stroke: '#8b5cf6', strokeDasharray: callingStep >= 0 ? undefined : '4 4' },
    });
  }

  // The SDS lists alternative scenarios per use case without tying them to a step,
  // so they hang off one hub rather than off a guessed step.
  if (uc.alternatives.length) {
    add('alt-hub', COLUMN.alt, 0, { kind: 'altHub', label: 'Alternative scenarios', text: 'Listed by the SDS for this use case as a whole' });
    edges.push({ id: 'alt-hub', source: 'start', sourceHandle: 'right-out', target: 'alt-hub', targetHandle: 'left-in', style: { stroke: '#f59e0b', strokeDasharray: '4 4' } });
    uc.alternatives.forEach((alt, i) => {
      add(`alt-${i}`, COLUMN.alt, FIRST_ROW + i * ROW, { kind: 'alt', label: alt.id ?? `Alternative ${i + 1}`, text: alt.text });
      edges.push({ id: `alt-${i}`, source: i === 0 ? 'alt-hub' : `alt-${i - 1}`, target: `alt-${i}`, style: { stroke: '#f59e0b', strokeDasharray: '4 4' } });
    });
  }
  return { nodes, edges };
}

function useDarkMode() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const root = document.documentElement;
    const update = () => setDark(root.classList.contains('dark'));
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

function DbBadge({ inDb }: { inDb: boolean | null }) {
  if (inDb === null) return null;
  return inDb ? (
    <CircleCheck className="size-3.5 shrink-0 text-emerald-500" aria-label="Exists in database" />
  ) : (
    <CircleX className="size-3.5 shrink-0 text-red-500" aria-label="Not found in database" />
  );
}

function ScreenCard({ screen }: { screen: Screen }) {
  return (
    <div className="rounded-lg border border-fd-border bg-fd-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Monitor className="size-4 text-fd-muted-foreground" />
        <span className="text-sm font-medium">{screen.title}</span>
        {screen.uiIds.map((id) => (
          <code key={id} className="rounded bg-fd-muted px-1.5 py-0.5 text-[10px]">{id}</code>
        ))}
      </div>
      {screen.tables.length === 0 ? (
        <p className="mt-2 text-xs text-fd-muted-foreground">The SDS gives no data mapping for this screen.</p>
      ) : (
        <div className="mt-3 space-y-2">
          {screen.tables.map((table) => {
            const missing = table.fields.filter((f) => f.inDb === false);
            return (
              <details key={table.name} className="rounded border border-fd-border px-2 py-1.5">
                <summary className="flex cursor-pointer items-center gap-2 text-xs">
                  <Database className="size-3.5 text-fd-muted-foreground" />
                  <code className="font-medium">{table.name}</code>
                  <DbBadge inDb={table.inDb} />
                  {table.crud && <span className="rounded bg-fd-muted px-1 text-[10px]">{table.crud}</span>}
                  <span className="ml-auto text-fd-muted-foreground">
                    {table.fields.length} fields
                    {missing.length > 0 && <span className="text-red-500"> · {missing.length} not in DB</span>}
                  </span>
                </summary>
                <div className="mt-2 flex flex-wrap gap-1">
                  {table.fields.map((field) => (
                    <span
                      key={field.name}
                      className={cn(
                        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px]',
                        field.inDb === false ? 'bg-red-500/10 text-red-600 dark:text-red-400' : 'bg-fd-muted',
                      )}
                    >
                      {field.name}
                      {field.inDb === false && <CircleX className="size-3" />}
                    </span>
                  ))}
                </div>
              </details>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-fd-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm leading-relaxed">{children || <span className="text-fd-muted-foreground">Not stated in SDS</span>}</dd>
    </div>
  );
}

type Tab = 'overview' | 'screens' | 'rules';

export function UseCaseExplorer({ data }: { data: ModuleView }) {
  const byId = useMemo(() => new Map(data.useCases.map((u) => [u.id, u])), [data.useCases]);
  const childrenOf = useMemo(() => {
    const map = new Map<string | null, UseCase[]>();
    for (const uc of data.useCases) map.set(uc.parentId, [...(map.get(uc.parentId) ?? []), uc]);
    return map;
  }, [data.useCases]);

  const [selectedId, setSelectedId] = useState(data.useCases[0]?.id ?? '');
  const [nodeId, setNodeId] = useState<string | null>(null);
  const [activeStep, setActiveStep] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<Tab>('overview');
  const dark = useDarkMode();

  const select = useCallback((id: string) => {
    setSelectedId(id);
    setNodeId(null);
    setActiveStep(null);
    window.history.replaceState(null, '', `#${id}`);
  }, []);

  // Deep links: /docs/use-cases/<module>#UC-PL-..
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (byId.has(id)) setSelectedId(id);
  }, [byId]);

  const uc = byId.get(selectedId);
  const playing = activeStep !== null;

  useEffect(() => {
    if (activeStep === null || !uc) return;
    const timer = setTimeout(() => setActiveStep(activeStep + 1 < uc.steps.length ? activeStep + 1 : null), 1600);
    return () => clearTimeout(timer);
  }, [activeStep, uc]);

  const flow = useMemo(
    () => (uc ? buildFlow(uc, byId, childrenOf.get(uc.id) ?? [], activeStep) : { nodes: [], edges: [] }),
    [uc, byId, childrenOf, activeStep],
  );

  if (!uc) return <p className="text-sm text-fd-muted-foreground">No use cases were found in this module&apos;s SDS.</p>;

  const shownNodeId = playing ? `step-${activeStep}` : nodeId;
  const shownNode = flow.nodes.find((n) => n.id === shownNodeId);
  const rules = data.businessRules.find((g) => g.group === uc.group)?.rules ?? [];
  const screens = uc.screens.map((i) => data.screens[i]);
  const needle = query.trim().toLowerCase();
  const matches = (u: UseCase) => !needle || u.id.toLowerCase().includes(needle) || u.name.toLowerCase().includes(needle);

  const renderTree = (parent: string | null, depth: number): React.ReactNode =>
    (childrenOf.get(parent) ?? []).map((item) => (
      <div key={item.id}>
        {matches(item) && (
          <button
            type="button"
            onClick={() => select(item.id)}
            style={{ paddingLeft: 8 + depth * 14 }}
            className={cn(
              'flex w-full items-start gap-1.5 rounded-md py-1.5 pr-2 text-left text-xs transition-colors hover:bg-fd-accent',
              item.id === selectedId && 'bg-fd-primary/10 text-fd-primary',
            )}
          >
            {depth > 0 && <CornerDownRight className="mt-0.5 size-3 shrink-0 opacity-50" />}
            <span>
              <span className="block font-mono text-[10px] opacity-70">{item.id}</span>
              <span className="block leading-snug">{item.name}</span>
            </span>
          </button>
        )}
        {renderTree(item.id, depth + 1)}
      </div>
    ));

  const tabs: { id: Tab; label: string; icon: typeof Monitor; count?: number }[] = [
    { id: 'overview', label: 'Overview', icon: ScrollText },
    { id: 'screens', label: 'Screens & data', icon: Monitor, count: screens.length },
    { id: 'rules', label: 'Business rules', icon: Flag, count: rules.length },
  ];

  return (
    <div className="not-prose grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
      <aside className="lg:sticky lg:top-24 lg:max-h-[calc(100vh-7rem)] lg:overflow-y-auto rounded-lg border border-fd-border bg-fd-card p-2">
        <label className="mb-2 flex items-center gap-2 rounded-md border border-fd-border px-2 py-1.5">
          <Search className="size-3.5 text-fd-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${data.useCases.length} use cases`}
            className="w-full bg-transparent text-xs outline-none placeholder:text-fd-muted-foreground"
          />
        </label>
        {renderTree(null, 0)}
      </aside>

      <section className="min-w-0 space-y-4">
        <header className="rounded-lg border border-fd-border bg-fd-card p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <code className="text-xs text-fd-primary">{uc.id}</code>
              <h2 className="mt-1 text-xl font-semibold leading-tight">{uc.name}</h2>
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                {uc.actors.map((actor) => (
                  <span key={actor} className="inline-flex items-center gap-1 rounded-full bg-fd-primary/10 px-2 py-0.5 text-fd-primary">
                    <User className="size-3" /> {actor}
                  </span>
                ))}
                <span className="text-fd-muted-foreground">
                  {uc.steps.length} steps · {uc.alternatives.length} alternative scenarios
                </span>
              </div>
            </div>
            <button
              type="button"
              disabled={uc.steps.length === 0}
              onClick={() => setActiveStep(playing ? null : 0)}
              className="inline-flex items-center gap-1.5 rounded-md bg-fd-primary px-3 py-1.5 text-xs font-medium text-fd-primary-foreground disabled:opacity-50"
            >
              {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
              {playing ? 'Stop' : 'Play flow'}
            </button>
          </div>
        </header>

        <div className="h-[560px] overflow-hidden rounded-lg border border-fd-border bg-fd-background">
          <ReactFlow
            key={uc.id}
            nodes={flow.nodes}
            edges={flow.edges}
            nodeTypes={nodeTypes}
            colorMode={dark ? 'dark' : 'light'}
            fitView
            fitViewOptions={{ padding: 0.15 }}
            minZoom={0.2}
            nodesConnectable={false}
            onNodeClick={(_, node) => {
              const target = (node.data as FlowNodeData).target;
              if (target) select(target);
              else setNodeId(node.id);
            }}
            onPaneClick={() => setNodeId(null)}
          >
            <Background gap={20} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>

        <div className="rounded-lg border border-fd-border bg-fd-card p-4 text-sm">
          {shownNode ? (
            <>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-fd-muted-foreground">{shownNode.data.label}</div>
              <p className="mt-1 leading-relaxed">{shownNode.data.text}</p>
            </>
          ) : (
            <p className="flex items-center gap-2 text-fd-muted-foreground">
              <GitBranch className="size-4" /> Click a node to read it in full. Purple nodes open the sub use case.
            </p>
          )}
        </div>

        <div>
          <div className="flex gap-1 border-b border-fd-border">
            {tabs.map(({ id, label, icon: Icon, count }) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={cn(
                  '-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium',
                  tab === id ? 'border-fd-primary text-fd-primary' : 'border-transparent text-fd-muted-foreground hover:text-fd-foreground',
                )}
              >
                <Icon className="size-3.5" /> {label}
                {count !== undefined && <span className="rounded-full bg-fd-muted px-1.5 text-[10px]">{count}</span>}
              </button>
            ))}
          </div>

          <div className="pt-4">
            {tab === 'overview' && (
              <dl className="grid gap-4 md:grid-cols-2">
                <Field label="Input">{uc.input}</Field>
                <Field label="Output">{uc.output}</Field>
                <Field label="Integration">{uc.integration}</Field>
                <Field label="UI reference">
                  {uc.uiRefs.length > 0 && uc.uiRefs.map((id) => <code key={id} className="mr-1 rounded bg-fd-muted px-1.5 py-0.5 text-xs">{id}</code>)}
                </Field>
                <div className="md:col-span-2">
                  <Field label="Notes / conditions / constraints">{uc.notes}</Field>
                </div>
              </dl>
            )}

            {tab === 'screens' && (
              <div className="space-y-3">
                {data.dbSnapshot && (
                  <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fd-muted-foreground">
                    <span>Tables and fields named by the SDS, checked against the live <code>{data.dbSnapshot.schema}</code> schema:</span>
                    <span className="inline-flex items-center gap-1"><CircleCheck className="size-3.5 text-emerald-500" /> exists</span>
                    <span className="inline-flex items-center gap-1"><CircleX className="size-3.5 text-red-500" /> not found</span>
                  </p>
                )}
                {screens.length === 0 ? (
                  <p className="flex items-center gap-2 text-sm text-fd-muted-foreground">
                    <TriangleAlert className="size-4 text-amber-500" /> No screen in the SDS matches this use case&apos;s UI reference.
                  </p>
                ) : (
                  screens.map((screen) => <ScreenCard key={screen.title} screen={screen} />)
                )}
              </div>
            )}

            {tab === 'rules' &&
              (rules.length === 0 ? (
                <p className="text-sm text-fd-muted-foreground">The SDS lists no business rules for this group.</p>
              ) : (
                <ol className="space-y-2">
                  {rules.map((rule, i) => (
                    <li key={i} className="flex gap-3 rounded-lg border border-fd-border bg-fd-card p-3 text-sm">
                      <code className="shrink-0 text-xs text-fd-primary">{rule.code ?? i + 1}</code>
                      <span className="leading-relaxed">{rule.text}</span>
                    </li>
                  ))}
                </ol>
              ))}
          </div>
        </div>
      </section>
    </div>
  );
}
