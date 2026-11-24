// Per-preset manifest requirements, checked on the RENDERED manifest of every
// build. A preset whose platform presents the bundle as a person encodes its
// market's listing rules here, so a bundle cannot silently ship a package the
// platform would reject: structural problems are errors, market-copy policy
// (word counts, image specs) is warnings. The reference-integrity check at the
// bottom is universal - it runs for every preset on the shipped tree.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { isRecord } from './config.js';
import type { Preset, PresetName } from './presets.js';

export interface ManifestIssue {
  severity: 'error' | 'warning';
  message: string;
}

// Listing fields are declared as {en, zh} pairs; a plain string renders, but
// the market listing wants both languages.
function localized(value: unknown, field: string, out: ManifestIssue[]): void {
  if (typeof value === 'string') {
    if (value) out.push({ severity: 'warning', message: `${field} should be an {en, zh} pair for the market listing` });
    else out.push({ severity: 'error', message: `${field} is empty` });
    return;
  }
  const ok = isRecord(value)
    && typeof value.en === 'string' && value.en
    && typeof value.zh === 'string' && value.zh;
  if (!ok) out.push({ severity: 'error', message: `${field} must be an {en, zh} pair of non-empty strings` });
}

const hanzi = (s: string) => (s.match(/[一-鿿]/g) ?? []).length;

function pngSize(buf: Buffer): [number, number] | undefined {
  if (buf.length < 24 || !buf.subarray(1, 4).equals(Buffer.from('PNG'))) return undefined;
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

function lintWorkbuddy(m: Record<string, unknown>, outDir: string, mcpRef?: string): ManifestIssue[] {
  const out: ManifestIssue[] = [];
  for (const field of ['displayName', 'profession', 'displayDescription']) {
    localized(m[field], field, out);
  }
  const desc = m.displayDescription;
  const zh = isRecord(desc) && typeof desc.zh === 'string' ? desc.zh : undefined;
  if (zh) {
    const n = hanzi(zh);
    if (n < 40 || n > 50) out.push({ severity: 'warning', message: `displayDescription.zh is ${n} hanzi - the market wants 40-50` });
  }

  if (typeof m.avatar !== 'string' || !m.avatar) {
    out.push({ severity: 'error', message: 'avatar is required' });
  } else {
    if (!/\.(png|jpe?g)$/i.test(m.avatar)) out.push({ severity: 'warning', message: `avatar ${m.avatar}: the market wants PNG or JPG` });
    const file = path.join(outDir, m.avatar);
    if (!existsSync(file)) out.push({ severity: 'error', message: `avatar file missing from the package: ${m.avatar}` });
    else {
      const bytes = readFileSync(file);
      if (bytes.length > 500 * 1024) out.push({ severity: 'warning', message: 'avatar exceeds the 500KB market limit' });
      const dims = pngSize(bytes);
      if (dims && (dims[0] !== 512 || dims[1] !== 512)) out.push({ severity: 'warning', message: `avatar is ${dims[0]}x${dims[1]} - the market wants 512x512` });
    }
  }

  if (typeof m.categoryId !== 'string' || !m.categoryId) out.push({ severity: 'error', message: 'categoryId is required' });

  const listingOf3 = (value: unknown, field: string): readonly unknown[] | undefined => {
    if (!Array.isArray(value) || value.length !== 3) {
      out.push({ severity: 'error', message: `${field} must list exactly 3` });
      return undefined;
    }
    value.forEach((item, i) => localized(item, `${field}[${i}]`, out));
    return value;
  };
  const prompts = listingOf3(m.quickPrompts, 'quickPrompts');
  listingOf3(m.tags, 'tags');

  if (m.defaultInitPrompt === undefined) out.push({ severity: 'error', message: 'defaultInitPrompt is required' });
  else if (JSON.stringify(m.defaultInitPrompt) !== JSON.stringify(prompts?.[0])) {
    out.push({ severity: 'error', message: 'defaultInitPrompt must equal quickPrompts[0]' });
  }

  const deps = m.dependencies;
  if (m.plugin !== m.name) out.push({ severity: 'error', message: 'plugin must equal name' });
  if (isRecord(m.mcpServers)) {
    out.push({ severity: 'warning', message: 'top-level mcpServers is undocumented for the market - declare MCP via dependencies.mcpServers pointing at ./.mcp.json' });
  } else if (mcpRef && (!isRecord(deps) || deps.mcpServers !== mcpRef)) {
    out.push({ severity: 'error', message: `dependencies.mcpServers must be "${mcpRef}" - without the pointer the shipped MCP file is never loaded` });
  }
  if (m.expertType !== 'agent' && m.expertType !== 'team') {
    out.push({ severity: 'error', message: 'expertType must be "agent" or "team"' });
  } else if (m.expertType === 'team' && !isRecord(m.teamInfo)) {
    out.push({ severity: 'error', message: 'expertType team requires teamInfo' });
  }
  const stems = (Array.isArray(m.agents) ? m.agents : [])
    .filter((a): a is string => typeof a === 'string')
    .map((a) => path.basename(a).replace(/\.md$/, ''));
  if (typeof m.agentName !== 'string' || !stems.includes(m.agentName)) {
    out.push({ severity: 'error', message: `agentName must match an agents/ file stem (${stems.join(', ') || 'none declared'})` });
  }

  const author = m.author;
  if (!isRecord(author) || typeof author.email !== 'string' || !author.email) {
    out.push({ severity: 'warning', message: 'author.email is missing - the market requires {name, email}' });
  }
  return out;
}

export function lintManifest(manifest: Record<string, unknown>, preset: PresetName, outDir: string, mcpRef?: string): ManifestIssue[] {
  if (preset === 'workbuddy') return lintWorkbuddy(manifest, outDir, mcpRef);
  return [];
}

// ─── package-tree lint: reference integrity ──────────────────────────────────

// A relative path with an extension, preceded by a non-path character so
// absolute (~/.x, /usr/bin/tar) and bare-filename mentions do not match.
const ASSET_REF =
  /(?:^|[\s`"'<>=(:;*[\]，、。；：（）【「】」])([A-Za-z0-9_][\w.@-]*(?:\/[\w.@-]+)+\.[A-Za-z0-9]{2,8})/g;

function* shippedDocs(outDir: string, preset: Preset): Generator<{ file: string; base: string }> {
  const agents = path.join(outDir, preset.agentsDir);
  if (existsSync(agents)) {
    for (const e of readdirSync(agents)) {
      if (e.endsWith('.md')) yield { file: path.join(agents, e), base: outDir };
    }
  }
  const skills = path.join(outDir, preset.skillsDir);
  if (!existsSync(skills)) return;
  for (const skill of readdirSync(skills)) {
    const md = path.join(skills, skill, 'SKILL.md');
    if (existsSync(md)) yield { file: md, base: path.join(skills, skill) };
  }
}

// The market rejects packages whose docs reference files they do not contain;
// check the shipped trees the same way on every build, for every preset.
// Directory-tree diagrams state the parent dir on its own line (`plugins/`)
// with `├──`-prefixed children after it; those children resolve against the
// last bare-dir line so tree entries are checked too, not skipped.
export function lintPackageTree(outDir: string, preset: Preset): ManifestIssue[] {
  const out: ManifestIssue[] = [];
  for (const { file, base } of shippedDocs(outDir, preset)) {
    const rel = path.relative(outDir, file);
    const lines = readFileSync(file, 'utf8').split('\n');
    let dirPrefix = '';
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (/^[A-Za-z0-9_][\w.@-]*\/$/.test(trimmed)) {
        dirPrefix = trimmed;
        continue;
      }
      const inTree = /^[├└│─]/.test(trimmed);
      if (!inTree) dirPrefix = '';
      const line = lines[i]
        .replace(/https?:\/\/\S+/g, '') // URLs are not file references
        .replace(/<[^<>]*>\//g, ''); // <skill-abs-path>/-style placeholders
      for (const m of line.matchAll(ASSET_REF)) {
        const target = path.resolve(base, inTree ? dirPrefix + m[1] : m[1]);
        if (!existsSync(target)) {
          out.push({ severity: 'error', message: `${rel}:${i + 1} references missing file: ${dirPrefix}${m[1]}` });
        }
      }
    }
  }
  return out;
}
