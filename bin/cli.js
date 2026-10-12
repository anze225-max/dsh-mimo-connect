#!/usr/bin/env node
/**
 * `dsh-mimo-connect` CLI.
 *
 * Subcommands:
 *
 *   status   — report the resolved credential without touching the network
 *   login    — sign the plugin in without the desktop app
 *   logout   — delete the plugin's own credential
 *   verify   — establish a session and run one real completion
 *   doctor   — local diagnostics
 *
 * On the `login` design: Xiaomi's passport endpoint rejects every callback URL
 * this plugin can offer ("Callback连接不合法"), so a loopback OAuth-style
 * callback is not available to a third-party integration. `passToken` is also
 * `HttpOnly`, so it cannot be read from page JavaScript either. The supported
 * path is therefore an explicit, guided copy from the browser's own cookie
 * view — the user is walked through it step by step.
 *
 * @module dsh-mimo-connect/bin
 */

import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { MiMoCredentialStore, writeOwnCredential, OWN_AUTH_FILENAME } from '../src/credential.js'
import { MiMoSession } from '../src/session.js'
import { FALLBACK_MIMO_MODELS } from '../src/catalog.js'

const ACCOUNT = 'https://account.xiaomi.com'

/** Print the usage banner. */
function usage() {
  console.log(`dsh-mimo-connect — 将 Xiaomi MiMo 接入 DeepSeek Harness

用法:
  dsh-mimo-connect status [--json]   显示登录状态
  dsh-mimo-connect login             不使用桌面端，单独登录插件
  dsh-mimo-connect logout            删除插件自己保存的凭证
  dsh-mimo-connect verify            建立会话并真实调用一次模型
  dsh-mimo-connect doctor            本地诊断

凭证来源优先级:
  1. ${OWN_AUTH_FILENAME}（插件自己的登录）
  2. Xiaomi MiMo 桌面端的 cookie（只读复用）

桌面端已登录时无需任何操作。

注意: \`login\` 需要你**手动复制**三个 cookie 值粘贴进来，无法做成
      点一下自动登录（passToken 是 HttpOnly，且 passport 拒绝第三方回调）。
      运行 \`login\` 时会给出逐步指引。`)
}

/** Serialize a status document for humans. */
function printStatus(status) {
  if (!status.signedIn) {
    console.log('状态: 未登录')
    console.log(`原因: ${status.reason}`)
    return
  }
  const c = status.credential
  console.log('状态: 已登录')
  console.log(`来源: ${c.source === 'plugin' ? '插件自身登录' : 'MiMo 桌面端'}`)
  if (c.userId) console.log(`用户: ${c.userId}`)
  if (c.cookiePath) console.log(`桌面端 cookie: ${c.cookiePath}`)
}

/**
 * Resolve the credential or exit with guidance.
 *
 * @returns the credential.
 */
async function requireCredential() {
  const store = new MiMoCredentialStore()
  const status = await store.status()
  if (!status.signedIn) {
    console.error('错误: 未找到 MiMo 凭证')
    console.error(status.reason)
    process.exit(1)
  }
  return { store, credential: status.credential }
}

/** `status` subcommand. */
async function cmdStatus(argv) {
  const store = new MiMoCredentialStore()
  const status = await store.status()
  const document = {
    signedIn: status.signedIn,
    ...(status.signedIn
      ? {
          account: {
            userId: status.credential.userId,
            cUserId: status.credential.cUserId,
            source: status.credential.source,
            ...(status.credential.cookiePath === undefined
              ? {}
              : { cookiePath: status.credential.cookiePath }),
          },
        }
      : { reason: status.reason }),
    ownCredentialPath: store.ownPath(),
    cookieCandidates: store.cookieCandidates(),
    models: FALLBACK_MIMO_MODELS.map(m => m.id),
  }

  if (argv.includes('--json')) {
    console.log(JSON.stringify(document, null, 2))
  } else {
    printStatus(status)
    console.log(`\n插件凭证: ${store.ownPath()}`)
    console.log('桌面端 cookie 探测路径:')
    for (const p of store.cookieCandidates()) console.log(`  ${p}`)
  }
  process.exitCode = status.signedIn ? 0 : 1
}

/**
 * Prompt for one value, reading from the readline iterator.
 *
 * Writing the prompt and pulling the next line are deliberately kept together:
 * the async iterator must be advanced by the same code that announced the
 * prompt, so a caller cannot accidentally print a prompt it never reads for.
 *
 * @param prompt - text to show before waiting.
 * @param answers - the readline async iterator.
 * @returns the trimmed value, or an empty string at EOF.
 */
async function askFor(prompt, answers) {
  stdout.write(prompt)
  const next = await answers.next()
  if (next.done === true) return ''
  return typeof next.value === 'string' ? next.value.trim() : ''
}

/** `login` subcommand. */
async function cmdLogin() {
  console.log('=== MiMo 插件登录 ===\n')

  // 这一段是**必须**的说明，不是客套话：`passToken` 是 HttpOnly，
  // 页面里的 JavaScript 读不到它；而小米 passport 又拒绝一切第三方回调地址
  // （返回「Callback连接不合法」）。两个限制叠在一起，意味着**没有任何**办法
  // 让插件「点一下就自动登录」——这一步只能由人把值复制过来。
  //
  // 既然绕不过去，就必须把「为什么要手动复制」和「具体复制哪几个值」讲清楚，
  // 否则用户只会看到一个莫名其妙的输入提示。
  console.log('这一步需要你**手动复制**三个值粘贴进来。这是设计上无法避免的，原因：\n')
  console.log('  · passToken 是 HttpOnly，网页里的脚本读不到它；')
  console.log('  · 小米 passport 不接受第三方回调地址（会返回「Callback连接不合法」）。')
  console.log('  两条限制叠加，就没有「点一下就自动登录」的余地。\n')
  console.log('如果本机装了 MiMo 桌面端并已登录，则**不需要**这一步 ——')
  console.log('直接退出本命令，插件会自行只读复用桌面端的登录状态。\n')

  console.log('--- 操作步骤 ---\n')
  console.log('第 1 步：用浏览器打开下面这个地址，并完成登录')
  console.log(`  ${ACCOUNT}/pass/serviceLogin?sid=mimopc\n`)
  console.log('第 2 步：登录成功后，在同一个浏览器里按 F12 打开开发者工具')
  console.log('  → 切到 Application（应用程序）标签')
  console.log('  → 左侧 Storage → Cookies → https://account.xiaomi.com')
  console.log('  → 在列表里找到 passToken / cUserId / userId 这三行\n')
  console.log('第 3 步：把这三行的值依次粘贴到下面。')
  console.log('  · 直接双击 Cookie 的 Value 单元格复制即可；')
  console.log('  · 粘贴成 `passToken=xxxx` 这种整行形式也可以，插件会自动去掉前缀；')
  console.log('  · cUserId 与 userId 可以留空，只有 passToken 是必需的。\n')

  const rl = createInterface({ input: stdin, output: stdout })
  /** @type {string[]} */
  const answers = []
  try {
    // Read answers with the async iterator rather than `rl.question()`.
    //
    // `question()` resolves one line by attaching a one-shot `line` listener.
    // When stdin is not a TTY the whole input is buffered and readline emits
    // every line in the same tick, so all of them arrive before the *second*
    // `question()` has attached its listener: the first is captured, the rest
    // are dropped, and the command hangs forever on an await that can never
    // settle. That made `login` unusable with piped input — and `dsh plugin
    // exec`, the documented way to run it, does not guarantee a TTY.
    //
    // The async iterator instead pulls from the queue readline fills, so it
    // sees every buffered line and still ends cleanly at EOF.
    const iterator = rl[Symbol.asyncIterator]()
    for (const label of ['passToken: ', 'cUserId（可留空）: ', 'userId（可留空）: ']) {
      answers.push(await askFor(label, iterator))
    }
  } finally {
    rl.close()
  }

  const [passTokenRaw = '', cUserIdRaw = '', userIdRaw = ''] = answers
  if (passTokenRaw.length === 0) {
    console.error('\n未输入 passToken，已取消。')
    process.exitCode = 1
    return
  }

  // Strip a pasted "name=value" pair, which is what the devtools row shows.
  const unwrap = (raw, name) => {
    const prefix = `${name}=`
    return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw
  }
  const passToken = unwrap(passTokenRaw, 'passToken')
  const cUserId = unwrap(cUserIdRaw, 'cUserId')
  const userId = unwrap(userIdRaw, 'userId')

  const store = new MiMoCredentialStore()
  const path = store.ownPath()

  console.log('\n正在验证凭证...')
  const session = new MiMoSession({
    jar: MiMoCredentialStore.jarFor({ passToken, cUserId, userId }),
  })

  try {
    await session.ensureSession()
  } catch (error) {
    console.error('\n验证失败：无法用该凭证建立会话。')
    console.error(error instanceof Error ? error.message : String(error))
    console.error('\n请确认：')
    console.error('  - 是从 account.xiaomi.com 域复制的 passToken')
    console.error('  - 复制时没有遗漏字符')
    process.exitCode = 1
    return
  }

  writeOwnCredential(path, { passToken, cUserId, userId })
  console.log('\n✅ 登录成功，凭证已保存')
  console.log(`   ${path}`)
  console.log('\n现在可以在 DSH 的模型选择器中使用 MiMo 模型。')
}

/** `logout` subcommand. */
async function cmdLogout() {
  const store = new MiMoCredentialStore()
  const path = store.ownPath()
  const { existsSync, unlinkSync } = await import('node:fs')
  if (!existsSync(path)) {
    console.log('插件没有保存凭证（桌面端登录态不受影响）。')
    return
  }
  unlinkSync(path)
  console.log(`已删除 ${path}`)
  console.log('注意：这不会退出 MiMo 桌面端。若桌面端仍处于登录状态，插件会继续复用它。')
}

/** `verify` subcommand. */
async function cmdVerify() {
  const { credential } = await requireCredential()
  console.log(`凭证来源: ${credential.source === 'plugin' ? '插件自身登录' : 'MiMo 桌面端'}`)

  const session = new MiMoSession({ jar: MiMoCredentialStore.jarFor(credential) })
  console.log('正在建立会话...')
  try {
    await session.ensureSession()
    console.log('✅ serviceToken 已建立')
  } catch (error) {
    console.error('❌ 会话建立失败:', error instanceof Error ? error.message : String(error))
    process.exitCode = 1
    return
  }

  console.log('正在调用模型...')
  const body = JSON.stringify({
    model: 'mimo-v2.6-flash',
    messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
    stream: false,
  })
  try {
    const response = await session.chatStream(body)
    const text = await response.text()
    if (response.status !== 200) {
      console.error(`❌ HTTP ${response.status}: ${text.slice(0, 200)}`)
      process.exitCode = 1
      return
    }
    const parsed = JSON.parse(text)
    const content = parsed?.choices?.[0]?.message?.content
    console.log(`✅ 模型返回: ${JSON.stringify(content)}`)
    console.log('\n插件工作正常。')
  } catch (error) {
    console.error('❌ 调用失败:', error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

/** `doctor` subcommand. */
async function cmdDoctor() {
  console.log('=== dsh-mimo-connect 诊断 ===\n')
  const store = new MiMoCredentialStore()

  console.log('凭证来源:')
  const own = store.readOwn()
  console.log(`  插件自身登录: ${own === undefined ? '无' : '有'}`)
  console.log(`    路径: ${store.ownPath()}`)
  const desktop = store.readDesktop()
  console.log(`  桌面端 cookie: ${desktop === undefined ? '无' : '有'}`)
  if (desktop !== undefined) console.log(`    路径: ${desktop.cookiePath}`)

  console.log('\n探测过的桌面端路径:')
  for (const p of store.cookieCandidates()) {
    const { existsSync } = await import('node:fs')
    console.log(`  ${existsSync(p) ? '[存在]' : '[无]  '} ${p}`)
  }

  const status = await store.status()
  console.log('\n结论:')
  printStatus(status)

  if (status.signedIn) {
    console.log('\n会话探测:')
    const session = new MiMoSession({ jar: MiMoCredentialStore.jarFor(status.credential) })
    try {
      await session.ensureSession()
      console.log('  ✅ 可以建立会话')
    } catch (error) {
      console.log('  ❌ 会话建立失败:', error instanceof Error ? error.message : String(error))
    }
  }
  process.exitCode = status.signedIn ? 0 : 1
}

const [sub, ...rest] = process.argv.slice(2)
switch (sub) {
  case 'status':
    await cmdStatus(rest)
    break
  case 'login':
    await cmdLogin()
    break
  case 'logout':
    await cmdLogout()
    break
  case 'verify':
    await cmdVerify()
    break
  case 'doctor':
    await cmdDoctor()
    break
  case undefined:
  case '--help':
  case '-h':
    usage()
    break
  default:
    console.error(`未知子命令: ${sub}\n`)
    usage()
    process.exitCode = 1
}
