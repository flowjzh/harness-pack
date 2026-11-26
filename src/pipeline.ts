import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BuildOptions, LintIssue, McpServer, PackConfig, ReleaseManifest, TargetConfig } from './types.js';
import { loadConfig, resolveConfig, isRecord, type ResolvedConfig } from './config.js';
import { lintManifest, lintPackageTree } from './manifest-lint.js';
import { PRESETS, type Preset, type PresetName } from './presets.js';
import { lintSkills } from './lint.js';

const PKG_VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

// ─── fs helpers ──────────────────────────────────────────────────────────────

function walk(dir: string, rel = ''): { rel: string; abs: string }[] {
  const out: { rel: string; abs: string }[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const childRel = rel === '' ? e.name : `${rel}/${e.name}`;
    const childAbs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(childAbs, childRel));
    else if (e.isFile()) out.push({ rel: childRel, abs: childAbs });
  }
  return out;
}

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

// ─── bundle entries ──────────────────────────────────────────────────────────

type Category = 'skills' | 'agents' | 'include';

interface Entry {
  src: string;
  name: string;
  category: Category;
}

// Resolve every configured entry once; targets copy straight from these
// sources (release views are already the ship-only tree).
function resolveEntries(root: string, cfg: PackConfig): Entry[] {
  const entry = (category: Category) => (rel: string): Entry => {
    const src = path.join(root, rel);
    if (!existsSync(src)) throw new Error(`missing bundle entry: ${rel}`);
    return { src, name: path.basename(rel), category };
  };
  return [
    ...cfg.skills.map(entry('skills')),
    ...(cfg.agents ?? []).map(entry('agents')),
    ...(cfg.include ?? []).map(entry('include')),
  ];
}

const lintDirs = (root: string, cfg: PackConfig) => (cfg.lint ?? cfg.skills).map((s) => path.join(root, s));

// Build steps belong to the repos that own the content; run them in the
// bundle root so relative paths in the commands (make -C skills/x ...) work.
// install-dev sets HARNESS_PACK_DEV=1: view scripts may then assemble from
// working trees instead of committed archives (what ships for a release
// never changes).
function runBuildSteps(root: string, steps: string[], dev = false): void {
  const env = dev ? { ...process.env, HARNESS_PACK_DEV: '1' } : undefined;
  for (const step of steps) {
    // Inherit both streams: build output (including per-source warnings such
    // as a skipped broken plugin) belongs in the caller's log as it happens.
    const res = spawnSync(step, { shell: true, cwd: root, stdio: ['ignore', 'inherit', 'inherit'], env });
    if (res.status !== 0) {
      throw new Error(`build step failed (exit ${res.status ?? '?'}): ${step}`);
    }
  }
}

// ─── emit: per-target artifacts ──────────────────────────────────────────────

// {{root}} is the only token rendered inside MCP declarations: the bundle owns
// what to launch, the preset owns how this harness spells "the plugin root".
// Presentation keys move into the preset's metadata envelope when it has one,
// and are stripped otherwise - they are canonical, not protocol.
function renderMcpServers(servers: Record<string, McpServer>, preset: Preset): Record<string, unknown> {
  const render = (value: unknown): unknown => {
    if (typeof value === 'string') return value.replaceAll('{{root}}', preset.mcp.root);
    if (Array.isArray(value)) return value.map(render);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, render(child)]));
    }
    return value;
  };
  return Object.fromEntries(Object.entries(servers).map(([name, server]) => {
    const { displayName, description, icon, auth, ...stdio } = server;
    const def: Record<string, unknown> = { ...preset.mcp.serverDefaults, ...(render(stdio) as Record<string, unknown>) };
    const meta = Object.fromEntries(Object.entries({ displayName, description, icon, auth }).filter(([, v]) => v !== undefined));
    if (preset.mcp.metaKey && Object.keys(meta).length > 0) def[preset.mcp.metaKey] = render(meta);
    return [name, def];
  }));
}

// Manifest tokens: {{name}}, {{version}} and dotted {{display.*}} paths into
// the resolved display layer, always wrapped in template quotes. A token that
// exactly fills a JSON string splices any JSON value (the quotes are
// consumed); a token embedded in longer text splices its raw contents and
// must resolve to a string. Unresolvable keys fail the build - persona output
// comes from declared keys only, never a silent fallback to `name`.
function renderManifest(
  root: string,
  templateRel: string,
  cfg: ResolvedConfig,
  preset: Preset,
  display: Record<string, unknown>,
  mcp: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const templatePath = path.join(root, templateRel);
  if (!existsSync(templatePath)) throw new Error(`manifest template not found: ${templateRel}`);
  const lookup: Record<string, unknown> = { name: cfg.name, version: cfg.version, display };
  const token = (key: string): unknown => {
    let node: unknown = lookup;
    for (const part of key.split('.')) {
      if (!isRecord(node) || !(part in node)) {
        throw new Error(`manifest template ${templateRel}: {{${key}}} does not resolve (declare it under display)`);
      }
      node = node[part];
    }
    return node;
  };
  const text = readFileSync(templatePath, 'utf8').replace(/"(?:[^"\\]|\\.)*"/g, (lit) => {
    const sole = lit.match(/^"\{\{([\w.]+)\}\}"$/);
    if (sole) return JSON.stringify(token(sole[1]));
    return lit.replace(/\{\{([\w.]+)\}\}/g, (_raw, key: string) => {
      const value = token(key);
      if (typeof value !== 'string') {
        throw new Error(`manifest template ${templateRel}: {{${key}}} must resolve to a string when embedded in text`);
      }
      return JSON.stringify(value).slice(1, -1);
    });
  });
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(text);
  } catch (e) {
    throw new Error(`manifest template ${templateRel} is not valid JSON after substitution: ${e instanceof Error ? e.message : e}`);
  }
  if (preset.mcp.mode === 'embed' && mcp) manifest[preset.mcp.dest] = mcp;
  return manifest;
}

function emitTarget(
  root: string,
  entries: Entry[],
  key: string,
  target: TargetConfig,
  distRoot: string,
  cfg: ResolvedConfig,
): { outDir: string; issues: LintIssue[] } {
  const preset = PRESETS[target.preset];
  // Whole-key override, not a deep merge: platform media divergence (a PNG
  // avatar where the market bans SVG) swaps the key wholesale.
  const display: Record<string, unknown> = { ...cfg.display, ...target.display };
  if (typeof display.avatar === 'string' && !existsSync(path.join(root, display.avatar))) {
    throw new Error(`targets.${key}: display avatar not found in the bundle: ${display.avatar}`);
  }
  const outDir = path.resolve(distRoot, target.outDir ?? key);
  if (!outDir.startsWith(path.resolve(distRoot) + path.sep)) throw new Error(`targets.${key}: outDir escapes dist`);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  for (const entry of entries) {
    const sub = entry.category === 'skills' ? preset.skillsDir : entry.category === 'agents' ? preset.agentsDir : '';
    mkdirSync(path.join(outDir, sub), { recursive: true });
    cpSync(entry.src, path.join(outDir, sub, entry.name), { recursive: true });
  }

  const servers = { ...cfg.mcp, ...target.mcp };
  const mcp = Object.keys(servers).length > 0 ? renderMcpServers(servers, preset) : undefined;

  const manifest = renderManifest(root, target.manifest, cfg, preset, display, mcp);
  const manifestDest = path.join(outDir, preset.manifestDest);
  mkdirSync(path.dirname(manifestDest), { recursive: true });
  writeFileSync(manifestDest, `${JSON.stringify(manifest, null, 2)}\n`);

  if (mcp && preset.mcp.mode === 'file') {
    const file = { ...(preset.mcp.schema ? { $schema: preset.mcp.schema } : {}), mcpServers: mcp };
    writeFileSync(path.join(outDir, preset.mcp.dest), `${JSON.stringify(file, null, 2)}\n`);
  }
  const mcpRef = mcp && preset.mcp.mode === 'file' ? `./${preset.mcp.dest}` : undefined;
  const issues = [...lintManifest(manifest, target.preset, outDir, mcpRef), ...lintPackageTree(outDir, preset)]
    .map((i) => ({ skill: `targets.${key}`, ...i }));
  return { outDir, issues };
}

// ─── release manifest + build orchestration ──────────────────────────────────

function hashTree(dir: string): Record<string, { sha256: string; bytes: number }> {
  const files: Record<string, { sha256: string; bytes: number }> = {};
  for (const file of walk(dir)) {
    const buf = readFileSync(file.abs);
    files[file.rel] = { sha256: sha256(buf), bytes: buf.byteLength };
  }
  return files;
}

export interface BuildResult {
  version: string;
  releasePath: string;
  targets: { key: string; outDir: string; fileCount: number; preset: PresetName }[];
}

export function runBuild(opts: BuildOptions): BuildResult {
  const root = path.resolve(path.dirname(opts.configPath));
  const cfg = resolveConfig(loadConfig(opts.configPath), opts);

  // Build first: what ships is the release views, so the spec check runs on
  // the tree that will actually be assembled (or on `lint` sources when the
  // config points there).
  if (cfg.build) runBuildSteps(root, cfg.build, opts.dev ?? false);

  const errors = lintSkills(lintDirs(root, cfg)).filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    throw new Error(`lint errors - fix them before building:\n${errors.map((i) => `  ${i.skill}: ${i.message}`).join('\n')}`);
  }

  const entries = resolveEntries(root, cfg);
  const distRoot = path.resolve(root, opts.outDir ?? 'dist');
  const manifestIssues: LintIssue[] = [];
  const targets = Object.entries(cfg.targets).map(([key, target]) => {
    const { outDir, issues } = emitTarget(root, entries, key, target, distRoot, cfg);
    manifestIssues.push(...issues);
    // Dev skips release hashing and the release manifest: install-dev never
    // reads either and reruns on every edit-summon-verify cycle. The gates
    // (skill lint + manifest lint) above are unaffected.
    const files = opts.dev ? undefined : hashTree(outDir);
    return { key, outDir, fileCount: files ? Object.keys(files).length : walk(outDir).length, preset: target.preset, files };
  });
  // Platform listing rules run on the rendered manifests; warnings surface on
  // stderr, errors abort before release.json is written.
  for (const issue of manifestIssues.filter((i) => i.severity === 'warning')) {
    console.error(`[warn] ${issue.skill}: ${issue.message}`);
  }
  const manifestErrors = manifestIssues.filter((i) => i.severity === 'error');
  if (manifestErrors.length > 0) {
    throw new Error(`manifest errors - fix them before building:\n${manifestErrors.map((i) => `  ${i.skill}: ${i.message}`).join('\n')}`);
  }
  const releasePath = path.join(distRoot, 'release.json');
  if (!opts.dev) {
    const release: ReleaseManifest = {
      generator: `harness-pack/${PKG_VERSION}`,
      name: cfg.name,
      version: cfg.version,
      generatedAt: new Date().toISOString(),
      targets: Object.fromEntries(targets.map((t) => [t.key, { files: t.files! }])),
    };
    writeFileSync(releasePath, `${JSON.stringify(release, null, 2)}\n`);
  }
  return {
    version: cfg.version,
    releasePath,
    targets: targets.map(({ key, outDir, fileCount, preset }) => ({ key, outDir, fileCount, preset })),
  };
}

export function runLint(configPath: string): LintIssue[] {
  const root = path.resolve(path.dirname(configPath));
  return lintSkills(lintDirs(root, loadConfig(configPath)));
}
