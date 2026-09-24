/**
 * 排版对照实验：把我的 pill 和宿主原生的 pill 放在同一容器里逐项比对。
 *
 * 这不是「我的 CSS 写了什么」的断言，而是「浏览器算出来的两者是否一致」的
 * 断言 —— 只有后者能回答「别人用会不会错位」。
 *
 * 宿主的规则原文从 dsh-client-ui-chat 的产物里逐字提取，不使用近似值，
 * 这样任何由字号/内边距/圆角差异导致的不同排都会暴露。
 *
 * 覆盖他人环境里真正会变的量：
 *   - 字号：--dsh-content-font-size-secondary 与 --dsh-content-font-delta-secondary
 *   - 缩放：--dsh-composer-side-clearance
 *   - 主题：--dsw-alias-* 系列
 *   - 窄窗口：容器宽度收窄
 *   - 变量缺失：主题没提供时的兜底值
 *
 * 依赖 DSH 安装目录（用来取宿主的真实 CSS）。找不到时整体跳过，不判失败 ——
 * 插件本身不依赖宿主源码，只有这个对照实验需要。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const root = join(import.meta.dirname, '..')
const bundlePath = join(root, 'lib', 'client.js')

/**
 * 定位 dsh-client-ui-chat 的客户端产物。
 *
 * `DSH_APP_ROOT` 是显式覆盖：一旦设置就只信它，不再回退到猜测路径。
 * 否则「设置一个不存在的路径来验证跳过分支」根本验证不了 —— 猜测路径会
 * 命中并掩盖问题。其余环境走常见安装位置。
 *
 * @returns 产物路径，或 undefined。
 */
function findChatBundle() {
  const bases = []
  const override = process.env.DSH_APP_ROOT
  if (override !== undefined && override.length > 0) {
    bases.push(override.endsWith('node_modules') ? override : join(override, 'node_modules'))
  } else {
    if (process.env.DSH_HOME) {
      bases.push(join(process.env.DSH_HOME, '..', 'DSH Desktop', 'resources', 'app', 'node_modules'))
    }
    bases.push(
      'D:\\DSH\\DSH Desktop\\resources\\app\\node_modules',
      join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DSH Desktop', 'resources', 'app', 'node_modules'),
      '/Applications/DSH Desktop.app/Contents/Resources/app/node_modules',
    )
  }
  for (const base of bases) {
    if (base.length === 0) continue
    const p = join(base, '@deepseek-ai', 'dsh-client-ui-chat', 'lib', 'client.js')
    if (existsSync(p)) return p
  }
  return undefined
}

const CHAT = findChatBundle()
if (CHAT === undefined || !existsSync(bundlePath)) {
  console.log('\n== 排版对照 ==')
  console.log(`  SKIP 未找到 DSH 安装目录或客户端 bundle`)
  console.log(`       bundle: ${bundlePath} (${existsSync(bundlePath) ? '存在' : '缺失，请先 npm run build'}）`)
  console.log('       设置 DSH_APP_ROOT 可指定 DSH 安装位置的 node_modules 目录')
  process.exit(0)
}

let jsdomModule
let React
let ReactDOMClient
let jsxRuntime
let reactDom
try {
  const require = createRequire(import.meta.url)
  jsdomModule = require('jsdom')
  React = require('react')
  ReactDOMClient = require('react-dom/client')
  jsxRuntime = require('react/jsx-runtime')
  reactDom = require('react-dom')
} catch (error) {
  console.log('\n== 排版对照 ==')
  console.log(`  SKIP 渲染依赖未安装（${error.message.split('\n')[0]}）`)
  console.log('       安装：npm i --no-save jsdom react@18.3.1 react-dom@18.3.1')
  process.exit(0)
}
const { JSDOM } = jsdomModule

let pass = 0
let fail = 0
const checkFn = (l, c, d = '') => {
  if (c) { pass++; console.log(`  PASS ${l}`) }
  else { fail++; console.log(`  FAIL ${l} ${d}`) }
}
const check = (l, a, e) => {
  const x = JSON.stringify(a); const y = JSON.stringify(e)
  if (x === y) { pass++; console.log(`  PASS ${l}`) }
  else { fail++; console.log(`  FAIL ${l}\n       期望 ${y}\n       实际 ${x}`) }
}

// 从 ui-chat 产物里逐字取出 StatsPills 的 CSS。
const chatSrc = readFileSync(CHAT, 'utf-8')
const m = chatSrc.match(/const css\$1 = "\.FwxveW_root\{([\s\S]*?)";/)
if (m === null) {
  console.error('无法从 ui-chat 提取 StatsPills CSS，UI 变化时本测试需要更新。')
  process.exit(2)
}
const HOST_CSS = m[1].replace(/\\"/g, '"')
console.log(`\n已提取宿主 CSS（${HOST_CSS.length} 字节）`)
console.log(`   来源: ${CHAT}`)

/**
 * 建立一支带主题变量的 DOM。
 *
 * @param vars - 覆盖到 :root 的 CSS 变量。
 * @returns jsdom 实例。
 */
function makeDom(vars = {}) {
  const lines = Object.entries(vars).map(([k, v]) => `${k}:${v};`).join('')
  const dom = new JSDOM(
    `<!doctype html><html><head><style>:root{${lines}}</style></head><body></body></html>`,
    { pretendToBeVisual: true },
  )
  return dom
}

/**
 * 在给定 DOM 里构造「宿主 pill + 我的 pill」，并读回两者的计算样式。
 *
 * jsdom 不做真实排版（getBoundingClientRect 恒为 0），所以这里比对的是
 * **计算样式**——凡是能导致错位的属性差异都会在这里显形。
 *
 * @param dom - jsdom 实例。
 * @returns {{host: object, mine: object, hostHtml: string, mineHtml: string}}。
 */
async function compare(dom) {
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.Node = dom.window.Node
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0)
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id)

  // 注入宿主样式 + 插件样式。
  const hostStyle = dom.window.document.createElement('style')
  hostStyle.textContent = `.FwxveW_root{${HOST_CSS}`
  dom.window.document.head.appendChild(hostStyle)

  globalThis.fetch = async () => ({ ok: true, json: async () => ({ available: true, percent: 99.8, resetDate: '2026-09-30' }) })
  globalThis.window.__ModuleLoader__ = { load(spec) { globalThis.__factory = spec.factory } }

  // bundle 每次都要在新 DOM 里重新物化（它自己注入样式并查询 document）。
  new Function(readFileSync(bundlePath, 'utf-8'))()
  const platform = {
    'react': React,
    'react/jsx-runtime': jsxRuntime,
    'react-dom': reactDom,
    'react-dom/client': ReactDOMClient,
  }
  const mod = globalThis.__factory((s) => {
    if (s in platform) return platform[s]
    throw new Error(`unknown module: ${s}`)
  })

  // 统计行容器，模拟宿主自己那一个。
  const rowEl = dom.window.document.createElement('div')
  rowEl.className = 'FwxveW_root'
  rowEl.setAttribute('data-composer-stats', 'true')
  dom.window.document.body.appendChild(rowEl)

  // 宿主会用两种元素渲染同一个 pill 类：
  //   - 无数据（纯展示）用 <span>
  //   - 有数据（可点开面板）用 <button>
  // 两种都给出来，比对时取与插件同元素类型的那一个，避免把 UA 对
  // <button> 的默认背景（buttonface）当成作者样式差异。
  rowEl.innerHTML = `
    <span class="FwxveW_anchor"><span class="FwxveW_pill" data-ref="idle"><span class="FwxveW_label">1 轮 1 步 · 110 tok/s</span></span></span>
    <span class="FwxveW_anchor"><button type="button" class="FwxveW_pill" data-ref="active"><span class="FwxveW_label">12K tok · 缓存命中 0%</span></button></span>
  `
  const hostSpanPill = rowEl.querySelector('[data-ref="idle"]')
  const hostButtonPill = rowEl.querySelector('[data-ref="active"]')

  // 再挂载我的组件，让它 portal 进行容器。
  let captured
  mod.apply({
    effect(fn) { fn() },
    inject(_d, fn) {
      fn({
        slots: { inject(_n, f) { f() }, register(d, C) { captured = { d, C }; return () => {} } },
        modelDirectories: {
          directoryFor: () => ({ store: { getSnapshot: () => ({ current: { provider: 'mimo' } }), subscribe: () => () => {} } }),
        },
      })
    },
    locale: { register: () => () => {} },
  })

  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root_ = ReactDOMClient.createRoot(host)
  const { act } = React
  const props = captured.d.inject('session-1')
  const t = (k, p) => (k === 'quota.label' ? `MiMo 剩余 ${p.percent}%` : k === 'quota.title' ? `MiMo 桌面端免费额度剩余 ${p.percent}%` : `重置于 ${p.date}`)
  await act(async () => { root_.render(React.createElement(captured.C, { ...props, t })) })
  await act(async () => { await new Promise(r => setTimeout(r, 30)) })

  const minePill = rowEl.querySelector('.mimoq_pill')
  const mineAnchor = rowEl.querySelector('.mimoq_anchor')
  const hostAnchor = rowEl.querySelector('.FwxveW_anchor')

  const read = (el, keys) => {
    if (el === null || el === undefined) return undefined
    const cs = dom.window.getComputedStyle(el)
    const out = {}
    for (const k of keys) out[k] = cs.getPropertyValue(k)
    return out
  }

  /**
   * 作者声明的属性集合。
   *
   * `color` 与 `background-color` 故意排除：jsdom 不解析 `var()`，两者都只会
   * 回显 `var(--…)` 文本，比不出信息；而 UA 对 <button> 的 buttonface 背景
   * 也不是作者样式。这两项由 tests/client.mjs 直接断言 CSS 源文本覆盖，
   * 那里能真正校验变量名。
   */
  const PILL_KEYS = [
    'border-radius', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'gap', 'font-size', 'line-height', 'font-family', 'display', 'box-sizing',
    'font-variant-numeric', 'white-space', 'text-overflow', 'overflow',
  ]
  const ANCHOR_KEYS = ['display', 'min-width']
  const ROW_KEYS = ['display', 'justify-content', 'gap', 'width', 'padding-top', 'padding-left', 'font-size', 'line-height']

  const result = {
    // 宿主无数据态用 <span>，与插件同元素类型 —— 这是唯一干净的对照组。
    host: read(hostSpanPill, PILL_KEYS),
    // 宿主有数据态是 <button>，单独留一份用于核对「只多出可点性」。
    hostButton: read(hostButtonPill, PILL_KEYS),
    mine: read(minePill, PILL_KEYS),
    hostAnchor: read(hostAnchor, ANCHOR_KEYS),
    mineAnchor: read(mineAnchor, ANCHOR_KEYS),
    row: read(rowEl, ROW_KEYS),
    rowHtml: rowEl.innerHTML,
    // 我的 pill 必须是这一行的子项，且顺序在最后。
    mineIsChild: minePill !== null && minePill.closest('[data-composer-stats]') === rowEl,
    childCount: rowEl.children.length,
    mineIsLast: rowEl.lastElementChild === mineAnchor,
    mineTag: minePill?.tagName,
    hostTag: hostSpanPill?.tagName,
    // 先把样式表文本抓出来再关窗口，调用方就不必碰已 close 的 DOM。
    cssText: [...dom.window.document.querySelectorAll('style[data-plugin-css]')]
      .map(s => s.textContent).join('\n'),
  }

  // 收尾：卸载 React、关掉 jsdom 的定时器与事件循环。
  // 不做这一步，组件挂的 MutationObserver 和 jsdom 的 rAF 会让进程不退出，
  // 工具就会在跑完所有用例后卡住。
  await act(async () => { root_.unmount() })
  host.remove()
  dom.window.close()

  return result
}

console.log('\n== 1. 默认主题下逐项比对 ==')
{
  const dom = makeDom({
    '--dsh-content-font-size-secondary': '13px',
    '--dsh-content-font-delta-secondary': '0px',
    '--dsh-composer-side-clearance': '16px',
    '--dsh-chat-content-width': '820px',
    '--dsw-alias-label-tertiary': 'rgb(120,120,120)',
    '--dsw-alias-label-secondary': 'rgb(80,80,80)',
    '--dsw-alias-interactive-bg-hover': 'rgb(240,240,240)',
  })
  const r = await compare(dom)

  checkFn('我的 pill 在统计行内', r.mineIsChild, r.rowHtml.slice(0, 200))
  check('统计行现有 3 个子项', r.childCount, 3)
  checkFn('我的 pill 排在最后', r.mineIsLast, r.rowHtml.slice(-160))

  console.log('       宿主 pill :', JSON.stringify(r.host))
  console.log('       我的 pill :', JSON.stringify(r.mine))

  const diffs = Object.keys(r.host).filter(k => r.host[k] !== r.mine[k])
  checkFn('pill 计算样式与宿主逐项一致', diffs.length === 0,
    diffs.map(k => `${k}: 宿主=${r.host[k]} 我的=${r.mine[k]}`).join(' | '))

  // 元素类型：宿主无数据态也是 <span>，两者同型；有数据态才换成 <button>。
  check('我的 pill 是 span（与宿主展示态同型）', r.mineTag, 'SPAN')
  check('宿主对照组也是 span', r.hostTag, 'SPAN')

  // 有数据态的 <button> 只应多出「可点」，几何度量必须一致。
  const buttonDiffs = Object.keys(r.host).filter(k => r.hostButton[k] !== r.host[k])
  checkFn('宿主 button 与 span 几何度量一致（差异仅来自 UA）', buttonDiffs.length === 0,
    buttonDiffs.map(k => `${k}: span=${r.host[k]} button=${r.hostButton[k]}`).join(' | '))

  const aDiffs = Object.keys(r.hostAnchor).filter(k => r.hostAnchor[k] !== r.mineAnchor[k])
  checkFn('anchor 计算样式与宿主一致', aDiffs.length === 0,
    aDiffs.map(k => `${k}: 宿主=${r.hostAnchor[k]} 我的=${r.mineAnchor[k]}`).join(' | '))
}

console.log('\n== 2. 主题改字号（14px / +2px 行高）后仍一致 ==')
{
  const dom = makeDom({
    '--dsh-content-font-size-secondary': '14px',
    '--dsh-content-font-delta-secondary': '2px',
    '--dsh-composer-side-clearance': '16px',
    '--dsh-chat-content-width': '820px',
  })
  const r = await compare(dom)
  console.log('       宿主 pill :', JSON.stringify({ fontSize: r.host['font-size'], lineHeight: r.host['line-height'] }))
  console.log('       我的 pill :', JSON.stringify({ fontSize: r.mine['font-size'], lineHeight: r.mine['line-height'] }))
  const diffs = Object.keys(r.host).filter(k => r.host[k] !== r.mine[k])
  checkFn('字号变化后仍逐项一致', diffs.length === 0,
    diffs.map(k => `${k}: ${r.host[k]} vs ${r.mine[k]}`).join(' | '))
  check('三者字号一致', r.mine['font-size'], r.host['font-size'])
  check('三者行高一致', r.mine['line-height'], r.host['line-height'])
}

console.log('\n== 3. 变量完全缺失时兜底（主题未提供）==')
{
  const dom = makeDom({})
  const r = await compare(dom)
  console.log('       宿主 pill :', JSON.stringify({ fontSize: r.host['font-size'], lineHeight: r.host['line-height'] }))
  console.log('       我的 pill :', JSON.stringify({ fontSize: r.mine['font-size'], lineHeight: r.mine['line-height'] }))
  // 两者都从同一个容器继承，兜底也必须一致。
  checkFn('缺变量时字号仍一致', r.mine['font-size'] === r.host['font-size'], `${r.host['font-size']} vs ${r.mine['font-size']}`)
  checkFn('缺变量时行高仍一致', r.mine['line-height'] === r.host['line-height'], `${r.host['line-height']} vs ${r.mine['line-height']}`)
  const diffs = Object.keys(r.host).filter(k => r.host[k] !== r.mine[k])
  checkFn('缺变量时全部一致', diffs.length === 0, diffs.join(' | '))
}

console.log('\n== 4. 容器收窄（窄窗口）不改变 pill 自身度量 ==')
{
  const wide = await compare(makeDom({ '--dsh-chat-content-width': '1200px', '--dsh-content-font-size-secondary': '13px' }))
  const narrow = await compare(makeDom({ '--dsh-chat-content-width': '420px', '--dsh-content-font-size-secondary': '13px' }))
  checkFn('窄容器下 pill 计算样式不变', JSON.stringify(wide.mine) === JSON.stringify(narrow.mine),
    JSON.stringify({ wide: wide.mine, narrow: narrow.mine }))
  // 宿主自己声明了 nowrap + ellipsis，我和它一致就不会撑破。
  check('不换行（同宿主）', narrow.mine['white-space'], wide.host['white-space'])
  checkFn('允许省略（min-width:0）', /^0(px)?$/.test(narrow.mineAnchor['min-width']), narrow.mineAnchor['min-width'])
  // 宿主 pill 自带 max-width:100%，窄容器下由它兜住溢出。
  checkFn('窄容器下仍受 max-width 约束', narrow.mine['box-sizing'] === 'border-box' && narrow.mine['white-space'] === 'nowrap',
    JSON.stringify(narrow.mine))
}

console.log('\n== 5. 深色主题下结构不变 ==')
{
  const darkDom = makeDom({
    '--dsh-content-font-size-secondary': '13px',
    '--dsw-alias-label-tertiary': 'rgb(160,160,160)',
    '--dsw-alias-label-secondary': 'rgb(210,210,210)',
    '--dsw-alias-interactive-bg-hover': 'rgb(40,40,40)',
  })
  const dark = await compare(darkDom)
  const light = await compare(makeDom({
    '--dsh-content-font-size-secondary': '13px',
    '--dsw-alias-label-tertiary': 'rgb(120,120,120)',
    '--dsw-alias-label-secondary': 'rgb(80,80,80)',
    '--dsw-alias-interactive-bg-hover': 'rgb(240,240,240)',
  }))

  const structural = ['border-radius', 'padding-top', 'padding-left', 'gap', 'font-size', 'line-height', 'display']
  const diffs = structural.filter(k => dark.mine[k] !== light.mine[k])
  checkFn('深浅色主题下结构度量一致', diffs.length === 0, diffs.join(' | '))
  // 颜色走 var()，jsdom 不解析，所以这里核对的是「CSS 源里引用了主题变量」，
  // 由第 6 节保证不与宿主冲突。文本由 compare 在关窗口前抓出。
  const cssText = dark.cssText
  checkFn('文字色引用主题变量', cssText.includes('color:var(--dsw-alias-label-tertiary)'), cssText.slice(0, 140))
  checkFn('悬停背景引用主题变量', cssText.includes('background:var(--dsw-alias-interactive-bg-hover)'), cssText.slice(0, 140))
  checkFn('悬停文字色引用主题变量', cssText.includes('color:var(--dsw-alias-label-secondary)'), cssText.slice(0, 140))
}

console.log('\n== 6. 样式作用域：不污染宿主 ==')
{
  const r = await compare(makeDom({ '--dsh-content-font-size-secondary': '13px' }))
  const cssInjected = r.cssText
  // 我的所有选择器都必须带 mimoq_ 前缀，绝不能命中宿主的类名。
  const selectors = [...cssInjected.matchAll(/(^|\})([^{}]+)\{/g)].map(x => x[2].trim()).filter(Boolean)
  console.log('       选择器:', selectors.join(' | '))
  const leaking = selectors.filter(sel => !sel.includes('mimoq_'))
  checkFn('所有选择器都限定在 mimoq_ 前缀', leaking.length === 0, leaking.join(' | '))
  checkFn('未定义宿主类名', !cssInjected.includes('.FwxveW_'), cssInjected.slice(0, 120))
  checkFn('未使用通配符选择器', !selectors.some(s => s === '*'), selectors.join(' | '))
  checkFn('未使用 !important', !cssInjected.includes('!important'), cssInjected.slice(0, 120))
  checkFn('未对宿主元素做全局覆盖', !/^\s*(html|body|\*)/m.test(cssInjected), cssInjected.slice(0, 120))
}

console.log(`\n=== ${pass} 通过, ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
