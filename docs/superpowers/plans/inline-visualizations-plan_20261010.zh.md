# 会话可视化实施计划

[English](inline-visualizations-plan_20261010.md) | 中文

> 执行代理使用 subagent-driven-development 技能，按顺序完成任务并进行独立任务审查。用户已于 2026-10-10 确认开始实现；常规实现选择无需再次确认。

**目标：** 在助手正文中渲染 HTML 面板、ECharts 图表和 Mermaid 图示，提供可复用样式、导出及匹配的模型指令。

**架构：** 纯 Markdown 通过助手拥有的 chain slot 暴露围栏元数据。一个可选可视化插件负责沙箱运行时、控件、资源、配置和 skill provider，由 Web bundle 组合。已有助手文本记录继续负责持久化。

**技术栈：** TypeScript、React、Cordis slots、Bootstrap 5.3.8、ECharts 6.1.0、Mermaid 11.16.0、Vitest 与仓库浏览器测试。

**规格：** [已批准设计](../specs/inline-visualizations-design_20261010.zh.md)。

## 全局约束

- 仅显式标记的助手顶层围栏执行：`html preview runtime=dsh-v1` 或 `mermaid preview runtime=dsh-v1`；HTML 另接受 `libs=echarts`。
- 即使输入已经结束，也必须存在显式闭合围栏；追加正文与流式完成时保留 iframe 身份。
- 使用 `sandbox="allow-scripts"`，不开放同源或 Host 访问；校验跨框架消息与导出字节，生成内容不引用远程依赖。
- 默认：源码 256 KiB、导出 32 MiB、四个活动 iframe、180–640 CSS 像素高度、15 秒就绪超时；可调参数作为经过校验的配置暴露。
- 源码/预览切换与放大保留活动 iframe；淘汰与重新打开恢复编写时初始状态。
- 产品文案使用类型化语言字典；文档保持双语；导出和任务产物使用 YYYYMMDD 命名。
- 使用聚焦 TDD 与真实浏览器证据，不运行全量单测或覆盖率；不包含推送、合并或发布。

## Task 1: Markdown 扩展与助手 slot

**文件：** 更新 `packages/client/ui-primitives/src/markdown/{MarkdownText.tsx,render.tsx,incremental.ts}`、公开入口与 README 配对；更新 `packages/client/ui-chat/src/client/{contract/slots.ts,index.ts,chat/AssistantNodeView.tsx,chat/AssistantMarkdown.tsx,chat/register-node-renderers.ts}`、README 配对和 slot/conversation 参考文档；在两包内增加聚焦测试。

**接口：** 从 ui-primitives 导出以下纯数据和渲染类型；由 assistant-step 渲染器声明会话作用域的 chain slot `conversation.chat.codeBlock`，owner 包含 `block: MarkdownCodeBlock`，普通 CodeBlock 作为 chain fallback。

```typescript
interface MarkdownCodeBlock {
  readonly code: string
  readonly language: string | undefined
  readonly meta: string | undefined
  readonly closed: boolean
  readonly sourceOffset: number
  readonly streaming: boolean
}
type MarkdownCodeBlockRenderer = (block: MarkdownCodeBlock, fallback: ReactNode) => ReactNode
```

- [ ] 在 `tests/markdown-code-block.client.spec.tsx` 先编写失败测试：闭合标记围栏携带原始元数据进入回调；未闭合围栏为 `closed:false`；嵌套、引用和缩进代码不进入回调。使用子组件挂载计数验证 open → closed → appended prose → settled 仅挂载一次，覆盖 CRLF 及更长的波浪线/反引号围栏。
- [ ] 通过 `pnpm run test` 加精确文件过滤运行聚焦测试，记录实现前的预期失败。
- [ ] 为 MarkdownText 增加 `renderCodeBlock?: MarkdownCodeBlockRenderer`。传递解析器确认的顶层源码位置与闭合信息，避免每个 token 重扫完整增长文档。围绕已有 fallback 调用回调，保持普通代码、数学公式、源码复制和现有消费方行为。
- [ ] 在助手节点内使用 `PropsRenderSlots` 与 `renderSlotChain`，仅向 AssistantMarkdown 的 text 块传递渲染器。不得跨插件注入返回 ReactNode 的回调。增加 slot 生命周期测试，验证没有 provider 时的 fallback，以及卸载 provider 后恢复普通源码。
- [ ] 运行新增测试和已有 Markdown、助手渲染测试，更新双语说明并记录配对，然后提交任务；在报告中列出 Task 2 使用的实际接口名称。

## Task 2: 预置沙箱运行时与预览 UI

**文件：** 创建 `packages/client/ui-visualizations/`，包含包清单、独立 Host/Client 编译配置、tsdown 配置、`src/{config.ts,runtime-manifest.ts,index.ts,css-modules.d.ts}`、`src/client/{index.ts,protocol.ts,Preview.tsx,Preview.module.css,locales.ts,budget.ts,downloads.ts}` 和 `src/client/runtime/{document.ts,bridge.ts,assets.ts,html-assets.ts,echarts-assets.ts,mermaid-assets.ts}`。允许在包内用额外小文件分离生命周期职责；更新聚合编译引用和锁文件，增加包 README 配对及归属本包的测试。

**接口：** 消费 Task 1 的 chain slot。纯函数 `parsePreview(block)` 对普通块返回 `undefined`，对显式标记的 HTML/Mermaid 返回带判别字段的有效/错误预览值。运行时清单与 Task 3 共享。`loadRuntimeAssets(kind, libraries)` 按需读取不可变预置字节。Host 导出经过校验的 Config 并将解析值注入浏览器首页；Client 读取这份已解析配置。

```typescript
const runtimeManifest = {
  id: 'dsh-v1',
  libraries: { bootstrap: '5.3.8', echarts: '6.1.0', mermaid: '11.16.0' },
} as const
```

- [ ] 先增加失败的协议/配置测试：必需运行时、重复/未知元数据、无效库、UTF-8 源码超限、无效限制、普通代码绕过，以及未闭合预览不执行。增加迟到消息、显式重试、清理和活动配额生命周期测试，运行聚焦测试建立 RED 证据。
- [ ] 实现协议解析及全局约束中的校验限制。注册可选 chain selector；无效标记输入显示可读诊断，普通代码交给 fallback。配置采用已有 webserver 首页注入模式。
- [ ] 参考已有 PDF 原始资源构建方式，将准确版本的库打包成按需加载的源码字符串资源。Bootstrap 包含 Popper/控件代码；Mermaid 使用自包含浏览器构建和严格渲染配置。产物保留依赖许可证，不在 Client 运行时代码导入 Node API，也不将库加入聊天启动包。
- [ ] 在生成 HTML 之前构造带可信启动代码和 CSP 的不透明 allow-scripts iframe。传递绑定代次的 MessagePort，校验协议字段和负载大小，仅提供 ready/height/error/theme/export 消息。安全序列化源码，覆盖字面闭合 script 标签及 Unicode；阻止普通远程资源与 Host API，记录已批准的自身导航和死循环限制。
- [ ] 实现 Bootstrap 主题映射及 `dsh.chart(element, option)`：合并视觉默认值、返回原生 ECharts 实例、随所属文档调整尺寸与释放，并在主题更新时保留用户输入。提供本地化工具栏、状态与错误文案，源码/预览切换及放大保持同一个 iframe，并恢复键盘焦点。
- [ ] 通过注册拥有的 store 实现同运行时不可变资源复用及活动 iframe 配额；视口淘汰按文档约定重置状态。订阅绑定归属者，丢弃过期导出和加载响应。
- [ ] 实现内嵌声明资源的自包含 HTML 导出、源码下载、严格 Mermaid SVG 导出，以及辅助函数管理的 ECharts PNG 导出和图表选择。下载必须来自显式用户操作，校验字节/MIME 限制，并使用本地 YYYYMMDD 加同日序号命名。
- [ ] 运行包级单元/组件测试与两侧编译，并构建此包。增加构建产物断言，覆盖固定清单、许可证、依赖按需分离和独立资源完整性。更新双语 README，包含必需的不变量说明，然后提交。

## Task 3: 模型指令与正式组合

**文件：** 扩展 `packages/client/ui-visualizations/src/index.ts`，增加提示/skill provider 与三个 `assets/visualize-*/SKILL.md`；按需更新 `packages/core/system-prompt` 提示片段位置声明、`packages/bundle/web-app/{package.json,cordis.patch.yml}`、锁文件、归属 README 与生成目录。

**接口：** 使用 Task 2 的唯一运行时清单和已有 SystemPrompt/SkillProvider API。注册简短 `ui:visualizations` 片段及 `visualize-html`、`visualize-charts`、`visualize-diagrams` skill 名称。skill 正文从资源使用的同一清单派生运行时和依赖标识。

- [ ] 编写并运行失败的 provider 测试，覆盖发现、准确的运行时/库标识、完整正文加载、缺失依赖、功能卸载，以及 Web 插件省略时不出现能力声明。断言普通系统指引不含完整 API 手册。
- [ ] 通过 effect 生命周期注册提示片段与 skill provider，要求使二者可见的服务依赖。说明何时可视化、准确围栏、显式闭合、可用类名/库、内嵌数据、导出限制、临时输入和不可假定的 Host/网络能力。在对应 skill 中分别提供简短 Bootstrap 面板、`dsh.chart` 柱状图和 Mermaid 示例。
- [ ] 在正式 Web bundle 中挂载插件，补齐解析依赖并将资源纳入包 files。headless/默认非 Web 组合不加载此功能；验证卸载会移除 skill 候选和提示贡献。
- [ ] 更新配对包文档中的 Model Experience，使用归属生成器更新配置与模块目录，运行聚焦 provider/组合测试以及约束和相关文档检查；仅提交本任务变更。

## Task 4: 端到端验收与交付证据

**文件：** 增加 `apps/web/tests/inline-visualizations.e2e.ts`，按需添加归属本地的预期输出；通过已有快照测试框架在 `snapshots/session/inline-visualizations/` 增加记录 Session。仅更新受影响生成文档与验证记录；演示产物存入被忽略的 `.playwright-mcp/inline-visualizations-20261010/`。

**接口：** 使用真实正式 `dsh web` profile、`apps/web/tests/pin-browse-picker.overlay.yml`、公开浏览器/SDK 接口及新增提示/运行时。不得新增应用启动器或在真实模型演示中注入合成事件。

- [x] 根据设计验收表增加浏览器回归：真实 iframe 渲染、浅深色和窄宽布局、源码/预览及放大身份、父页面/远程访问阻止、过期 iframe、中断围栏、无效输入、导出内容/命名、离线 HTML 和活动配额。测试拥有并清理自己的服务/夹具状态。
- [x] 通过仓库启动方式运行聚焦浏览器测试，定位失败根因并修复实现，不弱化断言；保持真正的异步清理，不以固定等待判定就绪。
- [ ] 记录真实模型 Session，使用无敏感信息的固定样例数据，加载可视化 skill 并输出三种内容。仅通过应用正常配置的凭据存储获得调用权限；通过已有快照流程规范化并提交场景，无密钥重放并检查所有生成差异。
- [ ] 针对完成后的差异运行相关构建/hygiene、类型检查、lint、文档与记录会话检查；已有无关 Comet 文档失败单独报告，不在此功能中修改那些记录。
- [ ] 提交已验证实现，构建准确提交，再通过浏览器技能录制一次真实模型 Web 演示与 GIF。验证编码产物，并提供中文报告，包含验证行为、限制、提交和本地文件链接。若没有可用真实凭据，完成全部无密钥检查并如实报告缺失的真实模型证据。

## 审查与完成

每个任务在依赖任务开始前接受规格符合性与质量审查，集成后进行整分支审查。用户已经批准开始实现，持续完成可逆实现与修复。保留工作区和功能分支供审阅，不合并或发布。
