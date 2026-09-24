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
import { MiMoSession, MIMO_SERVER } from '../src/session.js'
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

桌面端已登录时无需任何操作。`)
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

/** `login` subcommand. */
async function cmdLogin() {
  console.log('=== MiMo 插件登录 ===\n')
  console.log('说明：小米 passport 不接受第三方回调地址，且 passToken 是 HttpOnly，')
  console.log('因此无法做成「点一下自动登录」。请按下面步骤操作一次即可。\n')

  console.log('第 1 步：在浏览器打开下面的地址并完成登录')
  console.log(`  ${ACCOUNT}/pass/serviceLogin?sid=mimopc\n`)
  console.log('第 2 步：登录成功后，按 F12 打开开发者工具')
  console.log('  → Application（应用程序）标签')
  console.log('  → Storage → Cookies → https://account.xiaomi.com')
  console.log('  → 找到 passToken / cUserId / userId 三行\n')
  console.log('第 3 步：把三个值依次粘贴到下面。\n')

  const rl = createInterface({ input: stdin, output: stdout })
  let passToken = ''
  let cUserId = ''
  let userId = ''
  try {
    passToken = (await rl.question('passToken: ')).trim()
    if (passToken.length === 0) {
      console.error('\n未输入 passToken，已取消。')
      process.exitCode = 1
      return
    }
    cUserId = (await rl.question('cUserId（可留空）: ')).trim()
    userId = (await rl.question('userId（可留空）: ')).trim()
  } finally {
    rl.close()
  }

  // Strip a pasted "name=value" pair, which is what the devtools row shows.
  const unwrap = (raw, name) => {
    const prefix = `${name}=`
    return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw
  }
  passToken = unwrap(passToken, 'passToken')
  cUserId = unwrap(cUserId, 'cUserId')
  userId = unwrap(userId, 'userId')

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
  case 'status': await cmdStatus(rest); break
  case 'login': await cmdLogin(); break
  case 'logout': await cmdLogout(); break
  case 'verify': await cmdVerify(); break
  case 'doctor': await cmdDoctor(); break
  case undefined:
  case '--help':
  case '-h':
    usage(); break
  default:
    console.error(`未知子命令: ${sub}\n`)
    usage()
    process.exitCode = 1
}
