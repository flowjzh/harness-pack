import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { runBuild } from '../src/pipeline.js';
import type { BuildOptions } from '../src/types.js';

const fixtureRoot = path.join(import.meta.dirname, 'fixtures', 'minimal');

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'hp-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Build steps write into the source tree by contract, so every test runs on
// its own copy instead of mutating the fixture. The optional mutate hook
// patches the copy before the build runs.
function build(extra: Partial<BuildOptions> = {}, mutate?: (root: string) => void) {
  const root = tempDir();
  cpSync(fixtureRoot, root, { recursive: true });
  mutate?.(root);
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
      mcpServers: {
        demo: {
          command: 'node',
          args: ['${CLAUDE_PLUGIN_ROOT}/bin/demo-mcp.mjs'],
          env: { DEMO_HOME: '${CLAUDE_PLUGIN_ROOT}' },
        },
      },
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

  it('writes the workbuddy MCP declaration as the documented dependencies + .mcp.json form', () => {
    const result = build({ targets: ['workbuddy'] });
    const dir = result.targets[0].outDir;
    const manifest = JSON.parse(readFileSync(path.join(dir, '.codebuddy-plugin/plugin.json'), 'utf8'));
    expect(manifest.mcpServers).toBeUndefined();
    expect(manifest.dependencies).toEqual({ mcpServers: './.mcp.json' });
    expect(JSON.parse(readFileSync(path.join(dir, '.mcp.json'), 'utf8'))).toEqual({
      mcpServers: {
        demo: {
          command: 'node',
          args: ['./bin/demo-mcp.mjs'],
          env: { DEMO_HOME: '.' },
          'x-workbuddy': {
            displayName: { en: 'Demo Tool', zh: '演示工具' },
            description: { en: 'Demo MCP server', zh: '演示 MCP 服务' },
            icon: './avatars/expert.png',
          },
        },
        extra: { command: 'extra-mcp' },
      },
    });
  });

  it('emits a codex portable core with a conformant root mcp.json', () => {
    const result = build({ targets: ['codex'] });
    const dir = result.targets[0].outDir;
    expect(existsSync(path.join(dir, 'plugin.json'))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(dir, 'mcp.json'), 'utf8'))).toEqual({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
      mcpServers: {
        demo: {
          type: 'stdio',
          cwd: './',
          command: 'node',
          args: ['./bin/demo-mcp.mjs'],
          env: { DEMO_HOME: '.' },
        },
      },
    });
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

describe('display layer', () => {
  it('renders persona fields from display keys, never from name', () => {
    const result = build({ targets: ['workbuddy'] });
    const manifest = JSON.parse(readFileSync(path.join(result.targets[0].outDir, '.codebuddy-plugin/plugin.json'), 'utf8'));
    expect(manifest).toMatchObject({
      name: 'demo-bundle',
      plugin: 'demo-bundle',
      agentName: 'demo',
      displayName: { en: 'Demo', zh: '演示' },
      profession: { en: 'Demo Specialist', zh: '演示专家' },
      avatar: 'avatars/expert.png',
      defaultInitPrompt: { en: 'Run the demo', zh: '运行演示' },
    });
    expect(manifest.quickPrompts[0]).toEqual(manifest.defaultInitPrompt);
  });

  it('lets a target override display keys wholesale', () => {
    const result = build({ targets: ['workbuddy'] }, (root) => {
      writeFileSync(path.join(root, 'avatars/expert-wb.png'), readFileSync(path.join(root, 'avatars/expert.png')));
      const text = readFileSync(path.join(root, 'pack.yaml'), 'utf8');
      writeFileSync(path.join(root, 'pack.yaml'), `${text}    display:\n      avatar: avatars/expert-wb.png\n`);
    });
    const manifest = JSON.parse(readFileSync(path.join(result.targets[0].outDir, '.codebuddy-plugin/plugin.json'), 'utf8'));
    expect(manifest.avatar).toBe('avatars/expert-wb.png');
    expect(manifest.displayName).toEqual({ en: 'Demo', zh: '演示' });
  });

  it('fails on unresolvable display tokens instead of falling back to name', () => {
    expect(() => build({ targets: ['workbuddy'] }, (root) => {
      const text = readFileSync(path.join(root, 'templates/workbuddy-plugin.json'), 'utf8');
      writeFileSync(path.join(root, 'templates/workbuddy-plugin.json'), text.replace('{{display.displayName}}', '{{display.dispalyName}}'));
    })).toThrow(/\{\{display\.dispalyName\}\} does not resolve/);
  });

  it('fails when a token embedded in text is not a string', () => {
    expect(() => build({ targets: ['codex'] }, (root) => {
      writeFileSync(path.join(root, 'templates/codex-plugin.json'),
        '{"name":"{{name}}","version":"{{version}}","description":"Tool {{display.tags}} for you"}');
    })).toThrow(/must resolve to a string when embedded in text/);
  });

  it('fails the build on workbuddy manifest lint errors and reports warnings', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    onTestFinished(() => errorSpy.mockRestore());

    const text = (root: string) => readFileSync(path.join(root, 'templates/workbuddy-plugin.json'), 'utf8');
    // plugin != name is an error; the missing author.email is only a warning,
    // so the reported failure must be the structural one.
    expect(() => build({ targets: ['workbuddy'] }, (root) => {
      writeFileSync(path.join(root, 'templates/workbuddy-plugin.json'),
        text(root).replace('"plugin": "{{name}}"', '"plugin": "other-name"').replace('"author": { "name": "Demo", "email": "demo@example.com" },', '"author": { "name": "Demo" },'));
    })).toThrow(/plugin must equal name/);
    expect(errorSpy.mock.calls.some((args) => String(args[0]).includes('author.email'))).toBe(true);

    // A manifest without the dependencies pointer ships an MCP file that
    // nothing loads.
    expect(() => build({ targets: ['workbuddy'] }, (root) => {
      writeFileSync(path.join(root, 'templates/workbuddy-plugin.json'),
        text(root).replace('  "dependencies": { "mcpServers": "./.mcp.json" },\n', ''));
    })).toThrow(/dependencies\.mcpServers must be "\.\/\.mcp\.json"/);

    // A conformant manifest builds warning-free.
    const warnings: string[] = [];
    errorSpy.mockImplementation((...args: unknown[]) => warnings.push(args.join(' ')));
    build({ targets: ['workbuddy'] });
    expect(warnings).toEqual([]);
  });

  it('fails the build when a shipped SKILL.md references a missing file', () => {
    const root = tempDir();
    mkdirSync(path.join(root, 'skills/x'), { recursive: true });
    writeFileSync(path.join(root, 'skills/x/SKILL.md'), '---\nname: x\ndescription: x\n---\nRun `plugins/tool.goblin` first.\n');
    writeFileSync(path.join(root, 'pack.yaml'), [
      'name: broken',
      'version: 0.0.0',
      'skills: [skills/x]',
      'targets:',
      '  codex:',
      '    preset: codex',
      '    manifest: m.json',
      '',
    ].join('\n'));
    writeFileSync(path.join(root, 'm.json'), '{"name":"{{name}}","version":"{{version}}"}');
    expect(() => runBuild({ configPath: path.join(root, 'pack.yaml'), outDir: path.join(root, 'out') }))
      .toThrow(/references missing file: plugins\/tool\.goblin/);
  });
});
