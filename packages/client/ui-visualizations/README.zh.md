---
description: "会话内 HTML、ECharts 和 Mermaid 预览，支持隔离执行、源码查看、日期戳下载和部署限制。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-visualizations

[English](README.md) | 中文

## 概述

在助手回复中查看显式标记的 HTML 面板、ECharts 图表和 Mermaid 图示。可切换预览与源码、放大当前框架，并下载原始源码或支持的导出格式。交互仅影响预览；被回收的文档重新打开后恢复作者设定的初始值。普通代码仍显示源码。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将本包与 Web Host、助手 Chat 渲染器、语言及主题提供方一起挂载。Host 将经过验证的限制注入浏览器首页；Client 只有收到该注入后才注册仅用于助手内容的链选择器。

仅执行助手内容中显式闭合的顶层围栏：`html preview runtime=dsh-v1`、`html preview runtime=dsh-v1 libs=echarts` 或 `mermaid preview runtime=dsh-v1`。未知或重复元数据会显示局部诊断并保留可读源码。未闭合围栏显示生成状态，且不会加载运行时资源。

| 配置字段 | 默认值 | 含义 |
|---|---|---|
| `maxSourceBytes` | `262144` | 每个代码块的 UTF-8 源码字节上限 |
| `maxExportBytes` | `33554432` | 完整下载内容解码后的字节上限 |
| `maxActiveFrames` | `4` | 本次 Client 注册的活跃文档数量上限 |
| `minHeight` / `maxHeight` | `180` / `640` | CSS 像素高度范围；超出内容在内部滚动 |
| `readinessTimeoutMs` | `15000` | 就绪和导出响应的超时时间 |

限制值必须为正整数，且 `minHeight` 不得超过 `maxHeight`。修改 Host 限制后需重新加载浏览器页面。视口回收和显式激活共同执行全局数量限制。切换源码与预览或放大时会保留活跃 iframe 及其输入值。

HTML 下载会嵌入 Bootstrap 及所有声明的库，并恢复原始源码。Mermaid 支持 SVG 导出；通过 `dsh.chart(element, option)` 创建的图表支持 PNG 导出，多图表时可选择目标。导出须由用户操作触发，文件名采用清理后的标题、本地 `YYYYMMDD` 日期和重复名称的 `_02` 序号。无法执行时仍可下载源码。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节 — 点击展开</summary>

[清单](src/runtime-manifest.ts) 将 `dsh-v1` 固定为 Bootstrap 5.3.8、ECharts 6.1.0 和 Mermaid 11.16.0。按类型划分的源码资源块按需加载，仅共享不可变的库字节。构建产物保留各库许可证、ECharts 声明及其 d3 许可证，以及 Popper 和 zrender 许可证。浏览器入口不包含这些库的实现。

[文档构建器](src/client/runtime/document.ts) 在可信引导代码之前放置限制性 CSP。不透明的 `allow-scripts` 框架自行创建已打包脚本的 Blob URL，建立绑定生成代次的私有端口，然后执行作者内容。[通信桥](src/client/runtime/bridge.ts) 接受有界的就绪、高度和错误消息，以及仅用于退出放大的框架内 Escape 通知，仅接收已请求且 MIME 经过检查的导出，不提供 Host 调度器。辅助函数调用后的有界图表清单更新 PNG 操作与图表选择器。释放时会结束端口、超时任务、观察器及等待中的读取者。

[预览组件](src/client/Preview.tsx) 消费框架绑定的主题及数量限制快照。Bootstrap 接收公开颜色和字体设置；`dsh.chart` 应用视觉默认值，返回原生 ECharts 实例，并负责尺寸观察和释放。主题更新保留作者 HTML 与图表交互。Mermaid 在框架内以严格安全模式渲染，其 SVG 不会进入应用 DOM。

HTML 构建会等待外层文档的原生 load，安装作者 DOM，再按源码顺序运行作者脚本。内联模块及可执行脚本资源完成后，触发一次会冒泡的作者 `DOMContentLoaded` 事件并报告就绪。该事件用于初始化普通监听器，`document.readyState` 仍为 `complete`；这是合成事件，并非新的导航。离线 HTML 使用相同初始化过程。脚本失败或文档释放会在就绪前停止初始化。

不发布运行时 invariant companion，因为框架状态与数量限制标识均由单个 Client 注册拥有，不存在可供比较的独立 Host 观测。定向生命周期测试覆盖注册释放、旧生成代次失效和活跃数量限制；构建运行时 e2e 检查验证清单、按需资源块、许可证与独立经典脚本。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [Chat](../ui-chat/README.zh.md) — 助手围栏的所有权。
- [Slots](../../../docs/subsystems/slots.zh.md) — 派生属性与副作用生命周期。
- [测试](../../../docs/testing.zh.md) — 源码与产物检查。

-----

<a id="model-experience"></a>
## 模型体验

### 助手源码

#### 模型看到什么

查看器不新增提示词、工具定义或 Session 事件。现有助手消息包含完整源码、内联数据、运行时标识 `dsh-v1` 及声明的库；渲染会读取该文本。

#### Token 影响

预览控件与交互状态不消耗模型 token。作者源码仍属于普通助手回复的一部分。

#### KV Cache 影响

渲染与下载不会改变已记录消息或模型请求。现有助手文本保持通常的历史与缓存行为。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

浏览器隔离具有以下限制。

- 脚本主动导航可能离开受控文档；下一次加载会结束其通信端口，并提供重新加载与源码。CSP 无法普遍阻止此类导航。
- 主线程死循环可能阻塞浏览器及就绪计时器。更强的 CPU 隔离需要另一种运行时。
- 输入值、筛选条件和 DOM 状态均为临时状态。回收、重试及重新打开会话会恢复原始源码。任意 HTML 不支持图像导出；仅由辅助函数创建的 ECharts 图表支持 PNG。
- 不支持远程资源、fetch、Worker、嵌套框架、Host 访问、包安装与 JSX 编译。下载的 HTML 会在用户浏览器中执行，不再处于应用 iframe 内。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
