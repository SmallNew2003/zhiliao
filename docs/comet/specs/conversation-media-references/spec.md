# 会话媒体与文件引用

## 工作区相对路径图片解析

前端 `AssistantMarkdown` 必须支持将会话工作区 `cwd` 与相对图片路径拼接，生成同源 `/api/file` 地址。

### Scenario: 解析并渲染相对路径图片

- **WHEN** Agent 输出 `![图表](charts/figure.png)` 且提供有效 `cwd`
- **THEN** 前端构造指向 `/api/file?path=...` 的请求地址并在界面中渲染图片

## 系统提示词指引

系统提示词必须包含明确的文件引用与图片嵌入指导。

### Scenario: 提示词包含图片嵌入指引

- **WHEN** 挂载 `ui-deliverables` 插件并装配提示词
- **THEN** 提示词文本明确指示使用 `![alt](path)` 嵌入图片
