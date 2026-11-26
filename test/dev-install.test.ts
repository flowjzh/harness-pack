import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { devInstall } from '../src/dev-install.js';
import { build, tempDir } from './helpers.js';

describe('install-dev', () => {
  it('deploys the workbuddy artifact into my-experts with a manifest entry and drops the app cache', () => {
    const wbHome = tempDir();
    process.env.WORKBUDDY_HOME = wbHome;
    onTestFinished(() => { delete process.env.WORKBUDDY_HOME; });

    const myExperts = path.join(wbHome, 'plugins', 'marketplaces', 'my-experts');
    // A stale copy, a warm app cache, and a marketplace with a foreign entry:
    // all three must be reconciled by the deploy.
    mkdirSync(path.join(myExperts, 'plugins', 'demo-bundle'), { recursive: true });
    mkdirSync(path.join(wbHome, 'plugins', 'cache', 'my-experts', 'demo-bundle'), { recursive: true });
    mkdirSync(path.join(myExperts, '.codebuddy-plugin'), { recursive: true });
    writeFileSync(path.join(myExperts, '.codebuddy-plugin', 'marketplace.json'), JSON.stringify({
      name: 'my-experts', plugins: [
        { name: 'demo-bundle', source: './plugins/demo-bundle', version: '0.0.0' },
        { name: 'other-expert', source: './plugins/other-expert' },
      ],
    }));

    const result = build({ targets: ['workbuddy'] });
    const line = devInstall(result.targets[0]);
    expect(line).toContain('dev-installed demo-bundle');
    expect(line).toContain('my-experts');

    const pluginDir = path.join(myExperts, 'plugins', 'demo-bundle');
    expect(existsSync(path.join(pluginDir, '.codebuddy-plugin/plugin.json'))).toBe(true);
    expect(existsSync(path.join(pluginDir, '.mcp.json'))).toBe(true);
    // The badge reads avatarUrl; the built manifest has none, so the installed
    // copy gets the file:// patch.
    const installed = JSON.parse(readFileSync(path.join(pluginDir, '.codebuddy-plugin/plugin.json'), 'utf8'));
    expect(installed.avatarUrl).toMatch(/^file:\/.*expert\.png$/);

    const marketplace = JSON.parse(readFileSync(path.join(myExperts, '.codebuddy-plugin', 'marketplace.json'), 'utf8'));
    expect(marketplace.plugins).toEqual([
      { name: 'other-expert', source: './plugins/other-expert' },
      { name: 'demo-bundle', source: './plugins/demo-bundle', description: 'Demo bundle for harness-pack tests', version: '0.0.0' },
    ]);
    expect(existsSync(path.join(wbHome, 'plugins', 'cache', 'my-experts', 'demo-bundle'))).toBe(false);
  });

  it('reports in-place and cache-copy harnesses without touching the filesystem', () => {
    const claude = devInstall({ key: 'claude-code', outDir: '/tmp/x/claude-code', preset: 'claude-code' });
    expect(claude).toContain('--plugin-dir /tmp/x/claude-code');
    expect(claude).toContain('/reload-plugins');
    const codex = devInstall({ key: 'codex', outDir: '/tmp/x/codex', preset: 'codex' });
    expect(codex).toContain('cache copy');
    expect(codex).toContain('~/.agents/skills');
  });

  it('sets HARNESS_PACK_DEV=1 for build steps only when installing for dev', () => {
    const probe = (dev: boolean) => {
      let root = '';
      build({ targets: ['codex'], dev }, (r) => {
        root = r;
        writeFileSync(path.join(r, 'pack.yaml'), readFileSync(path.join(r, 'pack.yaml'), 'utf8')
          .replace('- node scripts/pack.mjs', "- node scripts/pack.mjs\n  - node -e \"require('fs').writeFileSync('devenv.txt', process.env.HARNESS_PACK_DEV ?? 'unset')\""));
      });
      return readFileSync(path.join(root, 'devenv.txt'), 'utf8');
    };
    expect(probe(true)).toBe('1');
    expect(probe(false)).toBe('unset');
  });
});
