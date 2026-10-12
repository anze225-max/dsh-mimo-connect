#!/usr/bin/env node
/**
 * MiMo 网关实测探针。
 *
 * 为什么需要它
 * ------------
 * 这个插件的模型清单与推理等级声明，原本建立在「桌面端免费额度」时期的实测
 * 结论上。那个时期的两条关键结论是：
 *
 *   1. 网关没有模型列表接口（`/api/route/models` 返回 404），所以清单是内置快照；
 *   2. 网关忽略所有推理控制参数，所以**故意不声明** `reasoning`，不显示档位选择器。
 *
 * 改为订阅制之后，这两条都要重新验证。本脚本用真实凭证把「假设」变成
 * 「实测事实」，并且把结论写成 JSON，便于逐条比对与归档。
 *
 * 实测发现（2026-10-12，匿名探测）
 * -------------------------------
 * `/api/route/models` 现在返回 **401**（需要凭证）而不是 404（不存在）。
 * 这说明模型列表接口**已经存在**，第 1 条结论已经过时。有了凭证就能拿到真实清单。
 *
 * 用法
 * ----
 *   node tools/probe-gateway.mjs              # 全部探测
 *   node tools/probe-gateway.mjs models       # 只测模型清单
 *   node tools/probe-gateway.mjs reasoning    # 只测推理等级
 *   node tools/probe-gateway.mjs usage        # 只测额度语义
 *
 * 没有可用凭证时，整个脚本干净跳过（退出码 SKIP_EXIT_CODE），不判失败。
 * 推理探测会**真实消耗额度**，因此默认只输出计划、不发送请求；加 `--confirm`
 * 才真正发送（与参照插件 dsh-workbuddy-connect 的知情同意做法一致）。
 *
 * @module dsh-mimo-connect/tools/probe-gateway
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { MiMoCredentialStore } from '../src/credential.js'
import { MiMoSession, MIMO_SERVER } from '../src/session.js'
import { FALLBACK_MIMO_MODELS } from '../src/catalog.js'
import { SKIP_EXIT_CODE } from '../tests/exit-codes.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** 探测结果输出目录。 */
const OUT_DIR = join(root, 'probe-out')

/**
 * 推理档位候选值。与 DSH 的选择器档位一致，外加两个历史上测过的开关写法。
 *
 * `null` 表示基线（完全不发送推理参数），用于对照其余各项。
 */
const EFFORT_PROBES = [
  { label: 'baseline', body: {} },
  { label: 'effort:none', body: { reasoning_effort: 'none' } },
  { label: 'effort:low', body: { reasoning_effort: 'low' } },
  { label: 'effort:medium', body: { reasoning_effort: 'medium' } },
  { label: 'effort:high', body: { reasoning_effort: 'high' } },
  { label: 'thinking:disabled', body: { thinking: { type: 'disabled' } } },
]

/**
 * 判定「推理等级是否真的生效」。
 *
 * 事先把判定标准写死，是为了避免看到数字后临时找理由自我说服。要求：
 *   - high 档的推理长度显著高于 low 档（至少 1.5 倍）；
 *   - 各档位不全部相等（全部相等即「参数被忽略」）；
 *   - 关闭档（none 或 thinking:disabled）能明显压低推理长度。
 *
 * 三条全中才算生效。这条标准直接决定 `adapter.js` 要不要声明 `reasoning`。
 *
 * @param {Record<string, number>} reasoningTokens - 档位 → 推理 token 数。
 * @returns {{ effective: boolean, reasons: string[] }}
 */
export function judgeReasoningEffectiveness(reasoningTokens) {
  const reasons = []
  const values = Object.entries(reasoningTokens).filter(([, v]) => typeof v === 'number')
  if (values.length === 0) return { effective: false, reasons: ['没有可用的测量值'] }

  const nums = values.map(([, v]) => v)
  const allEqual = nums.every(n => n === nums[0])
  if (allEqual) reasons.push('所有档位的推理长度完全相同 → 参数被忽略')

  const low = reasoningTokens['effort:low']
  const high = reasoningTokens['effort:high']
  if (typeof low === 'number' && typeof high === 'number' && low > 0) {
    if (high / low >= 1.5)
      reasons.push(`high 是 low 的 ${(high / low).toFixed(2)} 倍 → 档位有区分度`)
    else reasons.push(`high/low = ${(high / low).toFixed(2)}，未达到 1.5 倍 → 区分度不足`)
  }

  const baseline = reasoningTokens.baseline
  const off = reasoningTokens['effort:none'] ?? reasoningTokens['thinking:disabled']
  if (typeof baseline === 'number' && typeof off === 'number' && baseline > 0) {
    if (off < baseline * 0.5) reasons.push('关闭档显著低于基线 → 可以关掉思维链')
    else reasons.push(`关闭档 ${off} 与基线 ${baseline} 接近 → 关不掉`)
  }

  const effective = reasons.every(
    r => !r.includes('→') || r.includes('有区分度') || r.includes('可以关掉'),
  )
  return { effective, reasons }
}

/**
 * 从一次流式响应里数出推理 token 的规模。
 *
 * 网关把思维链放在 `reasoning_content`。这里统计其字符长度作为规模代理——
 * 比逐 token 计数稳健（不同分块方式下 token 数会抖动），也足够回答
 * 「档位之间有没有区别」这个问题。
 *
 * @param {string} sseText - 完整 SSE 响应文本。
 * @returns {{ reasoningChars: number, contentChars: number, chunks: number }}
 */
export function measureStream(sseText) {
  let reasoningChars = 0
  let contentChars = 0
  let chunks = 0
  for (const line of String(sseText).split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload.length === 0 || payload === '[DONE]') continue
    let obj
    try {
      obj = JSON.parse(payload)
    } catch {
      continue
    }
    const delta = obj?.choices?.[0]?.delta
    if (delta === null || typeof delta !== 'object') continue
    chunks++
    if (typeof delta.reasoning_content === 'string')
      reasoningChars += delta.reasoning_content.length
    if (typeof delta.content === 'string') contentChars += delta.content.length
  }
  return { reasoningChars, contentChars, chunks }
}

/** 读取凭证；没有则返回 undefined。 */
async function resolveCredential() {
  const store = new MiMoCredentialStore()
  const status = await store.status()
  return status.signedIn ? status.credential : undefined
}

/** 建好带凭证的会话。 */
async function buildSession(credential) {
  const session = new MiMoSession({ jar: MiMoCredentialStore.jarFor(credential) })
  await session.ensureSession()
  return session
}

/**
 * B1：模型清单探测。
 *
 * 目标端点从「404 不存在」变成了「401 需要凭证」，所以这次要真的问一次网关，
 * 看它到底提供哪些模型。这是 C1 改造的唯一依据。
 *
 * @param session - 已建立的会话。
 * @returns 探测结果。
 */
export async function probeModels(session) {
  const out = { endpoint: '/api/route/models', attempts: [] }
  for (const path of ['/api/route/models', '/api/route/model/list', '/api/route/v1/models']) {
    try {
      const res = await session.request(`${MIMO_SERVER}${path}`, {
        headers: { Accept: 'application/json' },
      })
      const text = await res.text()
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = undefined
      }
      out.attempts.push({
        path,
        status: res.status,
        contentType: res.headers.get('content-type') ?? '',
        bodyPreview: text.slice(0, 2000),
        parsed,
      })
    } catch (error) {
      out.attempts.push({ path, error: error instanceof Error ? error.message : String(error) })
    }
  }

  // 与内置快照比对，明确指出差异。
  const builtinIds = FALLBACK_MIMO_MODELS.map(m => m.id)
  const live = out.attempts.find(a => a.status === 200 && a.parsed !== undefined)
  const liveIds = extractModelIds(live?.parsed)
  out.builtin = builtinIds
  out.live = liveIds
  out.diff = {
    onlyInGateway: liveIds.filter(id => !builtinIds.includes(id)),
    onlyInBuiltin: builtinIds.filter(id => !liveIds.includes(id)),
  }
  return out
}

/**
 * 从网关返回里尽力提取模型 ID 列表。
 *
 * 网关的响应形状还未实测确认，所以这里同时接受几种常见布局，避免因为
 * 包了一层而误判成「没有模型」。
 *
 * @param parsed - 已解析的响应体。
 * @returns 模型 ID 列表（可能为空）。
 */
export function extractModelIds(parsed) {
  if (parsed === undefined || parsed === null) return []
  const candidates = []
  const push = arr => {
    if (!Array.isArray(arr)) return
    for (const e of arr) {
      if (typeof e === 'string') candidates.push(e)
      else if (e !== null && typeof e === 'object') {
        const id = e.id ?? e.model ?? e.name ?? e.modelId
        if (typeof id === 'string') candidates.push(id)
      }
    }
  }
  push(parsed)
  push(parsed?.data)
  push(parsed?.data?.models)
  push(parsed?.data?.list)
  push(parsed?.models)
  push(parsed?.list)
  return [...new Set(candidates)]
}

/**
 * B2：推理等级探测。
 *
 * 对同一个模型、同一句提示词，只改推理参数，比较思维链长度。这是判定
 * `adapter.js` 该不该声明 `reasoning: true` 的唯一依据。
 *
 * @param session - 已建立的会话。
 * @param options.model - 要探测的模型 ID。
 * @param options.confirm - 必须为 true 才真正发送（会消耗额度）。
 * @param options.perProbeTimeoutMs - 单次请求超时。
 * @returns 探测结果。
 */
export async function probeReasoning(
  session,
  { model, confirm = false, perProbeTimeoutMs = 120000 } = {},
) {
  const out = { model, confirmed: confirm, probes: {}, reasoningChars: {}, judgement: undefined }

  if (!confirm) {
    out.note = '未发送任何请求。加 --confirm 才会真实调用（会消耗额度）。'
    out.planned = EFFORT_PROBES.map(p => p.label)
    return out
  }

  // 提示词固定，确保唯一变量是推理参数。用一道需要思考才能答的小题，
  // 以便思维链有内容可测。
  const prompt = '一个农夫有 17 只羊，除了 9 只以外都跑了。还剩几只？只回答数字。'

  for (const probe of EFFORT_PROBES) {
    const body = JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
      ...probe.body,
    })
    try {
      const res = await session.chatStream(body, AbortSignal.timeout(perProbeTimeoutMs))
      const text = await res.text()
      const measured = measureStream(text)
      out.probes[probe.label] = { status: res.status, ...measured }
      if (res.status === 200) out.reasoningChars[probe.label] = measured.reasoningChars
      else out.probes[probe.label].bodyPreview = text.slice(0, 300)
    } catch (error) {
      out.probes[probe.label] = { error: error instanceof Error ? error.message : String(error) }
    }
  }

  out.judgement = judgeReasoningEffectiveness(out.reasoningChars)
  return out
}

/**
 * B3：额度/订阅语义探测。
 *
 * 订阅制下 `percent` 是否还是「剩余百分比」需要重新确认，否则额度指示会显示
 * 一个语义已经变了却看不出来的数字。
 *
 * @param session - 已建立的会话。
 * @returns 探测结果。
 */
export async function probeUsage(session) {
  const out = { endpoint: '/api/user/usage' }
  try {
    const res = await session.request(`${MIMO_SERVER}/api/user/usage`, {
      headers: { Accept: 'application/json' },
    })
    const text = await res.text()
    out.status = res.status
    out.bodyPreview = text.slice(0, 2000)
    try {
      out.parsed = JSON.parse(text)
    } catch {
      out.parsed = undefined
    }
    // 明确列出字段，便于人工判断语义是否变化。
    const data = out.parsed?.data ?? out.parsed
    out.fields = data !== null && typeof data === 'object' ? Object.keys(data) : []
  } catch (error) {
    out.error = error instanceof Error ? error.message : String(error)
  }
  return out
}

/** 主流程。 */
async function main() {
  const argv = process.argv.slice(2)
  const what = argv.find(a => !a.startsWith('--')) ?? 'all'
  const confirm = argv.includes('--confirm')

  const credential = await resolveCredential()
  if (credential === undefined) {
    console.log('=== 跳过：本机没有可用的 MiMo 凭证 ===')
    console.log('  探针需要一份真实凭证才能问网关要数据。')
    console.log('  获取方式二选一：')
    console.log('    1. 在装有 MiMo 客户端的机器上登录（插件会自动复用）；')
    console.log('    2. 运行 `dsh-mimo-connect login` 并粘贴凭证。')
    console.log('结论：无可验证的环境，跳过（不是失败）')
    process.exit(SKIP_EXIT_CODE)
  }

  console.log(`=== MiMo 网关实测探针 ===`)
  console.log(`  凭证来源: ${credential.source === 'plugin' ? '插件自身登录' : 'MiMo 客户端'}`)
  console.log(`  探测项  : ${what}${confirm ? '（含真实请求）' : ''}\n`)

  const session = await buildSession(credential)
  const report = { probedAt: new Date().toISOString(), credentialSource: credential.source }

  if (what === 'all' || what === 'models') {
    console.log('--- B1 模型清单 ---')
    report.models = await probeModels(session)
    for (const a of report.models.attempts) {
      console.log(`  ${a.path} -> ${a.status ?? a.error}`)
    }
    console.log(`  内置快照: ${report.models.builtin.join(', ')}`)
    console.log(`  网关实测: ${report.models.live.join(', ') || '(未取到)'}`)
  }

  if (what === 'all' || what === 'reasoning') {
    console.log('\n--- B2 推理等级 ---')
    const model = report.models?.live?.[0] ?? FALLBACK_MIMO_MODELS[0].id
    report.reasoning = await probeReasoning(session, { model, confirm })
    if (!confirm) {
      console.log(`  计划探测: ${report.reasoning.planned.join(', ')}`)
      console.log('  （加 --confirm 才会真实发送，会消耗额度）')
    } else {
      for (const [k, v] of Object.entries(report.reasoning.probes)) {
        console.log(
          `  ${k.padEnd(18)} reasoning=${v.reasoningChars ?? '?'} chunks=${v.chunks ?? '?'} status=${v.status ?? v.error}`,
        )
      }
      console.log(
        `  判定: ${report.reasoning.judgement.effective ? '推理等级生效' : '推理等级无效'}`,
      )
      for (const r of report.reasoning.judgement.reasons) console.log(`    - ${r}`)
    }
  }

  if (what === 'all' || what === 'usage') {
    console.log('\n--- B3 额度语义 ---')
    report.usage = await probeUsage(session)
    console.log(`  /api/user/usage -> ${report.usage.status ?? report.usage.error}`)
    console.log(`  字段: ${(report.usage.fields ?? []).join(', ') || '(无)'}`)
  }

  mkdirSync(OUT_DIR, { recursive: true })
  const outPath = join(OUT_DIR, `probe-${what}-${Date.now()}.json`)
  writeFileSync(outPath, JSON.stringify(report, null, 2))
  console.log(`\n报告已写入: ${outPath}`)
}

// 仅在直接执行时跑主流程，被 import 时不跑（便于测试纯函数）。
//
// 用 `pathToFileURL` 比较而不是手工拼 `file:///` 字符串：后者在 Windows 盘符
// 与非 ASCII 路径下会拼错，导致主流程被静默跳过（脚本什么都不做还返回 0）。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
