# harness-pack design

## 1. Scope and non-goals

A builder with **no business logic**: it takes the skill release views, persona
files, and MCP wiring declared by a bundle repo, compiles them into per-harness
release artifacts, and records a sha256 for every artifact file.

What it does:

- run the content repo's own build commands (`build`);
- collect release views and lay them out per preset (envelope location,
  `skills/` and `agents/` directories, MCP placement);
- stamp the version into each harness's manifest template;
- write the `dist/release.json` release manifest that downstream pins by
  sha256.

What it does not do (boundaries):

- **Content shape**: which files ship, how sources become release artifacts,
  and how doc references are rewritten — all owned by the content repo; this
  tool offers no prune/rewrite primitives;
- **Install and distribution**: each harness's own mechanism (Claude
  marketplace, Codex marketplace, custom updaters);
- **Business formats**: `build` only runs commands defined by the content repo;
  this tool does not understand artifact formats;
- **Product field structure**: how fields are spelled and where they land come
  entirely from the target manifest template and preset. Persona display
  **values** are the exception: platforms present a bundle as a person
  (humanized avatar, name, title), so those values are canonicalized in the
  `display` layer (§4) — values belong to content, fields belong to the
  harness.

## 2. Layers and ownership

| Layer | Owner | Content |
|---|---|---|
| Content shape | Skill repo | `make pack` produces `release/<name>/`: pruning, packaging, reference rewriting |
| Composition and metadata | Bundle repo | Which skills to ship, target list, manifest templates, persona values (`display`), version |
| Harness mechanics | harness-pack | Preset layout, manifest placement, MCP wiring, `release.json` |

The test is "who owns this knowledge": a new plugin variant should only touch
that skill repo; a new target harness should only touch the packer's preset
data; changing the release composition should only touch the bundle's
`pack.yaml`.

Pushing envelope layout down into every bundle repo makes each repo copy three
layouts and let them drift — exactly why the industry has no reusable
multi-harness tool. Pulling content pruning up into the packer makes a skill
repo's release shape depend on external configuration, so adding a variant
means editing someone else's file. Neither is acceptable.

## 3. Release view convention

A skill repo's `make pack` produces `release/<skill-name>/`:

- the directory name must equal the `name` in `SKILL.md` frontmatter (`lint`
  checks this);
- only shipping files belong here — the typical approach is `git archive HEAD`
  plus `.gitattributes` `export-ignore` pruning, with the build script doing
  the packaging and reference rewriting;
- packaged artifacts (such as a signed and encrypted `.goblin`) are generated
  inside the view; source files do not enter it;
- the view directory is gitignored by the skill repo and never versioned.

A bundle repo's `skills` points at these views; `build` generates them before
collection. `git archive` reads committed content, so a release view
corresponds to a commit/tag and is reproducible by construction.

## 4. Configuration reference (pack.yaml)

| Key | Meaning |
|---|---|
| `name` / `version` | Package name; the version can be overridden with `--version` (CI injects a tag) |
| `skills[]` | Skill release views, copied to `<preset skills dir>/<basename>` |
| `lint[]` | Optional: source skill directories to validate; defaults to the `skills` views |
| `agents[]` | Persona files or directories, copied to `<preset agents dir>/<basename>` |
| `include[]` | Other root entries (files or directories) copied verbatim into every target root |
| `build[]` | Commands run in order in the bundle root; any non-zero exit fails the build |
| `mcp{}` | stdio servers shared by all targets; `{{root}}` in any server string is rendered by the preset into that harness's plugin-root reference; `displayName`/`description`/`icon`/`auth` are canonical connector-card metadata, rendered into the envelope if the preset has one (workbuddy → `x-workbuddy`) and stripped otherwise |
| `display{}` | Persona layer: persona platforms (which present the bundle as a person) render these keys via `{{display.*}}`; `name` is always the tool id (install directory, pin name, plugin/agentName) and is never a display fallback |
| `targets{}` | Target name → `{preset, manifest, mcp?, display?, outDir?}`; `mcp` merges over the bundle-level declarations by server name; `display` overrides the persona layer **whole-key** (platform media differences, such as a market that only accepts PNG avatars: the key swaps files, it is not a deep merge) |

**Manifest templates**: `{{name}}`/`{{version}}`/`{{display.*}}` (dotted
paths) are substituted first, then the result is parsed as JSON; a parse
failure fails the build. Tokens always sit inside template quotes: when a
token fills an entire string it splices any JSON value (the quotes are
consumed); embedded in longer text it must resolve to a string; an undeclared
key fails the build — persona output comes only from display keys and never
silently falls back to `name`. Harness structural fields (categoryId,
expertType, `$schema`, etc.) still live entirely in the template.

**Manifest lint**: preset platform-listing rules are encoded in
`src/manifest-lint.ts` and run against the **rendered** manifest on every
build, so listing requirements are written once and content repos do not copy
platform docs: structural problems (missing display fields, `plugin != name`,
`defaultInitPrompt` not equal to `quickPrompts[0]`, tags/quickPrompts counts,
agentName not matching an `agents/` filename, missing avatar file) are errors
that block the build and prevent `release.json` from being written; market-copy
policy (Chinese copy 40-50 characters, avatar PNG/JPG 512×512 ≤500KB,
`author.email`) is a warning printed to stderr. **Reference integrity**
(`lintPackageTree`) is the one universal rule: for every preset's shipped tree
it checks relative path references in `SKILL.md` and agent docs (including
parent-directory resolution in directory-tree diagrams); a missing reference is
an error that blocks the build — a build-time equivalent of the market review's
"missing bundled file" category.

**Build order**: build → lint (validate `lint` sources or release views) →
collect → apply envelope → release.json. Build runs first because the shipping
target is the release view, and spec validation should target the tree that
actually ships; `make lint` (which only runs the lint command) needs no build
toolchain when `lint` points at source directories.

## 5. Presets

| preset | manifest | skills | agents | MCP |
|---|---|---|---|---|
| `workbuddy` | `.codebuddy-plugin/plugin.json` | `skills/` | `agents/` | root `.mcp.json` (`{{root}}` = `.`), with the manifest pointing at it via `dependencies.mcpServers: "./.mcp.json"` — the open-platform documented form; the expert dependency service reads services in the order dependencies → top-level `mcpServers` → root file, and resolves `./` args against the declaring file's directory (the plugin root) |
| `claude-code` | `.claude-plugin/plugin.json` | `skills/` | `agents/` | `.mcp.json` (`{mcpServers: ...}`, `{{root}}` = `${CLAUDE_PLUGIN_ROOT}`) |
| `codex` | `plugin.json` (root, Agent Plugins 1.0 portable core) | `skills/` | `agents/` | `mcp.json` (`$schema` + `{mcpServers: ...}`, `{{root}}` = `.`) |

- The `codex` artifact can also serve as a cross-harness portable core: Codex
  also reads Claude-format marketplaces. Codex does not expand
  `${PLUGIN_ROOT}` in MCP configs, so the preset adds `type: stdio` to every
  server and defaults `cwd` to `"./"` — Codex resolves a relative `cwd`
  against the plugin root, so relative launch scripts work.
- **MCP `{{root}}`**: the bundle writes the launch command once; the preset
  renders it into each harness's plugin-root syntax. Claude Code expands
  `${CLAUDE_PLUGIN_ROOT}`; WorkBuddy's **expert** dependency service resolves
  `./`-prefixed args against the install directory; Codex uses a relative
  `cwd`. `${CODEBUDDY_PLUGIN_ROOT}` belongs to the app's built-in plugin
  loader, not the expert publishing channel.
- Target names are decoupled from presets: the same preset can be declared
  multiple times (for example two variants with different manifest templates
  and `outDir`s).

## 6. Release manifest contract

`dist/release.json`:

```json
{
  "generator": "harness-pack/0.2.0",
  "name": "my-bundle",
  "version": "1.2.3",
  "generatedAt": "2026-11-23T00:00:00.000Z",
  "targets": {
    "workbuddy": { "files": { "skills/x/SKILL.md": { "sha256": "...", "bytes": 1234 } } }
  }
}
```

Consumers (updaters, CI, distribution scripts) pin by "version + per-file
sha256" as the sole authority; the artifact directory itself can be reproduced
from a build of the same version at any time.

## 7. Typical wiring

A business repo (such as `goblin-helper`) in a tag pipeline:

```
git submodule update --init
npx harness-pack@0.2.0 build --config pack.yaml --version "$CI_COMMIT_TAG"
# collects the release views produced by the bundle's build steps → applies envelopes
# → dist/workbuddy/, dist/claude-code/, dist/codex/, dist/release.json
```

The distribution repo stores only a small pin file (version plus the sha256 of
the distribution artifact itself — on the WorkBuddy side, the market-upload
zip; `release.json`'s per-file hashes verify artifact contents). On each
session sync it downloads, verifies, and unpacks the artifact, then hands it to
the existing assembly steps. Assembly steps only know the artifact directory
layout and are decoupled from the packer.

## 8. Compatibility and evolution

- Node >= 20, ESM, TypeScript; the only runtime dependency is `yaml`.
- Presets are **data** (`src/presets.ts`): adding a harness means one preset
  entry plus a template, with no pipeline changes.
- Not built yet, add on demand: zip/tar artifact packaging (currently emits
  directories; compression is left to CI), `marketplace.json` generation,
  official schema validation and `claude plugin validate` integration, and
  resolving sources directly from a git remote (currently reads the local tree
  only).

## 9. Decision record

| Decision | Rationale |
|---|---|
| Node/TypeScript over Python | Target repos and the consumption chain (Node updaters, npm distribution, CI) are all in the Node ecosystem |
| MIT | Open source; no commercial licensing goal |
| No prune/rewrite; content shape belongs to the content repo | Pruning and reference rewriting are content-repo knowledge; pulling them into a generic tool would make a skill repo's release shape depend on external configuration |
| Keep envelope/manifest placement/release.json | Harness layout is cross-repo shared mechanics that no single bundle repo can reimplement without degrading into per-repo adapters |
| Manifests from templates, not code generation | Harness fields differ widely and evolve quickly; templates make new fields zero-code |
| Canonicalize persona values in the `display` layer, keep field structure in templates | Platforms like WorkBuddy present experts as people rather than tools; values belong to the content repo and are declared once for reuse across harnesses; platform differences (PNG vs SVG avatars) use whole-key target overrides, and output never comes from the tool id |
| Per-preset manifest lint in the build | Platform listing rules should be written once and apply to the actually rendered manifest; the warning/error split separates "broken package" from "market will not accept it" |
| Canonicalize MCP connector-card metadata; presets render it into their envelopes | Connector-card copy (name, description, icon, auth) is content, while `x-workbuddy` is platform-specific; bundles do not write harness-private keys, the same division as `{{root}}` |
| Build is a command list | Packaging knowledge (variants, naming, keys, formats) belongs to the content repo; the generic tool only runs commands |
| Build before lint | The shipping target is the release view; when `lint` points at source directories there is a fast path that needs no build toolchain |
