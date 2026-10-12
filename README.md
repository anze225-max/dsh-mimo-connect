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
> 另外，订阅制下网关的行为可能已经变化，而**本仓库的部分结论来自免费额度时期、尚未用订阅账号重新核实**——具体是哪些见「模型」与「已知限制」两节。核实用的探针已经随仓库提供。

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

小米 passport **不接受第三方回调地址**（返回「Callback连接不合法」），且 `passToken` 是 `HttpOnly`，浏览器 JS 读不到。因此无法做成「点一下自动登录」。

`login` 会给出逐步指引：打开登录页 → 从开发者工具的 Application → Cookies 里复制三个值粘贴回来。插件会立即验证凭证可用后才保存。

**如果你已经装了 MiMo 客户端，就不需要 `login`** —— 直接复用即可。

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
→ {"code":0,"data":{"percent":99.8,"resetDate":"2026-09-30","resetAt":1790782334}}
```

`percent` 是**剩余**百分比。读取是只读的，不消耗任何额度；结果缓存 60 秒，读失败退避 15 秒，任何失败路径都只是「不显示」，不会影响推理。

实现上，node 半侧注册一条 `/api/mimo.quota` 路由（与其它 `/api` 路由共用同一道浏览器会话校验），浏览器半侧通过 `conversation.composer.dock` 插槽挂载一个组件读取它。宿主没有浏览器连接时（例如 CLI）该路由不注册，provider 照常工作。

## 配置

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `cookieDb` | 空 | 显式指定客户端 cookie 库路径 |
| `pollSeconds` | `30` | 重新检查凭证的间隔（秒）；`0` 关闭轮询 |

环境变量 `MIMO_COOKIE_DB` 可覆盖 cookie 库位置。

## 模型

插件**优先向网关询问模型清单**，拿不到时才退回内置快照：

| 顺序 | 来源 | 说明 |
|---|---|---|
| 1 | `GET /api/route/models` | 有凭证时向网关索取，清单以网关为准 |
| 2 | 内置快照 | 网关不可达或无权访问时使用，`status` 里会标注为未核实 |

> **这条是最近改的。** 之前（桌面端免费额度时期）实测该接口返回 **404**，即"不存在"，所以清单只能是内置快照。2026-10-12 复测发现它返回 **401**——401 表示"未认证"，404 才表示"没有这个路由"。接口已经存在，因此清单改为运行时获取，不再写死。
>
> 这样改的好处是：上游新增、改名或下线模型时，插件无需改代码就会跟随；而网络或权限出问题时，快照仍能保证插件可注册、可用，并在 `status` 中如实说明当前用的是未核实的清单。

内置快照（仅作降级用）取自客户端 `model-catalog.json` 的 TEXT 条目：

| ID | 显示名 | 倍率 |
|---|---|---|
| `mimo-v2.6-flash` | MiMo V2.6 Flash | x0.40 |
| `mimo-v2.6-pro` | MiMo V2.6 Pro | x1.00 |

倍率是客户端显示的点数消耗系数，仅作展示，不影响请求。网关清单里若带倍率则优先采用网关的。

### 推理档位：待实测，暂不声明

模型选择器里**目前不会**出现 Off / Minimal / Low / Medium / High 档位。

这些模型确实会产出思维链（以 `reasoning_content` 返回，在 DSH 中表现为流式的思考过程）。**但网关是否接受推理控制参数，目前是未决问题**：

- 在桌面端免费额度时期，实测结论是**全部无效**——`reasoning_effort` 各档与 `thinking.type=disabled` 都测不出差别（详见下方旧数据）；
- 免费额度取消、改为订阅制之后，网关行为可能已经改变，**但这一点尚未用真实订阅账号验证过**。

因此插件**故意不声明** `reasoning`：写一个猜错的档位声明，会重现"调了没反应的选择器"，比不显示更糟。

**订阅后想启用正确的档位**，运行一次实测探针即可：

```sh
node tools/probe-gateway.mjs reasoning --confirm
```

它会用同一句提示词、只改推理参数，比较思维链长度，并按下述**事先写死**的标准判定是否生效：`high/low ≥ 1.5 倍`、各档不全相等、关闭档低于基线一半——三条全中才算"推理等级生效"。得到结论后再决定如何声明，而不是先猜。

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

由于网关是否接受推理档位参数尚未用订阅账号核实，目前**没有插件层面的提速手段**。

## 已知限制

- **免费额度已取消，改为订阅制**。桌面端免费额度是插件最初的目标，现已下线。插件本身不提供订阅，能否使用取决于你的账号是否有可用额度。
- **模型清单未经订阅账号核实**。清单改为向网关索取，但"网关在订阅制下究竟返回哪些模型"这一条尚未用真实订阅凭证实测过（见「模型」一节）。
- **推理档位是否生效未决**。旧结论（全部无效）来自免费额度时期，订阅制下可能已变，需用 `tools/probe-gateway.mjs` 实测后才能确定。
- **依赖非公开接口**。插件使用客户端自身的端点与凭证，非小米官方开放 API；上游变更后可能需要跟随调整。
- **响应速度受上游影响**。延迟波动较大，插件无法控制。
- **额度显示依赖同一套非公开接口**。`/api/user/usage` 变更或下线时，额度指示会静默消失，不影响模型调用；订阅制下该接口返回的 `percent` 语义是否仍是"剩余百分比"也尚未核实。
- **凭证有效期**。`passToken` 实测有效期 30 天；过期后需重新登录（客户端或 `login`）。
- **`serviceToken` 需要短期续期**。插件在会话内自动重换，遇到 401 会重试一次。
- **配额由小米控制**。插件只转发请求，不改变额度、限流或账号权限。

## 开发

```sh
npm run build                 # 生成浏览器半侧 lib/client.js
node tests/run.mjs            # 全部套件
node tests/run.mjs client     # 仅客户端半侧
node tests/run.mjs layout     # 仅排版对照
node tests/run.mjs cookie     # 名称含 cookie 的套件
```

测试结果分三类报告，互不混淆：

- **通过** —— 套件跑了检查并全部通过；
- **跳过** —— 套件在本机没有可验证的对象（退出码 `SKIP_EXIT_CODE` = 10），
  不计入通过；
- **失败** —— 其它任何非零退出码或被信号终止。

跳过**不会**让运行失败，但也**不算一次通过**：汇总里单独列出跳过的套件名，
避免「本机没东西可验」被误读成「已验证」。`boot-safety`（需要装了本插件的
DSH profile）、`layout-parity`（需要 DSH 安装目录）、`e2e-live`（需要真实
MiMo 凭证）在 CI 上都会走跳过分支——也就是说这三项**没有被 CI 覆盖**。

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
