import type { PresetName } from './presets.js';

// Bundle config schema (pack.yaml). This is the contract between a content
// repo and harness-pack; see docs/design.md for the prose version.
//
// Content shape (what ships, how sources become release artifacts, doc
// references) belongs to the repos that own the content: each skill's `build`
// step is expected to produce a release view directory, and `skills` points
// at those views. harness-pack only performs the harness-specific mechanics.

// Stdio MCP server definition. The bundle writes it once, harness-agnostic:
// {{root}} in any string is replaced by the preset with the harness's own
// plugin-root reference. Non-string fields pass through untouched.
export interface McpServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  // Per-server presentation metadata for harnesses that surface MCP servers
  // as connectable entities (WorkBuddy connector cards render it from
  // x-workbuddy). Presets without such an envelope strip these keys.
  displayName?: Localized;
  description?: Localized;
  // Plugin-root relative path, https:// or data: URL.
  icon?: string;
  // Connect-flow auth declaration (oauth / token / none), token schema
  // included verbatim when the platform requires a credential form.
  auth?: { type?: string; tokenSchema?: unknown };
  [field: string]: unknown;
}

// Localized text: a plain string reads the same in every locale; the {en, zh}
// form follows the WorkBuddy LocalizedString convention (render by UI
// language, fall back zh -> en).
export type Localized = string | { en?: string; zh?: string };

// The person layer above the canonical schema. Platforms that present a
// bundle as a person (WorkBuddy experts: humanized avatar, name, profession)
// render these keys - never `name`, which stays the bundle's tool id
// (installed dir, pin name, plugin/agentName).
export interface DisplayConfig {
  displayName?: Localized;
  profession?: Localized;
  displayDescription?: Localized;
  // Bundle-root relative; per-target overrides swap the file where a platform
  // demands another format (e.g. PNG where the market bans SVG).
  avatar?: string;
  tags?: Localized[];
  quickPrompts?: Localized[];
  defaultInitPrompt?: Localized;
}

export interface TargetConfig {
  preset: PresetName;
  // Manifest template path (bundle-root relative). {{name}}, {{version}} and
  // {{display.*}} tokens are substituted, then the file is parsed as JSON and
  // written to the preset's manifest destination.
  manifest: string;
  // Per-target MCP servers, merged by server name over the bundle-level mcp.
  mcp?: Record<string, McpServer>;
  // Whole-key overrides over the canonical display layer.
  display?: Partial<DisplayConfig>;
  // Override the default 'dist/<target>' output directory.
  outDir?: string;
}

export interface PackConfig {
  name: string;
  // Literal version. Optional only when --version is passed on the CLI.
  version?: string;
  // Skill release views (bundle-root relative), usually produced by each
  // skill repo's own pack target.
  skills: string[];
  // Source skill dirs to validate against the Agent Skills spec. Defaults to
  // `skills` (the release views); set this when the views do not exist until
  // build runs, so `harness-pack lint` can work without the build toolchain.
  lint?: string[];
  // Agent persona files or directories.
  agents?: string[];
  // Extra root entries (files or directories) copied verbatim into every
  // target, e.g. avatars/.
  include?: string[];
  // Shell commands run in the bundle root before assembly, in order. The
  // convention is that these produce the release views referenced above;
  // harness-pack only knows how to run them.
  build?: string[];
  // MCP servers shipped with every target. Declared once, rendered per preset:
  // each harness points {{root}} at its own plugin root, so the package stays
  // self-contained (no consumer-side path resolution).
  mcp?: Record<string, McpServer>;
  // Person layer rendered by templates via {{display.*}} tokens.
  display?: DisplayConfig;
  targets: Record<string, TargetConfig>;
}

export interface BuildOptions {
  configPath: string;
  targets?: string[];
  version?: string;
  outDir?: string;
}

export interface LintIssue {
  skill: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface ReleaseManifest {
  generator: string;
  name: string;
  version: string;
  generatedAt: string;
  targets: Record<string, { files: Record<string, { sha256: string; bytes: number }> }>;
}
