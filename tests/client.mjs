/**
 * 客户端半侧接线测试。
 *
 * 覆盖两件容易悄悄坏掉的事：
 *   1. `dsh.client` 声明与 bundle 的形状符合宿主的硬性要求（platform 必须是
 *      web、exports["./client"] 必须存在、require 的模块必须能由平台基座解析）；
 *   2. 额度 pill 只在会话路由到 MiMo 时出现。
 *
 * 第 2 点用 jsdom + react-dom/client 真实挂载，effect 真跑、请求真发，
 * 断言读的是渲染出来的 DOM —— 这是这条需求唯一可信的证据。
 *
 * 这些依赖（react / react-dom / jsdom）只服务本测试，不进发布产物。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

let pass = 0
let fail = 0
const check = (l, a, e) => {
  const x = JSON.stringify(a); const y = JSON.stringify(e)
  if (x === y) { pass++; console.log(`  PASS ${l}`) }
  else { fail++; console.log(`  FAIL ${l}\n       期望 ${y}\n       实际 ${x}`) }
}
const checkFn = (l, c, d = '') => {
  if (c) { pass++; console.log(`  PASS ${l}`) }
  else { fail++; console.log(`  FAIL ${l} ${d}`) }
}

const root = join(import.meta.dirname, '..')
const APP = 'D:\\DSH\\DSH Desktop\\resources\\app\\node_modules'

console.log('\n== package.json 的 dsh.client 声明 ==')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'))
const decl = pkg.dsh?.client
check('platform', decl?.platform, 'web')
checkFn('inject 是字符串数组', Array.isArray(decl?.inject) && decl.inject.every(s => typeof s === 'string'))
checkFn('未声明 immediately', decl?.immediately === undefined)

const clientExport = pkg.exports?.['./client']
const rel = typeof clientExport === 'string' ? clientExport : clientExport?.default
checkFn('exports["./client"] 可解析', typeof rel === 'string', JSON.stringify(clientExport))
checkFn('bundle 存在', existsSync(join(root, rel)), join(root, rel ?? ''))

console.log('\n== inject 的包必须在 web-app 里加载 ==')
const webAppPath = join(APP, '@deepseek-ai/dsh-web-app/package.json')
if (existsSync(webAppPath)) {
  const webApp = JSON.parse(readFileSync(webAppPath, 'utf-8'))
  const available = new Set([...Object.keys(webApp.dependencies ?? {}), ...Object.keys(webApp.peerDependencies ?? {})])
  for (const dep of decl?.inject ?? []) checkFn(`${dep} 在 dsh-web-app 依赖中`, available.has(dep))
} else {
  console.log('  SKIP 未找到 dsh-web-app（非 DSH 环境）')
}

console.log('\n== bundle 只需平台基座 ==')
const bundlePath = join(root, rel)
if (existsSync(bundlePath)) {
  const bundle = readFileSync(bundlePath, 'utf-8')
  checkFn('使用 __ModuleLoader__.load', bundle.includes('__ModuleLoader__.load'))
  const required = [...new Set([...bundle.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map(m => m[1]))]
  const SEED = new Set(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'])
  const externals = new Set(decl?.external ?? [])
  console.log(`       require: ${required.join(', ') || '(无)'}`)
  for (const spec of required) {
    checkFn(`${spec} 可由基座解析`, SEED.has(spec) || externals.has(spec), '需加入 dsh.client.external')
  }
  checkFn('注册到 composer.dock', bundle.includes('conversation.composer.dock'))
  checkFn('用 modelDirectories 判定 provider', bundle.includes('modelDirectories'))
  checkFn('使用与 node 半侧一致的路径', bundle.includes('/api/mimo.quota'))
}

console.log('\n== node 半侧注册同一路径 ==')
const indexSrc = readFileSync(join(root, 'src', 'index.js'), 'utf-8')
checkFn('含 /api/mimo.quota', indexSrc.includes("'/api/mimo.quota'"))
checkFn('仅 GET', /methods:\s*\['GET'\]/.test(indexSrc))

console.log('\n== 真实渲染：只在选中 MiMo 时显示 ==')
{
  const require = createRequire(import.meta.url)
  let React, ReactDOMClient, JSDOM
  try {
    React = require('react')
    ReactDOMClient = require('react-dom/client')
    JSDOM = require('jsdom').JSDOM
  } catch (error) {
    console.log(`  SKIP 渲染依赖未安装（${error.message.split('\n')[0]}）`)
    console.log(`       安装：npm i --no-save react@18.3.1 react-dom@18.3.1 jsdom`)
    JSDOM = undefined
  }

  if (JSDOM !== undefined && existsSync(bundlePath)) {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { pretendToBeVisual: true })
    globalThis.window = dom.window
    globalThis.document = dom.window.document
    globalThis.HTMLElement = dom.window.HTMLElement
    globalThis.Node = dom.window.Node
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    // 组件轮询统计行是否挂载，需要 rAF；jsdom 的 window 有，挂到全局。
    globalThis.requestAnimationFrame = dom.window.requestAnimationFrame?.bind(dom.window)
      ?? ((cb) => setTimeout(() => cb(Date.now()), 0))
    globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame?.bind(dom.window)
      ?? ((id) => clearTimeout(id))
    // 浏览器里 MutationObserver 是全局，jsdom 只在 window 上；两者都覆盖。
    globalThis.MutationObserver = dom.window.MutationObserver

    let fetchCalls = 0
    let payload = { available: true, percent: 99.8, resetDate: '2026-09-30' }
    globalThis.fetch = async () => {
      fetchCalls++
      return { ok: true, json: async () => payload }
    }

    globalThis.window.__ModuleLoader__ = { load(spec) { globalThis.__factory = spec.factory } }
    // 平台基座表的精确副本（见 dsh-web-frontend 的 seed 表）。
    const platform = {
      'react': React,
      'react/jsx-runtime': require('react/jsx-runtime'),
      'react-dom': require('react-dom'),
      'react-dom/client': ReactDOMClient,
    }
    new Function(readFileSync(bundlePath, 'utf-8'))()
    const mod = globalThis.__factory((s) => {
      if (s in platform) return platform[s]
      throw new Error(`unknown module: ${s}`)
    })

    /** 取回 slot 注册的声明与组件。 */
    function registerWith(provider) {
      const captured = {}
      mod.apply({
        effect(fn) { fn() },
        inject(_deps, fn) {
          fn({
            slots: {
              inject(_n, fn2) { fn2() },
              register(d, C) { captured.decl = d; captured.Component = C; return () => {} },
            },
            modelDirectories: {
              directoryFor: () => ({
                store: {
                  getSnapshot: () => ({ current: { provider } }),
                  subscribe: () => () => {},
                },
              }),
            },
          })
        },
        locale: { register: () => () => {} },
      })
      return captured
    }

    const t = (key, params) => {
      if (key === 'quota.label') return `MiMo 剩余 ${params.percent}%`
      if (key === 'quota.title') return `MiMo 桌面端免费额度剩余 ${params.percent}%`
      if (key === 'quota.reset') return `重置于 ${params.date}`
      return key
    }

    /**
     * 真实挂载并读回 DOM。
     *
     * 组件是 `conversation.composer.dock` 槽位的普通条目，直接渲染到自己的
     * 容器里（不再 portal 进宿主的统计行），所以这里读宿主容器的 innerHTML
     * 就等于读组件自己的输出。样式也由组件渲染成 `<style>` 元素。
     *
     * @param provider - 当前会话路由到的 provider。
     * @returns 组件渲染出的 HTML。
     */
    async function mount(provider) {
      const { decl: d, Component } = registerWith(provider)
      const props = d.inject('session-1')

      const host = document.createElement('div')
      document.body.appendChild(host)
      const r = ReactDOMClient.createRoot(host)
      const { act } = React
      await act(async () => { r.render(React.createElement(Component, { ...props, t })) })
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
      const html = host.innerHTML
      await act(async () => { r.unmount() })
      host.remove()
      return html
    }

    // 样式由组件渲染：必须在挂载期间读，卸载后 <style> 会随组件一起移除。
    let cssText = ''
    {
      const { decl: d0, Component: C0 } = registerWith('mimo')
      const p0 = d0.inject('session-1')
      const host0 = document.createElement('div')
      document.body.appendChild(host0)
      const root0 = ReactDOMClient.createRoot(host0)
      const { act } = React
      await act(async () => { root0.render(React.createElement(C0, { ...p0, t })) })
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
      const injected = host0.querySelector('style[data-plugin-css]')
      checkFn('注入了样式', injected !== null)
      checkFn('样式归属本插件', (injected?.dataset.pluginCss ?? '').startsWith('dsh-mimo-connect/'))
      cssText = injected?.textContent ?? ''
      await act(async () => { root0.unmount() })
      host0.remove()
    }

    for (const provider of ['deepseek', 'anthropic', undefined]) {
      const html = await mount(provider)
      checkFn(`provider=${String(provider)} 不渲染`, html === '', html.slice(0, 100))
    }

    fetchCalls = 0
    await mount('deepseek')
    check('未选中 MiMo 时不请求额度', fetchCalls, 0)

    fetchCalls = 0
    const html = await mount('mimo')
    checkFn('选中 MiMo 渲染出内容', html.length > 0)
    checkFn('带 data-mimo-quota 标记', html.includes('data-mimo-quota'))
    checkFn('显示剩余百分比（保留一位小数）', html.includes('99.8'), html.slice(0, 160))
    checkFn('title 含重置日', html.includes('2026-09-30'))
    checkFn('发起了额度请求', fetchCalls >= 1)

    payload = { available: false }
    checkFn('上游不可用时静默不渲染', (await mount('mimo')) === '')

    payload = { available: true, percent: 3.2, resetDate: '2026-09-30' }
    checkFn('低于 5% 用告警色', (await mount('mimo')).includes('mimoq_dotLow'))

    payload = { available: true, percent: 15, resetDate: '2026-09-30' }
    checkFn('5-20% 用次级提示色', (await mount('mimo')).includes('mimoq_dotWarn'))

    payload = { available: true, percent: 42, resetDate: '2026-09-30' }
    checkFn('整数不留 .0', (await mount('mimo')).includes('42%'))

    console.log('\n== 排版交给宿主的 dock 行（不手算偏移）==')
    {
      const pill = cssText.match(/\.mimoq_pill\{([^}]*)\}/)?.[1] ?? ''

      // 位置由宿主的 dock 行 flex 规则决定，插件只声明 pill 自身几何。
      checkFn('不再自己造行容器', !cssText.includes('.mimoq_root'), cssText.slice(0, 120))
      checkFn('不再用绝对定位', !cssText.includes('position:absolute'), cssText.slice(0, 120))
      checkFn('不再手算行高偏移', !/top:\s*-?\d+px/.test(cssText), cssText.slice(0, 120))
      checkFn('不再用负 margin', !cssText.includes('margin:-'), cssText.slice(0, 120))
      checkFn('anchor 用 inline-flex', cssText.includes('.mimoq_anchor{min-width:0;display:inline-flex}'), cssText.slice(0, 120))

      // pill 几何逐项对齐宿主统计行的 pill（0.2.0-rc.2 起为全圆角 + corner-shape）。
      checkFn('pill 全圆角 999px', pill.includes('border-radius:999px'), pill)
      checkFn('pill 声明 corner-shape', pill.includes('corner-shape:round'), pill)
      checkFn('pill 内边距 1px 8px', pill.includes('padding:1px 8px'), pill)
      checkFn('pill 间距 6px', pill.includes('gap:6px'), pill)
      checkFn('pill 继承字体', pill.includes('font:inherit'), pill)
      checkFn('pill 行高继承', pill.includes('line-height:inherit'), pill)
      checkFn('数字等宽对齐', pill.includes('font-variant-numeric:tabular-nums'), pill)

      // 悬停高亮：与宿主统计行 pill 同一组变量。
      const hover = cssText.match(/\.mimoq_pill:hover\{([^}]*)\}/)?.[1] ?? ''
      checkFn('悬停背景同统计行', hover.includes('background:var(--dsw-alias-interactive-bg-hover)'), hover)
      checkFn('悬停文字色同统计行', hover.includes('color:var(--dsw-alias-label-secondary)'), hover)
    }

    console.log('\n== 作为 dock 槽位的普通条目渲染 ==')
    {
      const { decl, Component } = registerWith('mimo')
      const props = decl.inject('session-1')

      const host = document.createElement('div')
      document.body.appendChild(host)
      const root = ReactDOMClient.createRoot(host)
      const { act } = React
      await act(async () => { root.render(React.createElement(Component, { ...props, t })) })

      checkFn('pill 渲染在自己的容器里', host.querySelector('[data-mimo-quota]') !== null, host.innerHTML.slice(0, 160))
      checkFn('pill 的父节点就是组件容器', host.querySelector('[data-mimo-quota]')?.parentElement === host)
      checkFn('pill 自身带 anchor 类', host.querySelector('.mimoq_anchor') !== null)
      // 样式随组件渲染，而不是塞进 document.head。
      checkFn('样式由组件渲染', host.querySelector('style[data-plugin-css]') !== null, host.innerHTML.slice(0, 120))

      await act(async () => { root.unmount() })
      checkFn('卸载后 pill 被移除', host.querySelector('[data-mimo-quota]') === null)
      checkFn('卸载后样式也被移除', host.querySelector('style[data-plugin-css]') === null)

      host.remove()
    }

    console.log('\n== 非 MiMo 用户：零干扰 ==')
    {
      const { decl, Component } = registerWith('deepseek')
      const props = decl.inject('session-1')
      const { act } = React

      const host = document.createElement('div')
      document.body.appendChild(host)
      const root = ReactDOMClient.createRoot(host)

      let mutations = 0
      const watcher = new MutationObserver(() => { mutations++ })
      watcher.observe(document.body, { childList: true, subtree: true })

      fetchCalls = 0
      await act(async () => { root.render(React.createElement(Component, { ...props, t })) })
      await act(async () => { await new Promise(r => setTimeout(r, 100)) })

      check('非 MiMo 不请求额度接口', fetchCalls, 0)
      checkFn('非 MiMo 不产生 DOM', host.innerHTML === '', host.innerHTML.slice(0, 100))
      // 不应有轮询在跑：没有 rAF 排程，也没有 MutationObserver 看守。
      checkFn('非 MiMo 不启动轮询（无持续 DOM 变更）', mutations === 0, String(mutations))

      watcher.disconnect()
      await act(async () => { root.unmount() })
      host.remove()

      // 切到 MiMo 再切回来：应干净地出现又消失。
      let provider = 'deepseek'
      const listeners = new Set()
      let cap
      mod.apply({
        effect(fn) { fn() },
        inject(_x, fn) {
          fn({
            slots: { inject(_n, f) { f() }, register(dd, CC) { cap = { d: dd, C: CC }; return () => {} } },
            modelDirectories: {
              directoryFor: () => ({
                store: {
                  getSnapshot: () => ({ current: { provider } }),
                  subscribe: (fn2) => { listeners.add(fn2); return () => listeners.delete(fn2) },
                },
              }),
            },
          })
        },
        locale: { register: () => () => {} },
      })

      const h2 = document.createElement('div')
      document.body.appendChild(h2)
      const r2 = ReactDOMClient.createRoot(h2)
      const props2 = cap.d.inject('session-1')
      await act(async () => { r2.render(React.createElement(cap.C, { ...props2, t })) })
      await act(async () => { await new Promise(r => setTimeout(r, 40)) })
      checkFn('deepseek 时无内容', h2.querySelector('[data-mimo-quota]') === null, h2.innerHTML.slice(0, 100))

      provider = 'mimo'
      await act(async () => { for (const fn of listeners) fn() })
      await act(async () => { await new Promise(r => setTimeout(r, 60)) })
      checkFn('切到 MiMo 后出现', h2.querySelector('[data-mimo-quota]') !== null, h2.innerHTML.slice(0, 100))

      provider = 'deepseek'
      await act(async () => { for (const fn of listeners) fn() })
      await act(async () => { await new Promise(r => setTimeout(r, 60)) })
      checkFn('切回 deepseek 后消失', h2.querySelector('[data-mimo-quota]') === null, h2.innerHTML.slice(0, 100))

      await act(async () => { r2.unmount() })
      h2.remove()
    }

    console.log('\n== 独立性：不依赖宿主统计行 ==')
    {
      // 旧实现要等宿主的 [data-composer-stats] 出现才渲染，空会话时 pill 会
      // 静默消失。新实现是 dock 槽位的普通条目，宿主一行都没有也能渲染。
      const { decl, Component } = registerWith('mimo')
      const props = decl.inject('session-1')
      const host = document.createElement('div')
      document.body.appendChild(host)
      const root = ReactDOMClient.createRoot(host)
      const { act } = React

      checkFn('文档里没有任何统计行', document.querySelectorAll('[data-composer-stats]').length === 0)
      await act(async () => { root.render(React.createElement(Component, { ...props, t })) })
      await act(async () => { await new Promise(r => setTimeout(r, 30)) })
      checkFn('无统计行时依然渲染（空会话也能看到额度）', host.querySelector('[data-mimo-quota]') !== null, host.innerHTML.slice(0, 140))

      await act(async () => { root.unmount() })
      host.remove()
    }

    console.log('\n== 生命周期边界 ==')
    {
      const { decl, Component } = registerWith('mimo')
      const props = decl.inject('session-1')
      const { act } = React

      /** 挂载一次并返回容器与卸载函数。 */
      async function mountOnce() {
        const host = document.createElement('div')
        document.body.appendChild(host)
        const root = ReactDOMClient.createRoot(host)
        await act(async () => { root.render(React.createElement(Component, { ...props, t })) })
        await act(async () => { await new Promise(r => setTimeout(r, 30)) })
        return {
          host,
          unmount: async () => { await act(async () => { root.unmount() }); host.remove() },
        }
      }

      // 边界 1：反复挂载/卸载不得抛错，且不留残留。
      {
        let threw
        try {
          for (let i = 0; i < 3; i++) {
            const m = await mountOnce()
            if (m.host.querySelector('[data-mimo-quota]') === null) throw new Error(`第 ${i + 1} 次挂载没渲染`)
            await m.unmount()
          }
        } catch (error) {
          threw = error
        }
        checkFn('反复挂载/卸载稳定', threw === undefined, threw?.message)
        checkFn('卸载后 DOM 无残留', document.querySelector('[data-mimo-quota]') === null)
      }

      // 边界 2：宿主提前把容器从文档里摘掉，再卸载不得抛错。
      {
        const m = await mountOnce()
        m.host.remove()
        let threw
        try {
          await act(async () => { m.host.remove() })
          await m.unmount()
        } catch (e) { threw = e }
        checkFn('容器被摘除后卸载不抛错', threw === undefined, threw?.message)
      }

      // 边界 3：金额读取失败时必须静默（不渲染、不抛错）。
      {
        payload = { available: false }
        const m = await mountOnce()
        checkFn('上游不可用时渲染为空', m.host.querySelector('[data-mimo-quota]') === null, m.host.innerHTML.slice(0, 120))
        await m.unmount()
        payload = { available: true, percent: 99.8, resetDate: '2026-09-30' }
      }
    }
  }
}

console.log(`\n=== ${pass} 通过, ${fail} 失败 ===`)
process.exitCode = fail === 0 ? 0 : 1
