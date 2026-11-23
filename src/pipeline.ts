import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BuildOptions, LintIssue, PackConfig, ReleaseManifest, TargetConfig } from './types.js';
import { loadConfig, resolveConfig, type ResolvedConfig } from './config.js';
import { PRESETS, type Preset } from './presets.js';
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
function runBuildSteps(root: string, steps: string[]): void {
  for (const step of steps) {
    // Inherit both streams: build output (including per-source warnings such
    // as a skipped broken plugin) belongs in the caller's log as it happens.
    const res = spawnSync(step, { shell: true, cwd: root, stdio: ['ignore', 'inherit', 'inherit'] });
    if (res.status !== 0) {
      throw new Error(`build step failed (exit ${res.status ?? '?'}): ${step}`);
    }
  }
}

// ─── emit: per-target artifacts ──────────────────────────────────────────────

function renderManifest(root: string, templateRel: string, cfg: ResolvedConfig, target: TargetConfig): string {
  const templatePath = path.join(root, templateRel);
  if (!existsSync(templatePath)) throw new Error(`manifest template not found: ${templateRel}`);
  const text = readFileSync(templatePath, 'utf8')
    .replaceAll('{{name}}', cfg.name)
    .replaceAll('{{version}}', cfg.version);
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(text);
  } catch (e) {
    throw new Error(`manifest template ${templateRel} is not valid JSON after substitution: ${e instanceof Error ? e.message : e}`);
  }
  const preset = PRESETS[target.preset];
  if (preset.mcp.mode === 'embed' && target.mcp) manifest[preset.mcp.dest] = target.mcp;
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function emitTarget(root: string, entries: Entry[], key: string, target: TargetConfig, distRoot: string, cfg: ResolvedConfig): string {
  const preset = PRESETS[target.preset];
  const outDir = path.resolve(distRoot, target.outDir ?? key);
  if (!outDir.startsWith(path.resolve(distRoot) + path.sep)) throw new Error(`targets.${key}: outDir escapes dist`);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  for (const entry of entries) {
    const sub = entry.category === 'skills' ? preset.skillsDir : entry.category === 'agents' ? preset.agentsDir : '';
    mkdirSync(path.join(outDir, sub), { recursive: true });
    cpSync(entry.src, path.join(outDir, sub, entry.name), { recursive: true });
  }

  const manifestDest = path.join(outDir, preset.manifestDest);
  mkdirSync(path.dirname(manifestDest), { recursive: true });
  writeFileSync(manifestDest, renderManifest(root, target.manifest, cfg, target));

  if (target.mcp && preset.mcp.mode === 'file') {
    writeFileSync(path.join(outDir, preset.mcp.dest), `${JSON.stringify({ mcpServers: target.mcp }, null, 2)}\n`);
  }
  return outDir;
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
  targets: { key: string; outDir: string; fileCount: number }[];
}

export function runBuild(opts: BuildOptions): BuildResult {
  const root = path.resolve(path.dirname(opts.configPath));
  const cfg = resolveConfig(loadConfig(opts.configPath), opts);

  // Build first: what ships is the release views, so the spec check runs on
  // the tree that will actually be assembled (or on `lint` sources when the
  // config points there).
  if (cfg.build) runBuildSteps(root, cfg.build);

  const errors = lintSkills(lintDirs(root, cfg)).filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    throw new Error(`lint errors - fix them before building:\n${errors.map((i) => `  ${i.skill}: ${i.message}`).join('\n')}`);
  }

  const entries = resolveEntries(root, cfg);
  const distRoot = path.resolve(root, opts.outDir ?? 'dist');
  const targets = Object.entries(cfg.targets).map(([key, target]) => {
    const outDir = emitTarget(root, entries, key, target, distRoot, cfg);
    const files = hashTree(outDir);
    return { key, outDir, fileCount: Object.keys(files).length, files };
  });
  const release: ReleaseManifest = {
    generator: `harness-pack/${PKG_VERSION}`,
    name: cfg.name,
    version: cfg.version,
    generatedAt: new Date().toISOString(),
    targets: Object.fromEntries(targets.map((t) => [t.key, { files: t.files }])),
  };
  const releasePath = path.join(distRoot, 'release.json');
  writeFileSync(releasePath, `${JSON.stringify(release, null, 2)}\n`);
  return {
    version: cfg.version,
    releasePath,
    targets: targets.map(({ key, outDir, fileCount }) => ({ key, outDir, fileCount })),
  };
}

export function runLint(configPath: string): LintIssue[] {
  const root = path.resolve(path.dirname(configPath));
  return lintSkills(lintDirs(root, loadConfig(configPath)));
}
