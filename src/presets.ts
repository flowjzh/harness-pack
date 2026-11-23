// Per-harness layout conventions. A preset answers exactly three questions:
// where the manifest lands, where skills and agents go, and how the MCP
// declaration is placed. Everything else about a target's content comes from
// the bundle's own templates and config.

export type PresetName = 'claude-code' | 'codex' | 'workbuddy';

export interface McpPlacement {
  mode: 'embed' | 'file';
  // File mode: the JSON path inside the artifact ('.mcp.json' / 'mcp.json').
  // Embed mode: the key injected into the parsed manifest ('mcpServers').
  dest: string;
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
    mcp: { mode: 'file', dest: '.mcp.json' },
  },
  // Codex plugin (Agent Plugins 1.0 portable core): manifest at the root,
  // MCP servers in mcp.json. Codex also reads Claude-format marketplaces, so
  // this artifact doubles as a portable core for cross-posting.
  codex: {
    manifestDest: 'plugin.json',
    skillsDir: 'skills',
    agentsDir: 'agents',
    mcp: { mode: 'file', dest: 'mcp.json' },
  },
  // CodeBuddy-family expert package (WorkBuddy): manifest inside
  // .codebuddy-plugin/, MCP servers embedded in the manifest as mcpServers.
  // A commandFromPlatform entry in a server def survives untouched — the
  // consuming deploy step resolves it against the machine's platform file.
  workbuddy: {
    manifestDest: '.codebuddy-plugin/plugin.json',
    skillsDir: 'skills',
    agentsDir: 'agents',
    mcp: { mode: 'embed', dest: 'mcpServers' },
  },
};
