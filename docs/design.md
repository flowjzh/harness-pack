# harness-pack 设计

## 1. 定位与非目标

一个**不含任何业务逻辑**的构建器：把 bundle 仓声明的技能发布视图、人设文件
与 MCP 接线，编译成按 harness 区分的发布产物，并给每个产物文件记 sha256。

做：

- 执行内容仓自己的构建命令（`build`）；
- 采集发布视图 → 按 preset 布局落盘（信封位置、skills/agents 目录、MCP 接法）；
- 版本戳注入各 harness 的 manifest 模板；
- `dist/release.json` 发布清单，供下游按 sha256 pin。

不做（边界）：

- **内容形态**：哪些文件出货、源文件如何变成发布产物、文档引用如何改写——
  全部属于内容仓，本工具不提供 prune/rewrite 之类的原语；
- **安装/分发**：各 harness 自己的机制（Claude marketplace、Codex
  marketplace、自研更新器）；
- **业务格式**：`build` 只是执行内容仓定义的命令，本工具不认识产物格式；
- **产品字段语义**：全部来自目标 manifest 模板与 preset。

## 2. 分层与责任边界

| 层 | 拥有者 | 内容 |
|---|---|---|
| 内容形态 | 技能仓 | `make pack` 产出 `release/<name>/`：剪裁、打包、引用改写 |
| 组合与元数据 | bundle 仓 | 选哪些技能、目标清单、manifest 模板、版本 |
| harness 机械 | harness-pack | preset 布局、manifest 落位、MCP 接法、release.json |

判断标准是「这条知识属于谁」：新增一个插件变体只该改那个技能仓；新增一个
目标 harness 只该改 packer 的 preset 数据；改发布组合只该改 bundle 的
`pack.yaml`。

把信封布局下沉到每个 bundle 仓的后果是每个仓抄一遍三套布局并各自漂移——
这正是业界没有可复用多 harness 工具的原因；把内容剪裁上收到 packer 的后果
是技能仓的发布形态由外部配置决定，技能仓加变体要改别人家的文件。两边都不取。

## 3. 发布视图约定

技能仓的 `make pack` 负责产出 `release/<skill-name>/`：

- 目录名必须等于 `SKILL.md` frontmatter 的 `name`（`lint` 会校验）；
- 只含要出货的文件——典型做法是 `git archive HEAD` + `.gitattributes` 的
  `export-ignore` 声明剪裁，构建脚本再做打包与引用改写；
- 打包产物（如签名加密的 `.goblin`）在视图内生成，源文件不进入视图；
- 视图目录由技能仓 gitignore，不进版本控制。

bundle 仓的 `skills` 指向这些视图；`build` 负责在采集前把它们生成出来。
`git archive` 取的是已提交内容，因此发布视图对应某个 commit/tag，
天然可复现。

## 4. 配置参考（pack.yaml）

| 键 | 语义 |
|---|---|
| `name` / `version` | 包名；版本可用 `--version` 覆盖（CI 用 tag 注入） |
| `skills[]` | 技能发布视图，复制为 `<preset 技能目录>/<basename>` |
| `lint[]` | 可选：规范校验的源技能目录；缺省校验 `skills` 视图 |
| `agents[]` | 人设文件或目录，复制为 `<preset 人设目录>/<basename>` |
| `include[]` | 其余根条目（文件或目录）原样进入每个目标的根 |
| `build[]` | 在包根顺序执行的命令；任一非零退出即失败 |
| `targets{}` | 目标名 → `{preset, manifest, mcp?, outDir?}` |

**manifest 模板**：`{{name}}`/`{{version}}` 先做字面替换，再按 JSON 解析；
解析失败即构建失败。各 harness 的字段差异（displayName、quickPrompts、
`$schema` 等）全部写在模板里。

**构建顺序**：build → lint（校验 `lint` 源或发布视图）→ 采集 → 套信封 →
release.json。先 build 是因为出货对象是发布视图，规范校验应针对真正上架的
那棵树；`make lint`（只跑 lint 命令）在 `lint` 指向源目录时不需要构建工具链。

## 5. Preset

| preset | manifest | skills | agents | MCP |
|---|---|---|---|---|
| `claude-code` | `.claude-plugin/plugin.json` | `skills/` | `agents/` | `.mcp.json`（`{mcpServers: ...}`） |
| `codex` | `plugin.json`（根，Agent Plugins 1.0 portable core） | `skills/` | `agents/` | `mcp.json`（`{mcpServers: ...}`） |
| `workbuddy` | `.codebuddy-plugin/plugin.json` | `skills/` | `agents/` | 嵌入 manifest 的 `mcpServers` 键 |

- `codex` 产物同时可作跨家 portable core：Codex 亦兼容读 Claude 格式的
  marketplace。
- `workbuddy` 的 server 条目里若出现平台相关声明（如
  `commandFromPlatform`），本工具**原样透传**——解析发生在消费方的部署步骤。
- 目标名与 preset 解耦：同一个 preset 可声明多次（例如两个不同 manifest
  模板、不同 `outDir` 的变体）。

## 6. 发布清单契约

`dist/release.json`：

```json
{
  "generator": "harness-pack/0.1.0",
  "name": "my-bundle",
  "version": "1.2.3",
  "generatedAt": "2026-11-23T00:00:00.000Z",
  "targets": {
    "workbuddy": { "files": { "skills/x/SKILL.md": { "sha256": "...", "bytes": 1234 } } }
  }
}
```

消费方（更新器 / CI / 分发脚本）以「版本 + 各文件 sha256」为唯一 pin 依据；
产物目录本身可随时从同一版本的构建重现。

## 7. 典型接线

业务仓（如 `goblin-helper`）在 tag 流水线里：

```
git submodule update --init
harness-pack build --config pack.yaml --version "$CI_COMMIT_TAG"
# build 调用各技能仓的 pack 目标 → 采集发布视图 → 套信封
# → dist/workbuddy/、dist/claude-code/、dist/codex/、dist/release.json
```

分发仓只存一个小 pin 文件（版本 + `release.json` 的 sha256），每次会话同步
时下载、校验、解包，再交给既有的装配步骤。装配步骤只认产物目录布局，与
打包器解耦。

## 8. 兼容与演进

- Node >= 20，ESM，TypeScript；运行时依赖仅 `yaml`。
- preset 是**数据**（`src/presets.ts`），新增 harness = 一个 preset 条目 +
  模板，不动流水线。
- 未做实、按需再加：产物打包为 zip/tar（当前输出目录，压缩交给 CI）、
  `marketplace.json` 生成、官方 schema 校验与 `claude plugin validate` 的
  集成、从 git 远端直接解析源（当前只读本地树）。

## 9. 决策记录

| 决策 | 理由 |
|---|---|
| Node/TS 而非 Python | 目标仓与消费链（Node 更新器、npm 分发、CI）都在 Node 生态 |
| MIT | 未来开源；无商业授权诉求 |
| 不提供 prune/rewrite，内容形态归内容仓 | 剪裁与引用改写是内容仓的知识；上收到通用工具会让技能仓的发布形态由外部配置决定 |
| 保留信封/manifest 落位/release.json | harness 布局是跨仓共享的机械，不可由单个 bundle 仓重复实现；否则退化为 per-repo adapter |
| manifest 用模板而非代码生成 | harness 字段差异大且演化快；模板让新增字段零代码 |
| build 是命令列表 | 打包知识（变体、命名、密钥、格式）属于内容仓；通用工具只负责执行命令 |
| 先 build 后 lint | 出货对象是发布视图；`lint` 指向源目录时另走快路径，不需要构建工具链 |
