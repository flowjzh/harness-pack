// Per-harness layout conventions. A preset answers four questions: where the
// manifest lands, where skills and agents go, how the MCP declaration is
// placed, and how a built artifact runs on this machine for development (the
// installers live in src/dev-install.ts, keyed by preset). Everything else
// about a target's content comes from the bundle's own templates and config.

export type PresetName = 'claude-code' | 'codex' | 'workbuddy';

export interface McpPlacement {
  mode: 'embed' | 'file';
  // File mode: the JSON path inside the artifact ('.mcp.json' / 'mcp.json').
  // Embed mode: the key injected into the parsed manifest ('mcpServers').
  dest: string;
  // Replaces the bundle's {{root}} token in server strings. Each preset spells
  // its harness's own plugin root: the harness expands the token at load/spawn
  // time, so the artifact carries no machine-specific paths.
  root: string;
  // File mode: emitted as the first member. Agent Plugins requires it.
  schema?: string;
  // Applied to a server that does not set the field itself.
  serverDefaults?: Record<string, unknown>;
  // Envelope key for per-server presentation metadata (displayName /
  // description / icon / auth). Undefined = the harness has no such concept
  // and the keys are stripped from the artifact.
  metaKey?: string;
}

export interface Preset {
  manifestDest: string;
  skillsDir: string;
  agentsDir: string;
  mcp: McpPlacement;
}

export const PRESETS: Record<PresetName, Preset> = {
  // Claude Code plugin: manifest at .claude-plugin/plugin.json, MCP servers
  // declared in a sibling-rooted .mcp.json (the plugin default location).
  'claude-code': {
    manifestDest: '.claude-plugin/plugin.json',
    skillsDir: 'skills',
    agentsDir: 'agents',
    mcp: { mode: 'file', dest: '.mcp.json', root: '${CLAUDE_PLUGIN_ROOT}' },
  },
  // Codex plugin (Agent Plugins 1.0 portable core): manifest at the root,
  // MCP servers in mcp.json. Codex also reads Claude-format marketplaces, so
  // this artifact doubles as a portable core for cross-posting.
  //
  // Codex does not expand ${PLUGIN_ROOT} in MCP configs; it resolves a
  // relative cwd from the plugin root and defaults it to the plugin root.
  // Relative args therefore resolve, and the spec's closed stdio variant
  // needs an explicit type.
  codex: {
    manifestDest: 'plugin.json',
    skillsDir: 'skills',
    agentsDir: 'agents',
    mcp: {
      mode: 'file',
      dest: 'mcp.json',
      root: '.',
      schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
      serverDefaults: { type: 'stdio', cwd: './' },
    },
  },
  // CodeBuddy-family expert package (WorkBuddy): manifest inside
  // .codebuddy-plugin/, MCP servers in a root .mcp.json referenced by the
  // manifest's dependencies pointer - the open-platform documented form.
  //
  // Expert packages: the open-platform documented MCP form (manifest
  // dependencies pointer + root .mcp.json) and x-workbuddy connector-card
  // metadata. Mechanism notes: docs/design.md preset section.
  workbuddy: {
    manifestDest: '.codebuddy-plugin/plugin.json',
    skillsDir: 'skills',
    agentsDir: 'agents',
    mcp: { mode: 'file', dest: '.mcp.json', root: '.', metaKey: 'x-workbuddy' },
  },
};
