# DSH MiMo Connect

[English](./README.en.md) | 中文

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![npm](https://img.shields.io/npm/v/dsh-mimo-connect.svg)](https://www.npmjs.com/package/dsh-mimo-connect)
[![Node](https://img.shields.io/badge/node-%5E22.19.0%20%7C%7C%20%3E%3D24-339933.svg)](https://nodejs.org)
[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-0.1.5%20%7C%200.1.6%20%7C%200.1.7%20%7C%200.2.0-rc.2-4B6BFB.svg)](https://github.com/deepseek-ai/deepseek-harness)

将 MiMo 的模型接入 DeepSeek Harness，在 DSH 对话窗口里使用。

用的是你自己 MiMo 账号的额度——**不需要单独申请 API Key，也不需要额外装常驻程序**。

> ⚠️ **注意：MiMo 桌面端的免费额度已取消。** 这个插件最初是为了把那份免费额度接进 DSH，现在改为走账号自身的额度（订阅或其他已购额度）。插件本身**不提供也不绕过**任何额度，能否使用完全取决于你的账号是否有可用配额。
>
> **已用一个没有订阅的真实账号实测（2026-10-12）**，结论很明确：登录、换取 `serviceToken`、额度查询**全部正常**，但任何一次实际推理都会在生成 token 之前被拒绝：
>
> ```
> HTTP 403  {"error":{"code":"membership_required","biz_code":30012,
>            "message":"未开通会员或会员已到期，请订阅后使用"}}
> ```
>
> 也就是说**插件能走到网关门口，但进不去**——这正是「本插件不提供额度」的具体含义。有一部分结论（推理档位是否生效）因为这道门禁而**至今无法测得**，详见「模型」一节。

![模型选择器中的 MiMo 分组](./docs/model-picker.png)

会话切到 MiMo 时，输入框下方会直接显示剩余额度；用别的模型时它不出现。

![剩余额度与统计行同排](./docs/quota-pill-inline.png)

悬停可看到重置日。

![悬停显示重置日](./docs/quota-pill-hover.jpg)

## 为什么需要它

MiMo 客户端的额度本来只能在客户端里用。想在 DSH 里用上它，通常只有两条路：

| 做法 | 代价 |
|---|---|
| 单独申请平台 API Key | 走的是**平台计费**，与客户端额度是两套账，等于重新花钱 |
| 用第三方反代工具 | 需要**额外装一个常驻程序**，还要配开机自启 |

这个插件是第三条路：**直接复用客户端已经登录的凭证**，把客户端那份额度接进 DSH。不额外申请 Key、不额外装程序、不写开机自启。

## 特性

- **零配置**：客户端已登录，插件装上就能用，不弹任何提示。
- **复用客户端额度**：用的是你在 MiMo 客户端里的那份额度，不是平台计费。
- **无常驻进程**：不启动代理、不注入进程、不写注册表自启项。关掉 DSH 就什么都不剩。
- **剩余额度就地可见**：会话切到 MiMo 时，输入框下方直接显示剩余额度与重置日；用别的模型时它不出现。
- **可脱离客户端使用**：没装客户端也能让插件单独登录一次，之后与客户端无关。
- **跟随账号**：客户端换账号或退出登录，插件自动跟随。
- **支持图片输入**：模型支持时可直接粘贴图片。
- **思考过程可见**：思维链以流式事件呈现。

## 安装

```sh
dsh plugin --profile desktop add dsh-mimo-connect
dsh --profile desktop
```

（把 `desktop` 换成你实际使用的 profile：`web` / `desktop` / `dsh-tui`）

装好后在模型选择器里选择 `MiMo` 分组下的模型即可。

也可以从源码安装：

```sh
dsh plugin --profile desktop add github:anze225-max/dsh-mimo-connect
```

## 凭证来源

插件按下面的顺序解析凭证，**前者存在就不打扰你**：

| 顺序 | 来源 | 说明 |
|---|---|---|
| 1 | `$DSH_HOME/.mimo-connect-auth.json` | 插件自己登录后保存 |
| 2 | MiMo 客户端的 cookie | **只读**复用，不修改客户端任何文件 |
| 3 | 都没有 | 提示运行 `login` 命令 |

客户端的 cookie 读取位置：

```text
%APPDATA%\Xiaomi MiMo\Partitions\xiaomi-account\Network\Cookies
```

该文件是 Chromium 的标准 SQLite cookie 库，插件**复制到临时文件后只读查询**，避免与运行中的客户端争锁。MiMo 的 cookie 值是**明文存储**的（`value` 有值、`encrypted_value` 为空），因此不需要 DPAPI 解密。

## 命令行

```sh
dsh plugin --profile desktop exec dsh-mimo-connect status    # 查看登录状态
dsh plugin --profile desktop exec dsh-mimo-connect verify     # 真实调用一次模型
dsh plugin --profile desktop exec dsh-mimo-connect doctor     # 本地诊断
dsh plugin --profile desktop exec dsh-mimo-connect login      # 单独登录（不用客户端）
dsh plugin --profile desktop exec dsh-mimo-connect logout     # 删除插件自己的凭证
```

### 关于 `login`

> **`login` 需要你手动复制三个值，这一步绕不过去。**

小米 passport **不接受第三方回调地址**（返回「Callback连接不合法」），且 `passToken` 是 `HttpOnly`——网页里的 JavaScript 读不到。两条限制叠加，就没有「点一下自动登录」的余地。

`login` 会给出逐步指引：打开登录页 → 从开发者工具 Application → Cookies 里复制三个值粘贴回来。粘贴成 `passToken=xxxx` 这种整行形式也可以，插件会自动去掉前缀；`cUserId` / `userId` 允许留空，只有 `passToken` 是必需的。插件会**先验证凭证可用**，通过后才保存。

**如果你已经装了 MiMo 客户端，就不需要 `login`** —— 直接复用即可，插件不会弹任何提示。

## 工作原理

```text
客户端凭证（passToken / cUserId / userId）
   ↓  STS 换取（3 步重定向）
serviceToken
   ↓  作为 Cookie 请求头
mimo-server-cn.xiaomimimo.com/api/route/chat/completions
   ↓  标准 OpenAI 协议
DSH 的 LLM seam
```

真实端点是 OpenAI 兼容协议，**没有协议翻译层**。`model.headers` 把 cookie 直接注入 pi-ai 构造的请求，因此也不需要本地 shim。

### 附件服务

插件把宿主的 `attachments` 服务接入适配器。这不是可选项：dsh-llm-pi-ai 只要发现消息里含图片块而拿不到附件服务，就会抛 `UNSUPPORTED_CONTENT`。

另外插件把 `resolveImageAccess` 也接上了（映射到宿主的 `fs` 服务），这样模型拿到的图片句柄会带上归一化副本的只读路径；`fs` 不可用时该句柄只是少一个路径，不会让轮次失败。

相关回归测试见 `tests/image-guard.mjs`。

### 一个关键实现细节

网关按域校验身份：把 `.xiaomi.com` 与 `.account.xiaomi.com` 的 cookie **混在一个请求头里发送**会导致会话被判失效，返回 `EXPIRED` 并踢回登录页。插件为此实现了按域隔离的 cookie jar，并且同名 cookie 只发送一次（取最具体域的值）。这条规则由 `tests/cookie-jar.mjs` 与 `tests/session.mjs` 中专门的回归测试守护。

## 剩余额度显示

会话当前用的是 MiMo 时，输入框下方的统计行右侧会出现一枚额度指示：

```text
● MiMo 剩余 99.8%
```

悬停可看到重置日（例如 `重置于 2026-09-30`）。额度低于 20% 时指示点转为提醒色，低于 5% 转为告警色。

**只有会话路由到 MiMo 时才显示。** 用 DeepSeek 或别的模型时，这一行完全不出现，也不会发出任何额度请求——额度显示属于正在花这份额度的会话，不该出现在无关对话里。

数据来自客户端自己的用量接口：

```text
GET mimo-server-cn.xiaomimimo.com/api/user/usage
→ {"code":0,"message":"success","data":{"percent":0.0,"resetDate":null,"resetAt":null}}
```

> ### ⚠️ 订阅制下这几个字段的含义**已经变了**
>
> 上面是 2026-10-12 用一个**没有订阅**的真实账号实测的原始返回。对比免费额度时期的记录，差异很明显：
>
> | 字段 | 免费额度时期 | 订阅制实测（未订阅） |
> |---|---|---|
> | `percent` | `99.8` = **剩余**百分比 | `0.0` |
> | `resetDate` | `"2026-09-30"` | **`null`** |
> | `resetAt` | `1790782334` | **`null`** |
>
> 接口仍然返回 **200**（凭证有效），但 `resetDate` / `resetAt` 变成了 `null`。所以：
>
> - **重置日在未订阅账号上不会显示**——插件本来就在字段缺失时省略它，所以不会显示一个假的日期；
> - `percent: 0.0` 在「没有订阅」的语境下，最合理的解释是「可用额度为 0」，但这**还没有在订阅账号上验证过**。因此界面文案保持中性（只写「MiMo 剩余 {percent}%」），不断言它一定是「剩余」还是「已用」。
>
> 需要一个**有订阅**的账号运行 `node tools/probe-gateway.mjs usage` 才能最终确定语义。

读取是只读的，不消耗任何额度；结果缓存 60 秒，读失败退避 15 秒，任何失败路径都只是「不显示」，不会影响推理。

实现上，node 半侧注册一条 `/api/mimo.quota` 路由（与其它 `/api` 路由共用同一道浏览器会话校验），浏览器半侧通过 `conversation.composer.dock` 插槽挂载一个组件读取它。宿主没有浏览器连接时（例如 CLI）该路由不注册，provider 照常工作。

## 配置

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `cookieDb` | 空 | 显式指定客户端 cookie 库路径 |
| `pollSeconds` | `30` | 重新检查凭证的间隔（秒）；`0` 关闭轮询 |

环境变量 `MIMO_COOKIE_DB` 可覆盖 cookie 库位置。

## 模型

插件会**尝试**向网关询问模型清单，拿不到就用内置快照：

| 顺序 | 来源 | 说明 |
|---|---|---|
| 1 | `GET /api/route/models` 等 | 有凭证时尝试索取 |
| 2 | 内置快照 | 实际上总是走到这里，`status` 里标注为 `builtin` |

> ### ⚠️ 更正：网关**没有**模型清单接口
>
> 我之前在这个文件里写过「`/api/route/models` 返回 401，说明接口已存在」。**那是错的，现已用真实凭证推翻。**
>
> 错在把 401 当成了「路由存在」的证据。实测（2026-10-12，真实登录凭证）表明：
>
> - `/api/route/` **前缀下的一切路径**，未认证时都返回 401——包括我临时编造的 `/api/route/model/config` 这种肯定不存在的路径；
> - 该前缀**之外**的一切路径返回 404，同样包括编造的路径。
>
> 也就是说 401 是**前缀级的认证门禁**，在路由匹配之前就返回了，它**不能**用来判断某个路由是否存在。
>
> 带着有效凭证复测：`/api/route/models`、`/api/route/model/list` 以及另外 14 条候选路径**全部 404**；而同一时刻真实存在的 `/api/user/usage` 返回 **200**——证明凭证是有效的，404 不是认证问题。**该接口确实不存在。**
>
> 因此插件保留「先问网关」这一步，但它的意义变了：不是为了找当前存在的接口，而是为了**万一将来小米真的上线清单接口，插件无需改代码就能自动跟随**。在那之前，走到快照兜底是**正常且预期**的结果，不是故障。

内置快照因此是实际使用的清单。但它是**实测过的**，不是猜的：

| ID | 显示名 | 倍率 |
|---|---|---|
| `mimo-v2.6-flash` | MiMo V2.6 Flash | x0.40 |
| `mimo-v2.6-pro` | MiMo V2.6 Pro | x1.00 |

**为什么能确认这两个 id 仍然有效**——用一次对照实验（真实凭证，2026-10-12）：

| 模型 id | 响应 | 含义 |
|---|---|---|
| `mimo-v2.6-flash` | `403 membership_required` | 通过了模型校验，被**会员门禁**拦下 |
| `mimo-v2.6-pro` | `403 membership_required` | 同上 |
| `mimo-v2.5-flash` | `400 chat_model_not_public` | 模型校验这一步就被拒 |
| `mimo-v2.6-ultra` | `400 chat_model_not_public` | 同上 |
| `mimo-v2.6` | `400 chat_model_not_public` | 同上 |
| `gpt-4o` | `400 chat_model_not_public` | 同上 |

关键在**状态码的区别**：形似但不存在的 id 在模型校验阶段就返回 400，而快照里的两个 id 走得更远，直到会员门禁才被 403 拦下。**能走到会员门禁，说明模型名是对的**——403 的原文是「未开通会员或会员已到期，请订阅后使用」，与模型名无关。

倍率是客户端显示的点数消耗系数，仅作展示，不影响请求。

### 推理档位：本账号**无法测得**

模型选择器里**目前不会**出现 Off / Minimal / Low / Medium / High 档位。

这些模型确实会产出思维链（以 `reasoning_content` 返回，在 DSH 中表现为流式的思考过程）。但**网关是否接受推理控制参数，目前仍无定论**：

- 桌面端免费额度时期的结论是**全部无效**（`reasoning_effort` 各档、`thinking.type=disabled`、`enable_thinking:false` 都测不出差别，详见下方旧数据）；
- 2026-10-12 用真实登录凭证复测了全部 6 种变体，**每一个都在生成任何 token 之前就被 `403 membership_required` 拒绝**——本账号没有订阅，所以这次复测**没有产生任何可比数据**。

所以现在不声明 `reasoning` 的理由，是**「还测不出来」**，而不再是**「已测出无效」**。这两句话不一样，之前写混了。

> 这也暴露了探针的一个缺陷并已修复：旧实现会把「只有一个档位留下数字」报告成「所有档位推理长度完全相同 → 参数被忽略」。那是**从零个样本得出的结论**。现在这种情况会单独报为 `insufficient`（测量不足），不再伪装成结论。

**有订阅的账号**运行一次即可定论：

```sh
node tools/probe-gateway.mjs reasoning --confirm
```

它会用同一句提示词、只改推理参数，比较思维链长度，并按**事先写死**的标准判定：至少两档有测量值、各档不全相等、`high/low ≥ 1.5 倍`、关闭档低于基线一半。得到结论后再决定如何声明，而不是先猜。

<details>
<summary>旧数据（桌面端免费额度时期实测，仅存档）</summary>

| 参数 | 推理 token 数 |
|---|---|
| 默认 | 176 / 211 |
| `thinking: { type: 'disabled' }` | 179 |
| `thinking: { enabled: false }` | 237 |
| `reasoning_effort: 'none'` | 181 |
| `reasoning_effort: 'low'` | 205 |
| `enable_thinking: false` | 210 |

当时的结论是"全部无效"。这组数字**不适用于订阅制**，保留仅为说明当初为何不声明档位。
</details>

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

由于网关是否接受推理档位参数尚未用订阅账号核实，目前**没有插件层面的提速手段**。

## 已知限制

- **免费额度已取消，改为订阅制**。桌面端免费额度是插件最初的目标，现已下线。插件本身不提供订阅，能否使用取决于你的账号是否有可用额度。
- **没有订阅时，推理会被明确拒绝**。已用真实账号实测：登录与会话建立正常，但每次推理返回 `403 membership_required`（「未开通会员或会员已到期，请订阅后使用」）。这与插件无关，是账号权限。
- **网关没有模型清单接口（已实测确认）**。`/api/route/models` 等 16 条候选路径在有效凭证下全部 404；插件会照常尝试，但实际总是使用内置快照。快照里的两个模型 id 已通过对照实验**确认仍然有效**（见「模型」一节）。
- **推理档位是否生效仍无法确定**。免费额度时期的结论是「全部无效」；2026-10-12 用真实凭证复测 6 种变体，全部在生成 token 前被 `403` 拒绝，**没有得到任何可比数据**。因此现在不声明档位的理由是「测不出来」，而非「已测出无效」。需要一个有订阅的账号跑探针才能定论。
- **依赖非公开接口**。插件使用客户端自身的端点与凭证，非小米官方开放 API；上游变更后可能需要跟随调整。
- **响应速度受上游影响**。延迟波动较大，插件无法控制。
- **额度显示的字段语义在订阅制下已变**。`/api/user/usage` 仍返回 200，但未订阅账号上 `percent` 为 `0.0`、`resetDate`/`resetAt` 为 `null`，因此重置日不会显示（插件在字段缺失时省略，不会显示假日期）。`percent` 究竟是「剩余」还是「已用」尚未在订阅账号上核实。
- **`login` 必须手动复制 cookie 值**。`passToken` 是 `HttpOnly` 且 passport 拒绝第三方回调，无法做成「点一下自动登录」。这是设计上绕不过去的限制，不是待修的缺陷。
- **凭证有效期**。`passToken` 实测有效期 30 天；过期后需重新登录（客户端或 `login`）。
- **`serviceToken` 需要短期续期**。插件在会话内自动重换，遇到 401 会重试一次。
- **会话被服务端吊销后会自动重建**。passport 用 `passToken=EXPIRED` 吊销会话时，
  插件会在下一轮检查中从已保存的凭证重新播种，不必重启 DSH。若凭证本身已失效
  （例如 `passToken` 过期），则需要重新登录。
- **配额由小米控制**。插件只转发请求，不改变额度、限流或账号权限。

## 开发

```sh
npm run build                 # 生成浏览器半侧 lib/client.js
node tests/run.mjs            # 全部套件
node tests/run.mjs client     # 仅客户端半侧
node tests/run.mjs layout     # 仅排版对照
node tests/run.mjs cookie     # 名称含 cookie 的套件
node tests/run.mjs cli        # 命令行入口
node tests/run.mjs credential # 两条凭证来源
```

两条凭证来源（客户端 cookie 库 / 插件自身 `login`）各有一支端到端套件：

- `tests/credential-paths.mjs` —— 用真实的 `apply()` 与一个**对 passToken 严格**的
  上游替身驱动，覆盖「改完 cookie 库能否真的走完 STS 换取」。宽松的替身会让
  「jar 没播种」这类缺陷照样通过，所以替身会拒绝不带 passToken 的请求。
- `tests/cli.mjs` —— 在**真实子进程**里跑真实 `bin/cli.js`，只把网络换成替身。
  `login` 的交互输入、`logout` 的删除语义、`status` / `doctor` / `verify` 的
  退出码都在这里被钉住。
- `tests/session-recovery.mjs` —— 服务端吊销（`passToken=EXPIRED`）之后必须能
  自愈。这个场景来自真实服务器：逐跳探测时看到 passport 就是这样吊销会话的，
  而磁盘凭证没有变化，因此依赖身份比较的旧逻辑不会重新播种 jar。断言里包含
  「吊销确实发生过」，避免测试因为没触发到那条路径而假装通过。

测试结果分三类报告，互不混淆：

- **通过** —— 套件跑了检查并全部通过；
- **跳过** —— 套件在本机没有可验证的对象（退出码 `SKIP_EXIT_CODE` = 10），
  不计入通过；
- **失败** —— 其它任何非零退出码或被信号终止。

跳过**不会**让运行失败，但也**不算一次通过**：汇总里单独列出跳过的套件名，
避免「本机没东西可验」被误读成「已验证」。`boot-safety`（需要装了本插件的
DSH profile）、`layout-parity`（需要 DSH 安装目录）、`e2e-live`（需要真实
MiMo 凭证）在 CI 上都会走跳过分支——也就是说这三项**没有被 CI 覆盖**。

`boot-safety` 还多一条限制：它要用普通 node 去 `import` 已安装的插件，而 DSH 把
`@deepseek-ai/*` 框架包放在自己的 `app.asar` 归档里，只有 DSH 进程能解析。因此
在一台**真实安装**了插件的机器上，这个 import 会在第一个 peer 依赖上失败并退化为
跳过（退出码 10）。这不是插件缺陷——同类插件 `dsh-workbuddy-connect` 在真实 DSH 里
工作正常，而普通 node 加载它同样失败。该套件改用 `pathToFileURL` 加载并把这种
情况如实报为跳过，而不是记成失败；插件的 `apply()` 行为由 `tests/entry.mjs`
在仓库内完整验证。

> 这里曾经有一个**假通过**：早先 profile 里放的是指向本仓库的 junction，本仓库
> 恰好有 `node_modules/@deepseek-ai/*`，于是普通 node 能解析、套件"通过"了。
> 它验证的是那次巧合，不是插件。换成真实安装后立刻暴露出来，才改成现在这样。

改了客户端代码后务必重建：CI 里有一道闸门要求 `lib/` 与 `src/client.js` 一致，
提交过期产物会直接失败。

本地还有两条与测试并列的检查，CI 上同样是硬闸门：

```sh
npm run format:check   # 格式（Prettier：无分号、单引号、2 空格、100 列）
npm run typecheck      # src/ 与 bin/ 的 JSDoc 类型检查（tsc --checkJs）
```

格式不对时用 `npm run format` 就地修好。`lib/` 已在 `.prettierignore` 中排除，
它由构建生成，不需要（也不应该）手工格式化。类型检查只覆盖 `src/` 与 `bin/`：
`tests/`、`tools/` 里 mock 与动态构造较多，纳入的噪声大于收益。

渲染与排版测试需要几个只服务测试的依赖：

```sh
npm i --no-save js-yaml@^4 react@18.3.1 react-dom@18.3.1 jsdom
```

它们不进发布产物——浏览器半侧在 DSH 页面里只从平台基座取 React。

`tools/` 存放本机部署辅助脚本，不属于发布测试的一部分。目标 profile 依次从 `DSH_PROFILE_DIR`、`DSH_HOME`、`USERPROFILE` 解析，没有写死到某一台机器。`npm run sync` 会先构建再把插件同步到该 profile。

### 浏览器半侧

客户端 bundle 是手写的 `__ModuleLoader__.load(...)` 形式，没有打包器参与：`src/client.js` 就是产物形状，`tools/build-client.mjs` 补一份 source map 后写到 `lib/client.js`。宿主从 `package.json` 的 `dsh.client` 声明发现它，并把 `exports["./client"]` 指向的文件原样提供在 `/plugins` 下。

改完客户端代码必须重启 DSH：bundle 在进程启动时被快照，`patchReload` 不会重新读取它。

### 额度指示为什么能跟上宿主的排版

插件把 pill 注册为 `conversation.composer.dock` 槽位的**普通条目**（`id: "mimo-quota"`，`order: 10`）。宿主自己的 `StatsPills` 也注册在这个槽位（`id: "stats"`，`order: 0`），所以排在它后面的 `order: 10` 正好落在统计 pill 旁边。这个槽位的容器本身就是一行 flex（`justify-content:center; align-items:center; gap:12px; display:flex`），pill 是它的**真正子项**，排版权完全交给宿主自己的规则——没有绝对定位，也没有手算偏移。

插件只声明 pill 自身的几何，逐项对齐宿主统计行的 pill（`border-radius:999px`、`corner-shape:round`、`padding:1px 8px`、`gap:6px`、`font:inherit`、`line-height:inherit`、`font-variant-numeric:tabular-nums`），这样两边在任何字号或缩放下都读作同一行。

样式表由组件自己渲染成一个 `<style>` 元素（带 `data-plugin-css` 归属标记），随组件挂载插入、卸载移除；不写到 `document.head`，因为宿主的 `claimStyles` 会把文档里每个未标记的 `<style>` 归到当时正在物化的插件名下，并在该插件卸载时一并删掉。

`tests/layout-parity.mjs` 从 `dsh-client-ui-chat` 的产物里逐字提取宿主 CSS，把两边的 pill 放进同一容器比对**计算样式**，覆盖字号变化、变量缺失、窄容器与深色主题。找不到 DSH 安装目录时整支跳过（退出码 10，`SKIP_EXIT_CODE`）；用 `DSH_APP_ROOT` 可指定位置。

> 历史说明：0.2.0 及更早版本走的是另一条路——用 `createPortal` 把 pill 送进 `[data-composer-stats]`，再用 `MutationObserver` 盯住宿主替换。0.3.0 起改为上面这种「普通槽位条目」的做法，不再需要 portal 和观察器。

## 免责声明

- 本项目**仅供个人学习和研究使用**，仅驱动使用者自己的 MiMo 账号在本机调用，请勿用于商业用途或超出个人合理使用的场景。
- 使用者需遵守小米的服务条款；因使用本项目产生的任何后果（包括但不限于账号被限制、额度被清空、服务中断），由使用者自行承担。
- 本项目与小米、Xiaomi MiMo、DeepSeek 均无关联，未获其授权或认可；文中出现的名称仅用于描述兼容关系，其商标权利归各自所有。

## 致谢

- [dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)（MIT）—— 插件组织方式、provider 注册与 `PiAiAdapter` 组装的参照。

## 许可证

[MIT](./LICENSE)
