# DSH MiMo Connect

[English](./README.en.md) | 中文

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19.0%20%7C%7C%20%3E%3D24-339933.svg)](https://nodejs.org)
[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-0.1.5%20%7C%200.1.6%20%7C%200.1.7-4B6BFB.svg)](https://github.com/deepseek-ai/deepseek-harness)

将小米 **MiMo** 的模型接入 DeepSeek Harness，在 DSH 对话窗口里直接使用。

**不依赖 MiMo Switch，没有常驻进程，没有开机自启。**

## 功能

- **桌面端已登录即零配置**：完全不需要任何操作，MiMo 模型直接出现在选择器里。
- **不需要装桌面端**：也可以让插件单独登录一次，与桌面端无关。
- **无后台程序**：不启动任何代理、不注入进程、不写注册表自启项。
- **跟随账号**：桌面端切换账号或退出登录，插件自动跟随。
- **图片输入**：模型支持图片时可直接粘贴。
- **思考过程可见**：模型的思维链以流式事件呈现（不提供无效的推理档位选择器，原因见下）。

## 安装

```sh
dsh plugin --profile desktop add dsh-mimo-connect
dsh --profile desktop
```

（把 `desktop` 换成你实际使用的 profile：`web` / `desktop` / `dsh-tui`）

装好后在模型选择器里选择 `MiMo` 分组下的模型即可。

## 凭证来源

插件按下面的顺序解析凭证，**前者存在就不打扰你**：

| 顺序 | 来源 | 说明 |
|---|---|---|
| 1 | `$DSH_HOME/.mimo-connect-auth.json` | 插件自己登录后保存 |
| 2 | MiMo 桌面端 cookie | **只读**复用，不修改桌面端任何文件 |
| 3 | 都没有 | 提示运行 `login` 命令 |

桌面端 cookie 的读取位置：

```text
%APPDATA%\Xiaomi MiMo\Partitions\xiaomi-account\Network\Cookies
```

该文件是 Chromium 的标准 SQLite cookie 库，插件**复制到临时文件后只读查询**，避免与运行中的桌面端争锁。MiMo 的 cookie 值是**明文存储**的（`value` 有值、`encrypted_value` 为空），因此不需要 DPAPI 解密。

## 命令行

```sh
dsh plugin --profile desktop exec dsh-mimo-connect status    # 查看登录状态
dsh plugin --profile desktop exec dsh-mimo-connect verify     # 真实调用一次模型
dsh plugin --profile desktop exec dsh-mimo-connect doctor     # 本地诊断
dsh plugin --profile desktop exec dsh-mimo-connect login      # 单独登录（不用桌面端）
dsh plugin --profile desktop exec dsh-mimo-connect logout     # 删除插件自己的凭证
```

### 关于 `login`

小米 passport **不接受第三方回调地址**（返回「Callback连接不合法」），且 `passToken` 是 `HttpOnly`，浏览器 JS 读不到。因此无法做成「点一下自动登录」。

`login` 会给出逐步指引：打开登录页 → 从开发者工具的 Application → Cookies 里复制三个值粘贴回来。插件会立即验证凭证可用后才保存。

**如果你已经装了 MiMo 桌面端，就不需要 `login`** —— 直接复用即可。

## 工作原理

```text
凭证（passToken / cUserId / userId）
   ↓  STS 换取（3 步重定向）
serviceToken
   ↓  作为 Cookie 请求头
mimo-server-cn.xiaomimimo.com/api/route/chat/completions
```

真实端点是 OpenAI 兼容协议，**没有协议翻译层**。`model.headers` 把 cookie 直接注入 pi-ai 构造的请求，因此也不需要本地 shim。

### 附件服务

插件把宿主的 `attachments` 服务接入适配器。这不是可选项：dsh-llm-pi-ai 只要发现消息里含图片块而拿不到附件服务，就会抛 `UNSUPPORTED_CONTENT`——**连纯文本轮次也会失败**，只要该会话更早的工具结果里出现过图片。

从其他模型（如 WorkBuddy）切换到 MiMo 时最容易触发，因为历史上下文会被带过来。相关回归测试见 `tests/image-guard.mjs`。

### 一个关键实现细节

网关按域校验身份：把 `.xiaomi.com` 与 `.account.xiaomi.com` 的 cookie **混在一个请求头里发送**会导致会话被判失效，返回 `EXPIRED` 并踢回登录页。插件为此实现了按域隔离的 cookie jar，并且同名 cookie 只发送一次（取最具体域的值）。这条规则由 `tests/cookie-jar.mjs` 与 `tests/session.mjs` 中专门的回归测试守护。

## 配置

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `cookieDb` | 空 | 显式指定桌面端 cookie 库路径 |
| `pollSeconds` | `30` | 重新检查凭证的间隔（秒）；`0` 关闭轮询 |

环境变量 `MIMO_COOKIE_DB` 可覆盖 cookie 库位置。

## 模型

| ID | 显示名 | 倍率 |
|---|---|---|
| `mimo-v2.6-flash` | MiMo V2.6 Flash | x0.40 |
| `mimo-v2.6-pro` | MiMo V2.6 Pro | x1.00 |

倍率是桌面端显示的点数消耗系数，仅作展示，不影响请求。

网关**没有模型列表接口**（`/api/route/models` 等均返回 404），所以这份清单是内置快照，取自桌面端 `model-catalog.json` 的 TEXT 条目。

### 没有推理档位选择器

模型选择器里**不会**出现 Off / Minimal / Low / Medium / High 档位。这是有意为之。

这些模型确实会产出思维链（以 `reasoning_content` 返回，在 DSH 中表现为流式的思考过程），但网关**忽略所有实测过的控制参数**：

| 参数 | 推理 token 数 |
|---|---|
| 默认 | 176 / 211 |
| `thinking: { type: 'disabled' }` | 179 |
| `thinking: { enabled: false }` | 237 |
| `reasoning_effort: 'none'` | 181 |
| `reasoning_effort: 'low'` | 205 |
| `enable_thinking: false` | 210 |

全部无效。与其显示一个「调了没反应」的选择器，不如不显示。

## 关于响应速度

实测数据表明**延迟来自上游网关，不是插件**：

| 环节 | 耗时 |
|---|---|
| 会话缓存命中 | 0 ms |
| cookie 头构造 | < 0.01 ms |
| DNS 解析 | 9–28 ms |
| 网络往返（不含推理） | 37–169 ms |
| **一次完整对话** | **1–19 秒（波动极大）** |

同一句「你好」，实测耗时从 1 秒到 19 秒都在出现。绕过插件的裸 `fetch` 请求分布与经插件的请求完全重合，说明插件没有引入可测量的开销。

由于网关忽略推理档位参数，目前**没有插件层面的提速手段**。

## 已知限制

- **依赖非公开接口**。插件使用桌面端自身的端点与凭证，非小米官方开放 API；上游变更后可能需要跟随调整。
- **响应速度受上游影响**。延迟波动较大，插件无法控制。
- **凭证有效期**。`passToken` 实测有效期 30 天；过期后需重新登录（桌面端或 `login`）。
- **`serviceToken` 需要短期续期**。插件在会话内自动重换，遇到 401 会重试一次。
- **配额由小米控制**。插件只转发请求，不改变额度、限流或账号权限。

## 开发

```sh
node tests/cookie-jar.mjs      # 域隔离（关键回归）
node tests/credential.mjs      # 凭证来源与优先级
node tests/session.mjs         # STS 链路（含实网）
node tests/integration.mjs     # 对真实 DSH 类（含实网 pi-ai 调用）
node tests/entry.mjs           # 插件生命周期与零提示保证
node tests/boot-safety.mjs     # 不会触发 DSH 恢复模式
```

部分套件在检测到可用凭证时会执行真实网络调用，否则自动跳过。

## 免责声明

- 本项目**仅供个人学习和研究使用**，仅驱动使用者自己的 MiMo 账号在本机调用，请勿用于商业用途或超出个人合理使用的场景。
- 使用者需遵守小米的服务条款；因使用本项目产生的任何后果（包括但不限于账号被限制、额度被清空、服务中断），由使用者自行承担。
- 本项目与小米、Xiaomi MiMo、DeepSeek 均无关联，未获其授权或认可；文中出现的名称仅用于描述兼容关系，其商标权利归各自所有。

## 致谢

- [dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)（MIT）—— 插件组织方式、provider 注册与 `PiAiAdapter` 组装的参照。

## 许可证

[MIT](./LICENSE)
