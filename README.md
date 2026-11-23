# harness-pack

One agent bundle in, per-harness release artifacts out.

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
harness-pack build --config pack.yaml --version 1.2.3
harness-pack lint  --config pack.yaml
```

Targets are selected by preset; each target in the config picks one and
supplies its own manifest template:

| preset | artifact layout | MCP declaration |
|---|---|---|
| `claude-code` | `.claude-plugin/plugin.json`, `skills/`, `agents/` | `.mcp.json` at the artifact root |
| `codex` | `plugin.json` (Agent Plugins 1.0), `skills/`, `agents/` | `mcp.json` at the artifact root |
| `workbuddy` | `.codebuddy-plugin/plugin.json`, `skills/`, `agents/` | embedded as `mcpServers` in the manifest |

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
targets:
  claude:
    preset: claude-code
    manifest: templates/claude-plugin.json   # {{name}} / {{version}} tokens
    mcp:
      myserver: { command: my-mcp, args: [serve] }
```

- **build** — a plain command list run in the bundle root before assembly.
  Packaging belongs to the repos that own the content (`make -C skills/x pack`,
  `npm pack`, ...); harness-pack only runs the commands. A non-zero exit aborts
  the build.
- **lint** — checks `SKILL.md` against the portable subset of the
  [Agent Skills spec](https://agentskills.io/specification): frontmatter
  `name`/`description` present, `name` matches the directory and is
  kebab-case, non-standard frontmatter fields warn. It validates `lint` paths
  when given, else the `skills` release views; `make lint` therefore works
  before any build toolchain is installed.

See [docs/design.md](docs/design.md) (Chinese) for the rationale, layering and
the release contract.

## License

MIT
