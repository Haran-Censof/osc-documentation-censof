import fs from 'node:fs';
import path from 'node:path';

// Data produced by scripts/extract-usecases.py (from the SDS) and
// scripts/extract-facts.mjs (from the running system). Nothing here is hand-written.
const DATA = path.join(process.cwd(), 'data');

export type ModuleSummary = {
  id: string;
  name: string;
  code: string;
  version: string;
  iteration: number;
  sourceFile: string;
  functions: number;
  useCases: number;
  topLevelUseCases: number;
  screens: number;
  businessRules: number;
  dbTablesReferenced: number;
  sdsIssues: string[];
};

export type UseCase = {
  id: string;
  name: string;
  group: string | null;
  parentId: string | null;
  actors: string[];
  steps: string[];
  alternatives: { id: string | null; text: string }[];
  input: string;
  output: string;
  uiRefs: string[];
  integration: string;
  notes: string;
  calls: string[];
  /** Indexes into ModuleView.screens */
  screens: number[];
};

export type ScreenTable = {
  name: string;
  /** null when no database snapshot is available to check against */
  inDb: boolean | null;
  crud: string;
  fields: { name: string; inDb: boolean | null }[];
};

export type Screen = { title: string; uiIds: string[]; tables: ScreenTable[] };

export type ModuleView = {
  module: Omit<ModuleSummary, 'functions' | 'useCases' | 'topLevelUseCases' | 'screens' | 'businessRules' | 'dbTablesReferenced' | 'sdsIssues'>;
  functions: { id: string; name: string; actors: string[] }[];
  useCases: UseCase[];
  screens: Screen[];
  businessRules: { group: string | null; rules: { code: string | null; text: string }[] }[];
  sdsIssues: string[];
  dbSnapshot: { schema: string; generatedAt: string | null } | null;
};

type RawScreen = {
  title: string;
  uiIds: string[];
  dataMap: { tables: string[]; fields: string[]; crud: string }[];
};

function readJson<T>(...segments: string[]): T | null {
  const file = path.join(DATA, ...segments);
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as T) : null;
}

const isIdentifier = (value: string) => /^[a-z][a-z0-9_]{2,}$/i.test(value);

function loadDbColumns() {
  const db = readJson<{ schema: string; tables: { name: string; columns: { name: string }[] }[] }>('facts', 'database.json');
  if (!db) return null;
  const tables = new Map(db.tables.map((t) => [t.name.toLowerCase(), new Set(t.columns.map((c) => c.name.toLowerCase()))]));
  const generatedAt = readJson<{ generatedAt: string }>('facts', 'index.json')?.generatedAt ?? null;
  return { schema: db.schema, generatedAt, tables };
}

function buildScreen(raw: RawScreen, db: ReturnType<typeof loadDbColumns>): Screen {
  const byTable = new Map<string, { crud: Set<string>; fields: Set<string> }>();
  for (const row of raw.dataMap) {
    const tables = row.tables.filter(isIdentifier);
    for (const table of tables) {
      const entry = byTable.get(table) ?? { crud: new Set(), fields: new Set() };
      for (const letter of row.crud.toUpperCase().replace(/[^CRUD]/g, '')) entry.crud.add(letter);
      // A row listing several tables does not say which field belongs to which table,
      // so a field is only attributed when it can be resolved.
      for (const field of row.fields.filter(isIdentifier)) {
        const owner = tables.find((t) => db?.tables.get(t.toLowerCase())?.has(field.toLowerCase()));
        if (owner === table || (!owner && tables.length === 1)) entry.fields.add(field);
      }
      byTable.set(table, entry);
    }
  }
  return {
    title: raw.title,
    uiIds: raw.uiIds,
    tables: [...byTable.entries()].map(([name, entry]) => {
      const columns = db?.tables.get(name.toLowerCase());
      return {
        name,
        inDb: db ? columns !== undefined : null,
        crud: ['C', 'R', 'U', 'D'].filter((l) => entry.crud.has(l)).join(''),
        fields: [...entry.fields].map((field) => ({ name: field, inDb: columns ? columns.has(field.toLowerCase()) : null })),
      };
    }),
  };
}

export function getModules(): ModuleSummary[] {
  return readJson<ModuleSummary[]>('usecases', 'index.json') ?? [];
}

export function getModule(id: string): ModuleView | null {
  const raw = readJson<Omit<ModuleView, 'screens' | 'dbSnapshot' | 'useCases'> & { screens: RawScreen[]; useCases: Omit<UseCase, 'screens'>[] }>(
    'usecases',
    `${id}.json`,
  );
  if (!raw) return null;
  const db = loadDbColumns();

  const useCases = raw.useCases.map((uc) => {
    // Exact UI reference first; otherwise the screen documenting the parent UI.
    const exact = raw.screens.flatMap((s, i) => (s.uiIds.some((ui) => uc.uiRefs.includes(ui)) ? [i] : []));
    const byPrefix = raw.screens.flatMap((s, i) => (s.uiIds.some((ui) => uc.uiRefs.some((ref) => ref.startsWith(`${ui}-`))) ? [i] : []));
    return { ...uc, screens: exact.length ? exact : byPrefix };
  });

  return {
    ...raw,
    useCases,
    screens: raw.screens.map((s) => buildScreen(s, db)),
    dbSnapshot: db ? { schema: db.schema, generatedAt: db.generatedAt } : null,
  };
}
