# DSH Vertex AI 插件 (`dsh-vertex-plugin`)

**[English](./README.md)**

> **VectorDuct 核心原语：Direct Cloud Bridge（云端直连桥接层）** ([vectorduct.com](https://vectorduct.com/#stack))

面向 DeepSeek Harness (DSH) 的原生 Google Cloud Vertex AI 接入插件。支持使用用户自有的 Google Cloud 项目与 IAM 服务账号 JSON 密钥（`BYOC`），直接连接 Google 官方 OAuth 2.0 与 Vertex AI 端点执行模型推理。

## 核心能力与兼容范围

- **目标运行环境**：适配 `DSH 0.2.2-rc.2` 与 `Node.js 24.9+`（支持 Linux 与 Windows）。
- **完整的 Gemini 协议支持**：支持多轮对话、SSE 文本流式输出、思考摘要（Thinking Summaries）、工具调用（Tool Calls/Results）、思维签名回放（Thought-Signature Replay），以及通过 DSH 附件服务进行标准化处理的图像输入。
- **模型目录自动发现**：支持分页拉取 Google 官方发布的模型列表，并支持手动添加自定义 Gemini 模型 ID 及覆盖区域端点（如 `global`、`us-central1` 等）。
- **思考等级与预算控制**：针对受支持的 Gemini 2.5+ 系列模型，自动映射 `thinkingLevel` 或显式 Token 思考预算（Thinking Budget）。
- **直连 BYOC 架构**：直接向 Google 官方接口发起请求，不经过任何第三方中转代理，不共享凭据池。

## 安装指南

请先按 DSH 官方文档安装对应版本的 DSH 与 `pnpm`。

### 从发布包 (`.tgz`) 安装

可通过 DSH 界面（**Plugins → Add plugin → local package**）或命令行安装：

```bash
dsh plugin --profile web add /absolute/path/dsh-vertex-json-0.1.0.tgz
dsh web --no-open
```

Windows PowerShell：

```powershell
dsh plugin --profile web add "C:\path\to\dsh-vertex-json-0.1.0.tgz"
dsh web --no-open
```

### 从源码构建

```bash
npm ci
npm run build
npm pack
```

## 配置与使用

1. **配置服务账号凭据**：

    打开 DSH 的 **Settings → Credentials**，找到 **Vertex AI (service-account JSON)**，通过掩码输入框或宿主机文件路径导入 Google Cloud IAM 服务账号 JSON 密钥，并填写 Project ID 与 Region（留空则默认使用 JSON 内的项目 ID 与 `global` 区域）。

2. **调整插件参数**：

    进入 **Plugins → Installed plugins → Vertex AI (JSON)**，可按需配置项目/区域覆盖、采样温度、最大输出 Token 或思考预算。点击 **Refresh model catalog** 即可同步可用模型列表。

3. **选择模型并调用**：

    在 DSH 模型选择器中选中 **Vertex AI (JSON)** 及目标 Gemini 模型即可开始对话。请确保您的 Google Cloud 项目已启用 Vertex AI API（`aiplatform.googleapis.com`）、已绑定有效结算账户并授予服务账号相应的 IAM 权限。

### 多模态图像限制
图像输入通过 DSH 附件服务进行标准化读取，单张图片编码前上限为 `4 MiB`，单次请求 Base64 图像总载荷上限为 `16 MiB`。

## 安全与凭据隔离

- **官方 OAuth 2.0 鉴权**：严格校验 `type: service_account` 与 RSA 私钥格式，自动剥离导入文件中自定义的重定向端点字段，通过官方 `google-auth-library` 获取短期访问令牌并合并刷新请求。
- **宿主机凭据隔离**：服务账号 JSON 保存在 DSH 原生凭据存储中，绝不写入插件普通配置文件，在远程 Web 模式下亦不会下发至浏览器端。
- **脱敏错误诊断**：异常日志仅保留 Google HTTP 状态码与重试延迟头，自动剥离上游响应正文、令牌与提示词内容。

## 开发与测试

```bash
npm ci
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

## 卸载插件

在 **Settings → Credentials** 中移除对应的 Vertex 凭据后，执行以下命令卸载插件：

```bash
dsh plugin --profile web remove dsh-vertex-json
```

## 开源许可

MIT License. 由 [VectorDuct](https://vectorduct.com) 维护。
