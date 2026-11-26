#!/usr/bin/env node
import path from 'node:path';
import { runBuild, runLint } from './pipeline.js';
import { devInstall } from './dev-install.js';
import { ConfigError } from './config.js';
import type { BuildOptions } from './types.js';

const USAGE = `harness-pack — pack one agent bundle into per-harness artifacts

Usage:
  harness-pack build       [--config <pack.yaml>] [--target <name>]... [--version <v>]
                           [--out <dir>]
  harness-pack install-dev [--config <pack.yaml>] [--target <name>]... [--version <v>]
  harness-pack lint        [--config <pack.yaml>]

Defaults: --config pack.yaml, --out <config-dir>/dist. --version overrides the
config's version. --target narrows the build (repeatable). install-dev builds
like a release, then deploys each target to that harness's development
location on this machine (see the README's install-dev section).`;

interface Args extends BuildOptions {
  command?: string;
  targets: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: argv.shift(), configPath: 'pack.yaml', targets: [] };
  const rest = [...argv];
  while (rest.length > 0) {
    const flag = rest.shift()!;
    const value = () => {
      const v = rest.shift();
      if (v === undefined) throw new ConfigError(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case '--config': args.configPath = value(); break;
      case '--target': args.targets.push(value()); break;
      case '--version': args.version = value(); break;
      case '--out': args.outDir = value(); break;
      case '-h': case '--help': args.command = 'help'; break;
      default: throw new ConfigError(`unknown argument '${flag}'`);
    }
  }
  return args;
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if (!args.command || args.command === 'help') {
    console.log(USAGE);
    return args.command ? 0 : 1;
  }
  try {
    if (args.command === 'build' || args.command === 'install-dev') {
      const { command: _command, ...opts } = args;
      const result = runBuild({
        ...opts,
        dev: args.command === 'install-dev',
        configPath: path.resolve(args.configPath),
        targets: args.targets.length ? args.targets : undefined,
      });
      if (args.command === 'install-dev') {
        for (const t of result.targets) console.log(devInstall(t));
      } else {
        for (const t of result.targets) {
          console.log(`built ${t.key}: ${path.relative(process.cwd(), t.outDir)} (${t.fileCount} files)`);
        }
        console.log(`release manifest: ${path.relative(process.cwd(), result.releasePath)}`);
      }
      return 0;
    }
    if (args.command === 'lint') {
      const issues = runLint(path.resolve(args.configPath));
      for (const i of issues) console.log(`${i.severity}: ${i.skill}: ${i.message}`);
      const errors = issues.filter((i) => i.severity === 'error').length;
      console.log(issues.length === 0 ? 'lint clean' : `${issues.length} issue(s), ${errors} error(s)`);
      return errors > 0 ? 1 : 0;
    }
    throw new ConfigError(`unknown command '${args.command}'`);
  } catch (e) {
    console.error(`harness-pack: ${e instanceof Error ? e.message : e}`);
    return e instanceof ConfigError ? 2 : 1;
  }
}

process.exit(main());
