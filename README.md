# harness-pack

One agent bundle in, per-harness release artifacts out.

<img width="896" height="222" src="https://github.com/user-attachments/assets/de199dc5-1ff6-4f03-8820-16bd2d2a4900" />

**Status:** WorkBuddy is the only supported target today. The `claude-code` and
`codex` presets are experimental and not part of the supported surface.

A *bundle* is a source tree holding Agent Skills (`skills/<name>/SKILL.md` plus
whatever files they reference), agent persona files, and an MCP wiring
declaration. `harness-pack` runs the bundle's repo-owned build steps, copies
the resulting release views, stamps a version into a per-harness manifest
template, and emits one artifact directory per target plus `dist/release.json`
with a sha256 for every file.

**Content shape is repo-owned.** What ships, how sources become release
artifacts, and which doc references point at them are decided by the repo that
owns the content: each skill's build step produces a release view directory
(only ship files, packaged artifacts, rewritten references), and `skills`
points at those views. `harness-pack` never prunes or rewrites content — it
only performs the harness-specific mechanics (envelope layout, manifest
placement, MCP declaration, release hashing).

```sh
npx harness-pack@0.2.0 build       --config pack.yaml --version 1.2.3
npx harness-pack@0.2.0 install-dev --config pack.yaml --target workbuddy
npx harness-pack@0.2.0 lint        --config pack.yaml
```

Pin the exact version in build scripts (as above) so a release can be
reproduced; a floating tag would let the packer change under a fixed bundle.

Targets are selected by preset; each target in the config picks one and
supplies its own manifest template:

| preset | artifact layout | MCP declaration |
|---|---|---|
| `workbuddy` | `.codebuddy-plugin/plugin.json`, `skills/`, `agents/` | root `.mcp.json`, `{{root}}` = `.`; the manifest points at it via `dependencies.mcpServers: "./.mcp.json"` (the open-platform documented form; keep that line in the template) |
| `claude-code` | `.claude-plugin/plugin.json`, `skills/`, `agents/` | `.mcp.json`, `{{root}}` = `${CLAUDE_PLUGIN_ROOT}` |
| `codex` | `plugin.json` (Agent Plugins 1.0), `skills/`, `agents/` | `mcp.json` (`$schema`, `type: stdio`, `cwd: "./"`), `{{root}}` = `.` |

## Config

```yaml
name: my-bundle
version: 0.1.0            # or pass --version
skills:                   # release views, copied to <preset skills dir>/<basename>
  - skills/my-skill/release/my-skill
lint:                     # optional: source dirs to validate instead of the views
  - skills/my-skill
agents:                   # optional
  - agents/my-agent.md
include:                  # optional root entries copied verbatim
  - avatars
build:                    # optional commands, run in the bundle root first
  - 'make -C skills/my-skill pack'
mcp:                      # stdio servers shipped with every target
  myserver:
    command: node
    args: ['{{root}}/bin/mcp.mjs']
    displayName: {en: My Tool, zh: 我的工具}   # connector-card metadata:
    description: {en: ..., zh: ...}           # rendered into x-workbuddy by
    icon: ./avatars/my-tool.svg               # workbuddy, stripped elsewhere
display:                  # person layer, rendered via {{display.*}} tokens
  displayName: {en: My Agent, zh: 我的助手}
  profession: {en: Automation Specialist, zh: 自动化专家}
  displayDescription: {en: ..., zh: ...}      # zh: 40-50 hanzi (WorkBuddy rule)
  avatar: avatars/expert.png
  tags: [{en: ..., zh: ...}, {en: ..., zh: ...}, {en: ..., zh: ...}]
  quickPrompts: [{en: ..., zh: ...}, {en: ..., zh: ...}, {en: ..., zh: ...}]
  defaultInitPrompt: {en: ..., zh: ...}       # must equal quickPrompts[0]
targets:
  claude:
    preset: claude-code
    manifest: templates/claude-plugin.json    # {{name}} / {{version}} tokens
    mcp:                   # optional per-target servers, field-merged
      extra: { command: extra-mcp }
  workbuddy:
    preset: workbuddy
    manifest: templates/workbuddy-plugin.json
    display:               # optional whole-key overrides over the layer above
      avatar: avatars/expert-wb.png           # e.g. the market wants PNG
```

- **build** — a plain command list run in the bundle root before assembly.
  Packaging belongs to the repos that own the content (`make -C skills/x pack`,
  `npm pack`, ...); harness-pack only runs the commands. A non-zero exit aborts
  the build.
- **mcp** — stdio servers declared once for all targets. `{{root}}` in any
  string of a server definition is rendered by the preset into that harness's plugin-root
  reference (WorkBuddy's `.`, Claude Code's `${CLAUDE_PLUGIN_ROOT}`, Codex's
  `.` with `cwd: "./"`), so the artifact carries no machine-specific path and
  consumers copy it verbatim. WorkBuddy's expert service resolves `./` args
  against the installed plugin dir; that is the channel the published expert
  package uses.
  `targets.<name>.mcp` merges field-by-field over the bundle-level server of
  the same name: an override replaces only the fields it sets.
  Per-server presentation keys (`displayName` / `description` / `icon` /
  `auth`) are canonical: presets with a metadata envelope render them into it
  (workbuddy → `x-workbuddy`, the connector-card copy; the app strips the
  envelope before writing the user's connector config), presets without one
  strip them from the artifact.
- **display** — the person layer above the canonical schema. Platforms that
  present a bundle as a person (WorkBuddy experts: humanized avatar, name,
  profession) render these keys via `{{display.*}}` tokens (dotted paths
  work, e.g. `{{display.displayName.en}}`) — persona output comes from these
  keys, never from `name`, which stays the tool id. A token that exactly
  fills a JSON string splices any JSON value; embedded in longer text it must
  resolve to a string; an unresolvable key fails the build.
  `targets.<name>.display` overrides keys wholesale (platform media formats).
- **manifest lint** — per-preset platform rules run on every build against
  the rendered manifests (`src/manifest-lint.ts`), so the official-market
  requirements are encoded once instead of re-checked by each bundle:
  structural problems fail the build (missing listing fields, `plugin != name`,
  `defaultInitPrompt != quickPrompts[0]`, tags/quickPrompts count, agentName
  not matching an `agents/` stem, avatar file missing); market-copy policy
  warns on stderr (zh word count, avatar format/size, `author.email`). One
  universal check runs for every preset: reference integrity of the shipped
  tree — a `SKILL.md` or agent doc referencing a file the package does not
  contain fails the build (the market's "missing file" rejection, caught
  before submission).
- **install-dev** — build (same gates as a release), then deploy each target
  to that harness's development location on this machine, for the
  edit-summon-verify loop. What "deploy" means is preset mechanics:

  | preset | behavior |
  |---|---|
  | `workbuddy` | install into the local `my-experts` marketplace (`WORKBUDDY_HOME` or `~/.workbuddy`): replace `plugins/my-experts/plugins/<name>/`, upsert the marketplace entry, drop the app's plugin cache, patch `avatarUrl` onto the installed manifest; summon it straight from the expert picker (the app rescans the marketplace on demand) |
  | `claude-code` | load in place — print `claude --plugin-dir <dist dir>`; edits are picked up by `/reload-plugins`, nothing to install |
  | `codex` | print the documented loop (cache-copy install via a local marketplace; skills iterate in place via `~/.agents/skills`) |

  Build steps run with `HARNESS_PACK_DEV=1`, so repo-owned view scripts may
  assemble from working trees (uncommitted edits included) instead of
  committed archives — pruning and packaging stay exactly as a release.
  Deployed dev copies are normal marketplace entries: the market copy of the
  same-named expert stays installed, and per session the summoned one wins
  (local resolution prefers `my-experts`); delete the dev copy to fall back.
- **lint** — checks `SKILL.md` against the portable subset of the
  [Agent Skills spec](https://agentskills.io/specification): frontmatter
  `name`/`description` present, `name` matches the directory and is
  kebab-case, non-standard frontmatter fields warn. It validates `lint` paths
  when given, else the `skills` release views; `make lint` therefore works
  before any build toolchain is installed.

See [docs/design.md](docs/design.md) for the rationale, layering and the
release contract.

## Development

```sh
pnpm install
pnpm test
pnpm build      # tsc -> dist/
```

## License

MIT
