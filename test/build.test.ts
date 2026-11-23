import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { runBuild } from '../src/pipeline.js';
import type { BuildOptions } from '../src/types.js';

const fixtureRoot = path.join(import.meta.dirname, 'fixtures', 'minimal');

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'hp-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Build steps write into the source tree by contract, so every test runs on
// its own copy instead of mutating the fixture.
function build(extra: Partial<BuildOptions> = {}) {
  const root = tempDir();
  cpSync(fixtureRoot, root, { recursive: true });
  return runBuild({ configPath: path.join(root, 'pack.yaml'), outDir: path.join(root, 'dist'), ...extra });
}

describe('build', () => {
  it('emits all three presets with built artifacts and rewrites', () => {
    const result = build();
    expect(result.targets.map((t) => t.key)).toEqual(['claude-code', 'codex', 'workbuddy']);

    const claude = result.targets[0].outDir;
    const manifest = JSON.parse(readFileSync(path.join(claude, '.claude-plugin/plugin.json'), 'utf8'));
    expect(manifest).toMatchObject({ name: 'demo-bundle', version: '0.0.0' });
    expect(JSON.parse(readFileSync(path.join(claude, '.mcp.json'), 'utf8'))).toEqual({
      mcpServers: { demo: { command: 'demo-mcp', args: ['serve'] } },
    });

    // build step ran; the release view carries the artifact, not the source
    const pluginDir = path.join(claude, 'skills/demo-skill/plugins');
    expect(existsSync(path.join(pluginDir, 'demo.goblin'))).toBe(true);
    expect(existsSync(path.join(pluginDir, 'demo.rhai'))).toBe(false);
    expect(readFileSync(path.join(claude, 'skills/demo-skill/SKILL.md'), 'utf8')).toContain('demo.goblin');
    // repo-owned pack step decided these do not ship
    expect(existsSync(path.join(claude, 'skills/demo-skill/tests'))).toBe(false);
    expect(existsSync(path.join(claude, 'skills/demo-skill/debug.log'))).toBe(false);
    // include (entry name preserved) + agents
    expect(readFileSync(path.join(claude, 'assets/logo.txt'), 'utf8')).toContain('demo asset');
    expect(existsSync(path.join(claude, 'agents/demo.md'))).toBe(true);
  });

  it('places the workbuddy MCP declaration inside the manifest', () => {
    const result = build({ targets: ['workbuddy'] });
    const dir = result.targets[0].outDir;
    const manifest = JSON.parse(readFileSync(path.join(dir, '.codebuddy-plugin/plugin.json'), 'utf8'));
    expect(manifest.mcpServers).toEqual({ demo: { commandFromPlatform: 'demoCommandCandidates', args: ['mcp'] } });
    expect(existsSync(path.join(dir, '.mcp.json'))).toBe(false);
  });

  it('emits a codex portable core with a root manifest', () => {
    const result = build({ targets: ['codex'] });
    const dir = result.targets[0].outDir;
    expect(existsSync(path.join(dir, 'plugin.json'))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(dir, 'mcp.json'), 'utf8')).mcpServers.demo.command).toBe('demo-mcp');
  });

  it('records sha256 hashes for every artifact file', () => {
    const result = build({ version: '9.9.9' });
    const release = JSON.parse(readFileSync(result.releasePath, 'utf8'));
    expect(release.version).toBe('9.9.9');
    const files = release.targets['claude-code'].files;
    expect(Object.keys(files)).toContain('skills/demo-skill/plugins/demo.goblin');
    expect(files['skills/demo-skill/plugins/demo.goblin'].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fails the build when a repo-owned build step fails', () => {
    const root = tempDir();
    mkdirSync(path.join(root, 'skills/x'), { recursive: true });
    writeFileSync(path.join(root, 'skills/x/SKILL.md'), '---\nname: x\ndescription: x\n---\n');
    writeFileSync(path.join(root, 'pack.yaml'), [
      'name: broken',
      'version: 0.0.0',
      'skills: [skills/x]',
      'build:',
      "  - node -e \"process.exit(3)\"",
      'targets:',
      '  codex:',
      '    preset: codex',
      '    manifest: m.json',
      '',
    ].join('\n'));
    writeFileSync(path.join(root, 'm.json'), '{"name":"{{name}}","version":"{{version}}"}');
    expect(() => runBuild({ configPath: path.join(root, 'pack.yaml'), outDir: path.join(root, 'out') }))
      .toThrow(/build step failed/);
  });
});
