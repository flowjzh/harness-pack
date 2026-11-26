import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import type { BuildOptions, McpServer, PackConfig } from './types.js';
import { PRESETS, type PresetName } from './presets.js';

const PRESET_NAMES = Object.keys(PRESETS) as PresetName[];

export type ResolvedConfig = PackConfig & { version: string };

export class ConfigError extends Error {}

function fail(message: string): never {
  throw new ConfigError(message);
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function assertStringArray(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    fail(`${field} must be a list of strings`);
  }
}

// Bundle-level servers are complete definitions; `partial` (target overrides)
// may set any subset, merged field-by-field over the bundle-level server.
function assertMcp(value: unknown, field: string, partial = false): void {
  if (!isRecord(value)) fail(`${field} must be a map of server name to stdio server definition`);
  for (const [name, server] of Object.entries(value)) {
    const where = `${field}.${name}`;
    if (!isRecord(server)) fail(`${where} must be an object`);
    const s = server as McpServer;
    if (!partial && (typeof s.command !== 'string' || !s.command)) fail(`${where}: command is required`);
    if (partial && Object.keys(server).length === 0) fail(`${where}: an override must set at least one field`);
    if (s.args !== undefined) assertStringArray(s.args, `${where}.args`);
    if (s.cwd !== undefined && typeof s.cwd !== 'string') fail(`${where}.cwd must be a string`);
    if (s.env !== undefined && (!isRecord(s.env) || Object.values(s.env).some((v) => typeof v !== 'string'))) {
      fail(`${where}.env must be a map of string values`);
    }
    if (s.displayName !== undefined) assertLocalized(s.displayName, `${where}.displayName`);
    if (s.description !== undefined) assertLocalized(s.description, `${where}.description`);
    if (s.icon !== undefined && (typeof s.icon !== 'string' || !s.icon)) fail(`${where}.icon must be a non-empty path or URL`);
    if (s.auth !== undefined && !isRecord(s.auth)) fail(`${where}.auth must be an object`);
  }
}

function assertLocalized(value: unknown, field: string): void {
  if (typeof value === 'string') return;
  if (isRecord(value) && Object.values(value).every((s) => s === undefined || typeof s === 'string')) return;
  fail(`${field} must be a string or an {en, zh} map of strings`);
}

function assertDisplay(value: unknown, field: string): void {
  if (!isRecord(value)) fail(`${field} must be a map of display keys`);
  for (const key of ['displayName', 'profession', 'displayDescription', 'defaultInitPrompt'] as const) {
    if (value[key] !== undefined) assertLocalized(value[key], `${field}.${key}`);
  }
  for (const key of ['tags', 'quickPrompts'] as const) {
    const list = value[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) fail(`${field}.${key} must be a list of strings or {en, zh} maps`);
    list.forEach((item, i) => assertLocalized(item, `${field}.${key}[${i}]`));
  }
  if (value.avatar !== undefined && (typeof value.avatar !== 'string' || !value.avatar)) {
    fail(`${field}.avatar must be a non-empty bundle-root relative path`);
  }
}

export function loadConfig(configPath: string): PackConfig {
  let raw: unknown;
  try {
    raw = parse(readFileSync(configPath, 'utf8'));
  } catch (e) {
    fail(`cannot read ${configPath}: ${e instanceof Error ? e.message : e}`);
  }
  const cfg = raw as PackConfig;

  if (typeof cfg.name !== 'string' || !cfg.name) fail('name is required');
  if (cfg.version !== undefined && typeof cfg.version !== 'string') fail('version must be a string');
  assertStringArray(cfg.skills, 'skills');
  if (cfg.skills.length === 0) fail('skills must list at least one directory');
  for (const field of ['lint', 'agents', 'include', 'build'] as const) {
    if (cfg[field] !== undefined) assertStringArray(cfg[field], field);
  }
  if (cfg.lint?.length === 0) fail('lint must list at least one directory when set');
  if (cfg.mcp !== undefined) assertMcp(cfg.mcp, 'mcp');
  if (cfg.display !== undefined) assertDisplay(cfg.display, 'display');

  if (!isRecord(cfg.targets) || Object.keys(cfg.targets).length === 0) {
    fail('targets must declare at least one target');
  }
  for (const [key, target] of Object.entries(cfg.targets)) {
    if (!PRESET_NAMES.includes(target.preset)) {
      fail(`targets.${key}: unknown preset '${target.preset}' (known: ${PRESET_NAMES.join(', ')})`);
    }
    if (typeof target.manifest !== 'string' || !target.manifest) {
      fail(`targets.${key}: manifest template path is required`);
    }
    if (target.mcp !== undefined) assertMcp(target.mcp, `targets.${key}.mcp`, true);
    if (target.display !== undefined) assertDisplay(target.display, `targets.${key}.display`);
    if (target.outDir !== undefined && path.isAbsolute(target.outDir)) {
      fail(`targets.${key}: outDir must be relative`);
    }
  }
  return cfg;
}

// CLI flags win over the config file: --version stamps the release, --target
// narrows the build, --out relocates the tree.
export function resolveConfig(cfg: PackConfig, opts: BuildOptions): ResolvedConfig {
  const version = opts.version ?? cfg.version;
  if (!version) fail('no version: pass --version or set version in the config');
  const targets = opts.targets
    ? Object.fromEntries(opts.targets.map((key) => {
        if (!cfg.targets[key]) fail(`unknown target '${key}' (declared: ${Object.keys(cfg.targets).join(', ')})`);
        return [key, cfg.targets[key]];
      }))
    : cfg.targets;
  return { ...cfg, version, targets };
}
