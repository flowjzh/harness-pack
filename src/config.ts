import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import type { BuildOptions, PackConfig } from './types.js';
import { PRESETS, type PresetName } from './presets.js';

const PRESET_NAMES = Object.keys(PRESETS) as PresetName[];

export type ResolvedConfig = PackConfig & { version: string };

export class ConfigError extends Error {}

function fail(message: string): never {
  throw new ConfigError(message);
}

function assertStringArray(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    fail(`${field} must be a list of strings`);
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

  if (cfg.targets === null || typeof cfg.targets !== 'object' || Object.keys(cfg.targets).length === 0) {
    fail('targets must declare at least one target');
  }
  for (const [key, target] of Object.entries(cfg.targets)) {
    if (!PRESET_NAMES.includes(target.preset)) {
      fail(`targets.${key}: unknown preset '${target.preset}' (known: ${PRESET_NAMES.join(', ')})`);
    }
    if (typeof target.manifest !== 'string' || !target.manifest) {
      fail(`targets.${key}: manifest template path is required`);
    }
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
