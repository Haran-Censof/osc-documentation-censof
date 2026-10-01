#!/usr/bin/env node
/**
 * Extracts verifiable facts about the OSC codebase into data/facts/*.json.
 *
 * The docs site renders numbers, routes and tables from these files instead of
 * hand-typed values, so re-running this script is how the SSOT stays current.
 *
 * Sources (most accurate first):
 *   - routes:   `php artisan route:list --json` inside each running container
 *   - database: MySQL information_schema of the shared `oscp` schema
 *   - code:     static scan of each repo's app/ (or src/ for Java)
 *   - git:      commit/branch of each repo, so every fact has a baseline
 *
 * Usage:  npm run facts
 * Env:    OSC_ROOT  path to osc-docker-project (default: WSL path below)
 *         OSC_DB    database schema name (default: oscp)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'facts');
const OSC_ROOT =
  process.env.OSC_ROOT ?? '\\\\wsl.localhost\\Ubuntu\\home\\csm-nyaana\\osc-docker-project';
const DB = process.env.OSC_DB ?? 'oscp';

/** Repo registry. `docsPage` links a repo to its existing page in content/docs. */
const REPOS = [
  { id: 'be0-utilities', name: 'BE0 Utiliti', kind: 'laravel', container: 'be0-utilities', docsPage: 'repo-osc-be0-utiliti', role: 'Shared utilities, database migrations & seeders' },
  { id: 'be1-profile-admin', name: 'BE1 Profil & Pentadbiran', kind: 'laravel', container: 'be1-profile-admin', docsPage: 'repo-osc-be1-admin-profile', role: 'Customer profile, authentication & system administration' },
  { id: 'be2-licensing', name: 'BE2 Pelesenan', kind: 'laravel', container: 'be2-licensing', docsPage: 'repo-osc-be2-pelesenan', role: 'Licence application, review, meeting, payment, issuance, renewal, cancellation' },
  { id: 'be3-complaints-notif', name: 'BE3 Aduan & Notifikasi', kind: 'laravel', container: 'be3-complaints-notif', docsPage: 'repo-osc-be3-aduan-dan-notifikasi', role: 'Complaints, inquiries & notifications' },
  { id: 'be4-reporting', name: 'BE4 Pelaporan', kind: 'spring', container: 'be4-reporting', docsPage: null, role: 'Report generation (JasperReports)' },
  { id: 'be5-enforcement', name: 'BE5 Penguatkuasaan', kind: 'laravel', container: 'be5-enforcement', docsPage: 'repo-osc-be5-enforcement', role: 'Monitoring & enforcement' },
  { id: 'be6-chatbot', name: 'BE6 AI Chatbot', kind: 'laravel', container: 'be6-chatbot', docsPage: null, role: 'AI chatbot' },
  { id: 'fe-admin', name: 'FE Admin', kind: 'laravel', container: 'fe-admin', docsPage: 'repo-osc-fe-admin', role: 'Officer / administrator portal' },
  { id: 'fe-public', name: 'FE Public', kind: 'laravel', container: 'fe-public', docsPage: 'repo-osc-fe-customer', role: 'Public / customer portal' },
];

// Laravel app/ subfolders we count, keyed by the name used in the output.
const LARAVEL_DIRS = {
  controllers: 'app/Http/Controllers',
  models: 'app/Models',
  services: 'app/Services',
  requests: 'app/Http/Requests',
  middleware: 'app/Http/Middleware',
  jobs: 'app/Jobs',
  events: 'app/Events',
  listeners: 'app/Listeners',
  notifications: 'app/Notifications',
  mail: 'app/Mail',
  commands: 'app/Console/Commands',
};

const AUTH_MIDDLEWARE = /Authenticate|auth:|AuthenticateServiceToken|RequiresStepUpToken/i;

// ---------------------------------------------------------------- helpers

function run(cmd, args, { allowFail = true } = {}) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (err) {
    if (!allowFail) throw err;
    return null;
  }
}

function listFiles(dir, ext) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, ext));
    else if (entry.name.endsWith(ext)) out.push(full);
  }
  return out;
}

const rel = (base, file) => path.relative(base, file).split(path.sep).join('/');
const readJson = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null);

function writeJson(name, data) {
  fs.mkdirSync(path.dirname(path.join(OUT, name)), { recursive: true });
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(data, null, 2) + '\n');
}

/** Tolerates warnings/notices printed before the JSON payload. */
function parseJsonOutput(text) {
  if (!text) return null;
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return null;
  }
}

function runningContainers() {
  const out = run('docker', ['ps', '--format', '{{.Names}}']);
  return new Set((out ?? '').split(/\r?\n/).filter(Boolean));
}

function gitInfo(dir) {
  const git = (...args) => run('git', ['-c', 'safe.directory=*', '-C', dir, ...args])?.trim() ?? null;
  const remote = git('remote', 'get-url', 'origin');
  return {
    branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    commit: git('rev-parse', '--short', 'HEAD'),
    commitDate: git('log', '-1', '--format=%cI'),
    commitSubject: git('log', '-1', '--format=%s'),
    // Strip any credentials embedded in the remote URL.
    remote: remote?.replace(/\/\/[^@/]+@/, '//') ?? null,
  };
}

// ---------------------------------------------------------------- laravel

/**
 * Returns { routes, error }. route:list aborts entirely when any route points at a
 * missing controller class, so that error is captured and reported as a fact itself.
 */
function laravelRoutes(container) {
  let raw;
  try {
    raw = parseJsonOutput(
      execFileSync('docker', ['exec', container, 'php', 'artisan', 'route:list', '--json'], {
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }),
    );
  } catch (err) {
    const text = `${err.stdout ?? ''}\n${err.stderr ?? ''}`;
    const error = text.match(/(\w+Exception)\s+([^\n]+?)\s*\n\s*\n?\s*([^\n]+)/)?.slice(1, 4).filter(Boolean).join(': ') ?? 'artisan route:list failed';
    return { routes: null, error: error.replace(/\s+/g, ' ').trim() };
  }
  if (!Array.isArray(raw)) return { routes: null, error: 'route:list returned no JSON' };
  return { routes: normalizeRoutes(raw), error: null };
}

function normalizeRoutes(raw) {
  return raw.map((r) => {
    const [controller, action] = r.action.includes('@') ? r.action.split('@') : [r.action, null];
    const middleware = (r.middleware ?? []).map((m) => m.replace(/^.*\\/, ''));
    return {
      methods: r.method.split('|').filter((m) => m !== 'HEAD'),
      uri: '/' + r.uri.replace(/^\//, ''),
      name: r.name,
      controller: controller.replace(/^App\\Http\\Controllers\\/, ''),
      action,
      middleware,
      routeLevelAuth: (r.middleware ?? []).some((m) => AUTH_MIDDLEWARE.test(m)),
    };
  });
}

function laravelModels(dir) {
  return listFiles(path.join(dir, 'app/Models'), '.php').map((file) => {
    const src = fs.readFileSync(file, 'utf8');
    return {
      class: rel(path.join(dir, 'app/Models'), file).replace(/\.php$/, ''),
      table: src.match(/\$table\s*=\s*['"]([^'"]+)['"]/)?.[1] ?? null,
      connection: src.match(/\$connection\s*=\s*['"]([^'"]+)['"]/)?.[1] ?? null,
    };
  });
}

function laravelRepo(repo, dir, live) {
  const composer = readJson(path.join(dir, 'composer.json'));
  const code = {};
  for (const [key, sub] of Object.entries(LARAVEL_DIRS)) {
    code[key] = listFiles(path.join(dir, sub), '.php').map((f) => rel(path.join(dir, sub), f).replace(/\.php$/, ''));
  }
  const migrations = listFiles(path.join(dir, 'database/migrations'), '.php').length;
  const { routes, error } = live
    ? laravelRoutes(repo.container)
    : { routes: null, error: 'container not running' };

  return {
    stack: {
      framework: 'Laravel',
      laravel: composer?.require?.['laravel/framework'] ?? null,
      php: composer?.require?.php ?? null,
      packages: Object.keys(composer?.require ?? {}).filter((p) => p.includes('/')),
    },
    code: { ...code, models: laravelModels(dir) },
    migrations,
    routes,
    routesSource: routes ? 'artisan route:list' : `unavailable (${error})`,
    routesError: error,
  };
}

// ---------------------------------------------------------------- spring

function springRepo(dir) {
  const pom = fs.existsSync(path.join(dir, 'pom.xml')) ? fs.readFileSync(path.join(dir, 'pom.xml'), 'utf8') : '';
  const javaFiles = listFiles(path.join(dir, 'src/main/java'), '.java');
  const routes = [];
  const controllers = [];

  for (const file of javaFiles) {
    const src = fs.readFileSync(file, 'utf8');
    if (!/@(Rest)?Controller\b/.test(src)) continue;
    const className = path.basename(file, '.java');
    controllers.push(className);
    const classBody = src.slice(src.search(/\bclass\s/));
    const base = src.slice(0, src.search(/\bclass\s/)).match(/@RequestMapping\(\s*(?:value\s*=\s*|path\s*=\s*)?"([^"]*)"/)?.[1] ?? '';
    const re = /@(Get|Post|Put|Delete|Patch)Mapping(?:\(\s*(?:value\s*=\s*|path\s*=\s*)?"?([^",)]*)"?[^)]*\))?\s*(?:@\w+(?:\([^)]*\))?\s*)*public\s+[\w<>?,\s[\]]+\s+(\w+)\s*\(/g;
    for (const m of classBody.matchAll(re)) {
      routes.push({
        methods: [m[1].toUpperCase()],
        uri: ('/' + [base, m[2] ?? ''].join('/')).replace(/\/+/g, '/').replace(/(.)\/$/, '$1'),
        name: null,
        controller: className,
        action: m[3],
        middleware: [],
        routeLevelAuth: false,
      });
    }
  }

  const tag = (t) => pom.match(new RegExp(`<${t}>([^<]+)</${t}>`))?.[1] ?? null;
  return {
    stack: {
      framework: 'Spring Boot',
      springBoot: pom.match(/spring-boot-starter-parent<\/artifactId>\s*<version>([^<]+)/)?.[1] ?? null,
      java: tag('java.version'),
      packages: [...pom.matchAll(/<artifactId>([^<]+)<\/artifactId>/g)].map((m) => m[1]),
    },
    code: { controllers, javaFiles: javaFiles.length, reportTemplates: listFiles(dir, '.jrxml').length },
    migrations: 0,
    routes,
    routesSource: 'static scan of @*Mapping annotations',
  };
}

// ---------------------------------------------------------------- database

function query(sql) {
  const out = run('docker', ['exec', 'mysql', 'mysql', '-uroot', `-p${process.env.OSC_DB_PASSWORD ?? 'root'}`, '-N', '-B', '-e', sql, DB]);
  if (out === null) return null;
  return out.split(/\r?\n/).filter(Boolean).map((line) => line.split('\t').map((v) => (v === 'NULL' ? null : v)));
}

function database() {
  const s = `'${DB}'`;
  const tables = query(`select table_name, table_rows, table_comment from information_schema.tables where table_schema=${s} and table_type='BASE TABLE' order by table_name`);
  if (!tables) return null;
  const columns = query(`select table_name, column_name, column_type, is_nullable, column_key, column_default, column_comment from information_schema.columns where table_schema=${s} order by table_name, ordinal_position`);
  const fks = query(`select table_name, column_name, referenced_table_name, referenced_column_name, constraint_name from information_schema.key_column_usage where table_schema=${s} and referenced_table_name is not null order by table_name`);
  const routines = query(`select routine_name, routine_type from information_schema.routines where routine_schema=${s} order by routine_name`);
  const views = query(`select table_name from information_schema.views where table_schema=${s} order by table_name`);

  const byTable = new Map(
    tables.map(([name, rows, comment]) => [name, { name, approxRows: Number(rows ?? 0), comment: comment || null, columns: [], foreignKeys: [] }]),
  );
  for (const [t, name, type, nullable, key, def, comment] of columns) {
    byTable.get(t)?.columns.push({ name, type, nullable: nullable === 'YES', key: key || null, default: def, comment: comment || null });
  }
  for (const [t, column, refTable, refColumn, constraint] of fks) {
    byTable.get(t)?.foreignKeys.push({ column, references: `${refTable}.${refColumn}`, constraint });
  }
  return {
    schema: DB,
    tables: [...byTable.values()],
    views: views.map(([v]) => v),
    routines: routines.map(([name, type]) => ({ name, type })),
  };
}

// ---------------------------------------------------------------- main

function summarize(repo, facts) {
  const routes = facts.routes ?? [];
  const apiRoutes = routes.filter((r) => r.uri.startsWith('/api/'));
  const count = (k) => (Array.isArray(facts.code?.[k]) ? facts.code[k].length : 0);
  return {
    id: repo.id,
    name: repo.name,
    role: repo.role,
    status: facts.status,
    framework: facts.stack?.framework ?? null,
    git: facts.git,
    counts: {
      controllers: count('controllers'),
      models: count('models'),
      services: count('services'),
      jobs: count('jobs'),
      events: count('events'),
      notifications: count('notifications'),
      middleware: count('middleware'),
      requests: count('requests'),
      migrations: facts.migrations ?? 0,
      routes: facts.routes ? routes.length : null,
      apiRoutes: facts.routes ? apiRoutes.length : null,
      apiRoutesWithRouteLevelAuth: facts.routes ? apiRoutes.filter((r) => r.routeLevelAuth).length : null,
    },
  };
}

function main() {
  if (!fs.existsSync(OSC_ROOT)) {
    console.error(`OSC_ROOT not found: ${OSC_ROOT}\nSet OSC_ROOT to your osc-docker-project folder.`);
    process.exit(1);
  }
  const live = runningContainers();
  console.log(`Source: ${OSC_ROOT}\nRunning containers: ${[...live].join(', ') || 'none (routes/db will be skipped)'}\n`);

  const index = { generatedAt: new Date().toISOString(), source: OSC_ROOT, repos: [], warnings: [] };

  for (const repo of REPOS) {
    const dir = path.join(OSC_ROOT, repo.id);
    // A folder holding only dotfiles (e.g. a stray .env) has no source code.
    const empty = !fs.existsSync(dir) || !['composer.json', 'pom.xml'].some((f) => fs.existsSync(path.join(dir, f)));
    let facts;
    if (empty) {
      facts = { status: 'not-available', note: 'Repository folder is empty or missing locally.' };
      index.warnings.push(`${repo.id}: no source code available locally`);
    } else {
      const isLive = live.has(repo.container);
      facts = repo.kind === 'spring' ? springRepo(dir) : laravelRepo(repo, dir, isLive);
      facts.status = 'ok';
      facts.git = gitInfo(dir);
      if (facts.routes === null) index.warnings.push(`${repo.id}: routes not extracted (${facts.routesError})`);
      if (facts.git.branch && !/^(main|master|dev|develop|development|staging)$/.test(facts.git.branch)) {
        index.warnings.push(`${repo.id}: on feature branch "${facts.git.branch}", facts may not match the release baseline`);
      }
    }
    const record = { ...repo, ...facts };
    writeJson(`repos/${repo.id}.json`, record);
    const summary = summarize(repo, record);
    index.repos.push(summary);
    console.log(`${repo.id.padEnd(22)} ${String(summary.status).padEnd(14)} routes=${summary.counts.routes ?? '-'} controllers=${summary.counts.controllers} models=${summary.counts.models}`);
  }

  if (live.has('mysql')) {
    const db = database();
    if (db) {
      writeJson('database.json', db);
      index.database = { schema: db.schema, tables: db.tables.length, columns: db.tables.reduce((n, t) => n + t.columns.length, 0), foreignKeys: db.tables.reduce((n, t) => n + t.foreignKeys.length, 0), views: db.views.length, routines: db.routines.length };
      console.log(`\ndatabase ${db.schema}: ${index.database.tables} tables, ${index.database.columns} columns, ${index.database.foreignKeys} FKs`);
    } else index.warnings.push('database: query failed');
  } else index.warnings.push('database: mysql container not running');

  writeJson('index.json', index);
  if (index.warnings.length) console.log('\nWarnings:\n  - ' + index.warnings.join('\n  - '));
  console.log(`\nWrote ${rel(ROOT, OUT)}/`);
}

main();
