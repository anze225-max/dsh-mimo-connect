/**
 * 探针纯函数的单元测试。
 *
 * 这些函数是「模型清单与推理等级正确性」的判定核心，所以它们本身必须是对的：
 * 一个判反了的 `judgeReasoningEffectiveness` 会让整个 C2 分支走错方向。
 *
 * 本套件不需要凭证、不发网络请求。
 */
import {
  judgeReasoningEffectiveness,
  measureStream,
  extractModelIds,
} from '../tools/probe-gateway.mjs'

let pass = 0
let fail = 0
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    pass++
    console.log(`  PASS ${label}`)
  } else {
    fail++
    console.log(`  FAIL ${label}\n       期望 ${e}\n       实际 ${a}`)
  }
}
const checkFn = (label, cond, detail = '') => {
  if (cond) {
    pass++
    console.log(`  PASS ${label}`)
  } else {
    fail++
    console.log(`  FAIL ${label} ${detail}`)
  }
}

console.log('\n== measureStream：从 SSE 里量出思维链规模 ==')
{
  const sse = [
    'data: {"choices":[{"delta":{"reasoning_content":"abc"}}]}',
    '',
    'data: {"choices":[{"delta":{"reasoning_content":"de"}}]}',
    '',
    'data: {"choices":[{"delta":{"content":"hi"}}]}',
    '',
    'data: [DONE]',
    '',
  ].join('\n')
  const m = measureStream(sse)
  check('推理字符数累加', m.reasoningChars, 5)
  check('正文不混入推理', m.contentChars, 2)
  check('分块计数', m.chunks, 3)
}

console.log('\n== measureStream：异常输入不抛错 ==')
{
  check('空串', measureStream(''), { reasoningChars: 0, contentChars: 0, chunks: 0 })
  check('坏 JSON 被跳过', measureStream('data: {not json}\n').chunks, 0)
  checkFn(
    '非字符串输入不抛错',
    (() => {
      try {
        measureStream(null)
        return true
      } catch {
        return false
      }
    })(),
  )
  check(
    '无 reasoning_content 字段',
    measureStream('data: {"choices":[{"delta":{}}]}\n').reasoningChars,
    0,
  )
}

console.log('\n== judgeReasoningEffectiveness：判定推理等级是否生效 ==')
{
  // 全部相等 = 参数被忽略（免费额度时期的实测结论）
  const ignored = judgeReasoningEffectiveness({
    baseline: 200,
    'effort:none': 200,
    'effort:low': 200,
    'effort:high': 200,
  })
  check('全相等 → 判定无效', ignored.effective, false)
  checkFn(
    '并指出「参数被忽略」',
    ignored.reasons.some(r => r.includes('忽略')),
    JSON.stringify(ignored.reasons),
  )

  // 有区分度 + 能关掉 = 生效（订阅制下如果成立，就要走 C2-a）
  const works = judgeReasoningEffectiveness({
    baseline: 200,
    'effort:none': 5,
    'effort:low': 100,
    'effort:high': 400,
  })
  check('有区分且可关 → 判定生效', works.effective, true)

  // 有轻微差异但区分度不足 = 仍然不该展示选择器
  const weak = judgeReasoningEffectiveness({
    baseline: 200,
    'effort:none': 190,
    'effort:low': 200,
    'effort:high': 220,
  })
  check('区分度不足 → 判定无效', weak.effective, false)

  // 边界：空输入
  check('空对象 → 判定无效', judgeReasoningEffectiveness({}).effective, false)
}

console.log('\n== extractModelIds：兼容多种响应布局 ==')
{
  check('裸字符串数组', extractModelIds(['a', 'b']), ['a', 'b'])
  check('裸对象数组取 id', extractModelIds([{ id: 'm1' }, { id: 'm2' }]), ['m1', 'm2'])
  check('data.models 嵌套', extractModelIds({ data: { models: [{ id: 'x' }] } }), ['x'])
  check('data.list 嵌套', extractModelIds({ data: { list: [{ id: 'y' }] } }), ['y'])
  check('models 顶层', extractModelIds({ models: [{ id: 'z' }] }), ['z'])
  check('model 字段别名', extractModelIds([{ model: 'alias' }]), ['alias'])
  check('modelId 字段别名', extractModelIds([{ modelId: 'mid' }]), ['mid'])
  check('去重', extractModelIds([{ id: 'dup' }, { id: 'dup' }]), ['dup'])
  check('空/异常输入不抛错', extractModelIds(undefined), [])
  check('非数组字段被忽略', extractModelIds({ data: 'string' }), [])
}

console.log(`\n=== ${pass} 通过, ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
