// Per-harness development deployment: how a freshly built artifact runs on
// this machine, keyed by preset (mechanics per preset: see the README's
// install-dev section).
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PRESETS, type PresetName } from './presets.js';

export interface DevTarget {
  key: string;
  outDir: string;
  preset: PresetName;
}

// WorkBuddy: my-experts is a real marketplace directory the app scans on
// every listing (re-reading each plugin dir and reconciling the manifest
// itself), so deploying is rm+copy, one marketplace entry, and dropping the
// app's plugin cache - the app copies plugins out of that cache only when the
// entry is missing, so dropping it is what makes the next summon pick up the
// new content. Same flow as teamai's updater, minus the pin machinery.
function devInstallWorkbuddy(target: DevTarget): string {
  const cfg = process.env.WORKBUDDY_HOME ?? path.join(homedir(), '.workbuddy');
  const myExperts = path.join(cfg, 'plugins', 'marketplaces', 'my-experts');
  const manifest: Record<string, unknown> = JSON.parse(
    readFileSync(path.join(target.outDir, PRESETS.workbuddy.manifestDest), 'utf8'),
  );
  const name = typeof manifest.name === 'string' && manifest.name ? manifest.name : target.key;
  const pluginDir = path.join(myExperts, 'plugins', name);
  rmSync(pluginDir, { recursive: true, force: true });
  cpSync(target.outDir, pluginDir, { recursive: true });

  // The expert card reads `avatar` (the app resolves it to a data URL), but
  // the selection/assistant badge reads only `avatarUrl` and accepts file://
  // URLs; the app never maps one to the other for custom experts.
  if (typeof manifest.avatar === 'string' && manifest.avatar
    && !/^(https?|data|file):/.test(manifest.avatar) && !manifest.avatarUrl) {
    const patched = { ...manifest, avatarUrl: pathToFileURL(path.join(pluginDir, manifest.avatar)).href };
    writeFileSync(path.join(pluginDir, PRESETS.workbuddy.manifestDest), `${JSON.stringify(patched, null, 2)}\n`);
  }

  const entry = {
    name,
    source: `./plugins/${name}`,
    ...(typeof manifest.description === 'string' ? { description: manifest.description } : {}),
    ...(typeof manifest.version === 'string' && manifest.version ? { version: manifest.version } : {}),
  };
  const marketplaceFile = path.join(myExperts, '.codebuddy-plugin', 'marketplace.json');
  const marketplace: { name?: string; description?: string; plugins?: { name: string; source: string }[] } = {};
  try {
    Object.assign(marketplace, JSON.parse(readFileSync(marketplaceFile, 'utf8')));
  } catch { /* fresh marketplace */ }
  // Dedupe by name and source, the app's own manifest reconcile keys.
  const plugins = (marketplace.plugins ?? []).filter((e) => e.name !== entry.name && e.source !== entry.source);
  plugins.push(entry);
  mkdirSync(path.dirname(marketplaceFile), { recursive: true });
  writeFileSync(marketplaceFile, `${JSON.stringify({
    name: marketplace.name ?? 'my-experts',
    description: marketplace.description ?? 'my-experts marketplace (auto-generated)',
    plugins,
  }, null, 2)}\n`);

  rmSync(path.join(cfg, 'plugins', 'cache', 'my-experts', name), { recursive: true, force: true });
  return `dev-installed ${name} (${entry.version ?? 'unversioned'}) into ${myExperts} (cache invalidated) - summon it straight from the expert picker`;
}

const DEV_INSTALLERS: Record<PresetName, (target: DevTarget) => string> = {
  workbuddy: devInstallWorkbuddy,
  // Claude Code loads a plugin directory in place for one session; nothing to
  // install and no refresh step beyond /reload-plugins.
  'claude-code': ({ outDir }) => `load in place: claude --plugin-dir ${outDir}`
    + ' (session-scoped <name>@inline, shadows the installed same-name plugin; /reload-plugins picks up edits)',
  // Codex has no in-place plugin loading: local-marketplace installs load a
  // cache copy, so the documented loop is reinstall + restart. Its skills are
  // the exception - they load in place from ~/.agents/skills.
  codex: ({ outDir }) => `codex loads installed plugins from a cache copy - reinstall from your local marketplace and restart Codex`
    + ` (artifact: ${outDir}; for in-place iteration symlink skills/ entries into ~/.agents/skills)`,
};

export function devInstall(target: DevTarget): string {
  return DEV_INSTALLERS[target.preset](target);
}
