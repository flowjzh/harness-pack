import type { PresetName } from './presets.js';

// Bundle config schema (pack.yaml). This is the contract between a content
// repo and harness-pack; see docs/design.md for the prose version.
//
// Content shape (what ships, how sources become release artifacts, doc
// references) belongs to the repos that own the content: each skill's `build`
// step is expected to produce a release view directory, and `skills` points
// at those views. harness-pack only performs the harness-specific mechanics.

export interface TargetConfig {
  preset: PresetName;
  // Manifest template path (bundle-root relative). {{name}} and {{version}}
  // tokens are substituted, then the file is parsed as JSON and written to
  // the preset's manifest destination.
  manifest: string;
  // MCP servers declaration. Placement (embedded into the manifest vs a
  // dedicated file) is decided by the preset.
  mcp?: Record<string, Record<string, unknown>>;
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
