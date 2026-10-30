/**
 * External-Chrome driver (Codex-style "use the real browser" lane, phase 1).
 *
 * The plugin launches its own persistent Chrome profile (cookies survive DSH
 * restarts) and talks to it over the DevTools Protocol. Google/Apple sign-in
 * works here because it is a real Chrome window with a real profile, not an
 * Electron <webview>.
 *
 * Everything below treats page content as data: it types only what the model
 * asked for and never executes page-provided instructions.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
]

export const DEFAULT_CHROME_URL = 'https://chatgpt.com/'

function findBrowser() {
  for (const candidate of CHROME_CANDIDATES) {
    if (candidate !== '' && existsSync(candidate)) return candidate
  }
  return undefined
}

function profileDir() {
  const dir = join(homedir(), '.dsh', 'dsh-browser', 'chrome-profile')
  mkdirSync(dir, { recursive: true })
  return dir
}

async function httpJson(url, timeoutMs = 3000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error('HTTP ' + String(response.status))
  return response.json()
}

async function waitFor(check, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      const value = await check()
      if (value) return value
    } catch (error) {
      last = error
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  throw last instanceof Error ? last : new Error('timed out waiting for ' + String(timeoutMs) + 'ms')
}

export class ChromeDriver {
  constructor(options = {}) {
    this.port = options.port ?? 9333
    this.proc = options.proc
    this.ws = options.ws
    this.nextId = 0
    this.pending = new Map()
    this.targetId = undefined
    this.connected = false
    this.lastError = undefined
    this.transcript = []
    this.images = []
    this.url = undefined
    this.title = undefined
    this.startedAt = undefined
  }

  get endpoint() {
    return 'http://127.0.0.1:' + String(this.port)
  }

  async alive() {
    try {
      await httpJson(this.endpoint + '/json/version', 1500)
      return true
    } catch {
      return false
    }
  }

  async ensure() {
    if (await this.alive()) {
      await this.attach()
      return this
    }
    const executable = findBrowser()
    if (executable === undefined) {
      throw new Error('没有找到 Chrome/Edge 可执行文件；请安装 Google Chrome 或 Microsoft Edge。')
    }
    const dir = profileDir()
    const args = [
      '--user-data-dir=' + dir,
      '--remote-debugging-port=' + String(this.port),
      '--remote-allow-origins=*',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,MediaRouter',
      DEFAULT_CHROME_URL,
    ]
    this.proc = spawn(executable, args, { detached: true, stdio: 'ignore' })
    this.proc.unref()
    this.startedAt = Date.now()
    await waitFor(() => this.alive(), 20000, 300)
    await this.attach()
    return this
  }

  async targets() {
    return httpJson(this.endpoint + '/json/list', 4000)
  }

  async attach() {
    if (this.connected && this.ws !== undefined && this.ws.readyState === 1) return
    const list = await this.targets()
    const pages = list.filter(item => item.type === 'page' && typeof item.url === 'string' && /^https?:/.test(item.url))
    const target = pages.find(item => /chatgpt\.com|chat\.deepseek\.com|claude\.ai|gemini\.google\.com/.test(item.url)) ?? pages[0] ?? list[0]
    if (target === undefined) throw new Error('外部 Chrome 已启动，但还没有可用的标签页。')
    this.targetId = target.id
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连接 Chrome DevTools 超时')), 10000)
      ws.addEventListener('open', () => { clearTimeout(timer); resolve() })
      ws.addEventListener('error', (event) => { clearTimeout(timer); reject(new Error('连接 Chrome DevTools 失败: ' + String(event?.message ?? 'error'))) })
    })
    ws.addEventListener('message', event => this.onMessage(event))
    ws.addEventListener('close', () => {
      this.connected = false
      this.ws = undefined
      for (const [, entry] of this.pending) entry.reject(new Error('Chrome DevTools 连接已断开'))
      this.pending.clear()
    })
    this.ws = ws
    this.connected = true
  }

  onMessage(event) {
    let payload
    try {
      payload = JSON.parse(String(event.data))
    } catch {
      return
    }
    if (payload.id !== undefined) {
      const entry = this.pending.get(payload.id)
      if (entry === undefined) return
      this.pending.delete(payload.id)
      if (payload.error !== undefined) entry.reject(new Error(String(payload.error.message ?? 'CDP error')))
      else entry.resolve(payload.result)
      return
    }
    // Keep the visible tab in sync for the panel.
    if (payload.method === 'Page.frameNavigated' && payload.params?.frame?.url) {
      this.url = payload.params.frame.url
    }
  }

  send(method, params = {}, timeoutMs = 20000) {
    if (this.ws === undefined || this.ws.readyState !== 1) {
      throw new Error('外部 Chrome 尚未连接；先执行 chrome 动作 op="start"。')
    }
    const id = ++this.nextId
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Chrome CDP 超时: ' + method))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value) },
        reject: error => { clearTimeout(timer); reject(error) },
      })
    })
    this.ws.send(JSON.stringify({ id, method, params }))
    return promise
  }

  async evaluate(expression, awaitPromise = true) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
      timeout: 30000,
    })
    if (result.exceptionDetails !== undefined) {
      const detail = result.exceptionDetails
      throw new Error('页面脚本出错: ' + String(detail.exception?.description ?? detail.text ?? 'unknown'))
    }
    return result.result?.value
  }

  /** Run a diagnostic JavaScript expression in the real page (no promise awaiting). */
  async evalPage(script) {
    await this.ensure()
    return this.evaluate(String(script), false)
  }

  async reloadState() {
    try {
      const info = await this.evaluate('({ url: location.href, title: document.title })', false)
      if (info !== null && typeof info === 'object') {
        this.url = typeof info.url === 'string' ? info.url : this.url
        this.title = typeof info.title === 'string' ? info.title : this.title
      }
    } catch {
      // Non-fatal: status is advisory.
    }
    return { url: this.url, title: this.title }
  }

  async goto(url) {
    await this.ensure()
    await this.send('Page.navigate', { url })
    await waitFor(async () => {
      const ready = await this.evaluate("document.readyState === 'complete' ? location.href : ''", false)
      return typeof ready === 'string' && ready !== '' ? ready : undefined
    }, 30000, 300)
    await this.reloadState()
    return { url: this.url, title: this.title }
  }

  /** Site adapters evaluated inside the real page (same shapes as the embedded client). */
  pageThreadScript() {
    return `(() => {
      const host = location.hostname
      const out = []
      const clean = (s) => String(s || '').replace(/\\u00a0/g, ' ').replace(/[ \\t]+\\n/g, '\\n').trim()
      if (host.includes('chatgpt.com') || host.includes('chat.openai.com')) {
        const headings = [...document.querySelectorAll('[data-conversation-role]')]
        if (headings.length > 0) {
          for (const heading of headings) {
            const role = heading.getAttribute('data-conversation-role') === 'assistant' ? 'assistant' : 'user'
            let node = heading
            let content = null
            for (let depth = 0; depth < 10 && node; depth += 1) {
              const found = node.querySelector('[class*="bubble-"], [class*="MarkdownRoot"], .markdown')
              if (found !== null && found !== heading) {
                content = found
                break
              }
              node = node.parentElement
            }
            const text = clean((content || heading).innerText)
            if (text !== '') out.push({ role, text, source: 'chatgpt' })
          }
          return out
        }
        for (const node of document.querySelectorAll('[data-message-author-role]')) {
          const role = node.getAttribute('data-message-author-role') === 'assistant' ? 'assistant' : 'user'
          const source = node.querySelector('.markdown') || node.querySelector('[data-message-id]') || node
          out.push({ role, text: clean(source.innerText), source: 'chatgpt' })
        }
        return out
      }
      if (host.includes('chat.deepseek.com')) {
        for (const node of document.querySelectorAll('.ds-message')) {
          const answer = node.querySelector('.ds-assistant-message-main-content')
          if (answer) out.push({ role: 'assistant', text: clean(answer.innerText), source: 'deepseek' })
          else {
            const text = clean(node.innerText)
            if (text !== '') out.push({ role: 'user', text, source: 'deepseek' })
          }
        }
        return out
      }
      if (host.includes('claude.ai')) {
        for (const node of document.querySelectorAll('[data-testid="user-message"], .font-claude-message, [data-testid="assistant-message"]')) {
          const role = node.matches('[data-testid="user-message"]') ? 'user' : 'assistant'
          out.push({ role, text: clean(node.innerText), source: 'claude' })
        }
        return out
      }
      for (const node of document.querySelectorAll('main p, main li, main pre')) {
        const text = clean(node.innerText)
        if (text.length > 40) out.push({ role: 'unknown', text, source: 'generic' })
      }
      return out
    })()`
  }

  async thread() {
    await this.ensure()
    const messages = await this.evaluate(this.pageThreadScript())
    this.transcript = Array.isArray(messages) ? messages.slice(-40) : []
    return this.transcript
  }

  async lastReply() {
    const messages = await this.thread()
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === 'assistant') return messages[index]
    }
    return undefined
  }

  /** Focus the composer and insert text; returns the selector that was used. */
  async typeIntoComposer(text) {
    const focused = await this.evaluate(`(() => {
      const host = location.hostname
      const candidates = host.includes('chatgpt.com')
        ? ['#prompt-textarea', 'div[contenteditable="true"]', 'textarea']
        : host.includes('chat.deepseek.com')
          ? ['textarea[placeholder*="DeepSeek"]', 'textarea', 'div[contenteditable="true"]']
          : ['textarea', 'div[contenteditable="true"]', '[role="textbox"]']
      for (const selector of candidates) {
        const element = document.querySelector(selector)
        if (element === null) continue
        element.focus()
        element.click()
        return selector
      }
      return ''
    })()`)
    if (typeof focused !== 'string' || focused === '') {
      throw new Error('在页面里没有找到输入框（可能未登录或页面结构变了）。')
    }
    await this.send('Input.insertText', { text })
    return focused
  }

  async clickSend() {
    const clicked = await this.evaluate(`(() => {
      const host = location.hostname
      const selectors = host.includes('chatgpt.com')
        ? ['button[data-testid="send-button"]', 'button[aria-label*="发送"]', 'button[aria-label*="Send"]']
        : host.includes('chat.deepseek.com')
          ? ['div.ds-button--primary', 'button[aria-label*="发送"]']
          : ['button[type="submit"]', 'button[aria-label*="Send"]', 'button[aria-label*="发送"]']
      for (const selector of selectors) {
        const element = document.querySelector(selector)
        if (element === null) continue
        element.click()
        return selector
      }
      const form = document.querySelector('form')
      if (form !== null) { form.requestSubmit(); return 'form' }
      return ''
    })()`)
    if (typeof clicked !== 'string' || clicked === '') {
      // Fall back to pressing Enter inside the composer.
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
      return 'Enter'
    }
    return clicked
  }

  async ask(prompt, options = {}) {
    await this.ensure()
    const before = await this.thread()
    const beforeAssistants = before.filter(item => item.role === 'assistant').length
    const composer = await this.typeIntoComposer(prompt)
    const sentWith = await this.clickSend()
    const deadline = Date.now() + (options.timeoutMs ?? 180000)
    let stableSince = 0
    let lastText = ''
    let reply
    const pending = (text) => /正在创建图像|正在思考|正在生成|Thinking|Creating image|Generating image/i.test(String(text || ''))
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1500))
      const messages = await this.thread()
      const assistants = messages.filter(item => item.role === 'assistant')
      const candidate = assistants.length > beforeAssistants ? assistants[assistants.length - 1] : undefined
      if (candidate === undefined) continue
      reply = candidate
      if (pending(candidate.text) || candidate.text.trim() === prompt.trim()) {
        stableSince = 0
        lastText = candidate.text
        continue
      }
      if (candidate.text === lastText && candidate.text !== '') {
        if (stableSince === 0) stableSince = Date.now()
        else if (Date.now() - stableSince > 4000) break
      } else {
        stableSince = 0
        lastText = candidate.text
      }
    }
    this.transcript = await this.thread()
    return { composer, sentWith, reply, messages: this.transcript }
  }

  async collectImages() {
    await this.ensure()
    const scan = `(() => {
      const scroller = document.querySelector('.thread-scroll-container')
      if (scroller !== null) scroller.scrollTop = scroller.scrollHeight
      const nodes = [...document.querySelectorAll('main img, article img, [data-conversation-role] img, img[alt*="图像"], img[alt*="image"]')]
      const urls = []
      for (const node of nodes) {
        const src = node.currentSrc || node.src || ''
        if (src.startsWith('data:image/')) { urls.push({ src, alt: node.alt || '' }); continue }
        if (!/^(https?|blob):/.test(src)) continue
        if (node.naturalWidth < 64 || node.naturalHeight < 64) continue
        urls.push({ src, alt: node.alt || '' })
      }
      return urls.slice(-8)
    })()`
    let sources = []
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 1000))
      const found = await this.evaluate(attempt === 0 ? `(() => { const s = document.querySelector('.thread-scroll-container'); if (s !== null) s.scrollTop = s.scrollHeight; return true })()` : scan)
      if (attempt === 0) continue
      if (Array.isArray(found) && found.length > 0) { sources = found; break }
    }
    if (sources.length === 0) {
      const found = await this.evaluate(scan)
      if (Array.isArray(found)) sources = found
    }
    if (!Array.isArray(sources) || sources.length === 0) return []
    const data = await this.evaluate(`(async () => {
      const list = ${JSON.stringify(sources)}
      const out = []
      for (const item of list) {
        try {
          const response = await fetch(item.src)
          const blob = await response.blob()
          if (!/^image\\//.test(blob.type)) continue
          const buffer = await new Promise((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve(String(reader.result || ''))
            reader.onerror = () => reject(reader.error || new Error('read failed'))
            reader.readAsDataURL(blob)
          })
          const comma = buffer.indexOf(',')
          out.push({ name: item.alt || 'image', mediaType: blob.type, base64: buffer.slice(comma + 1) })
        } catch (error) {
          out.push({ name: item.alt || 'image', error: String(error && error.message || error) })
        }
      }
      return out
    })()`)
    this.images = Array.isArray(data) ? data : []
    return this.images
  }

  async screenshot() {
    await this.ensure()
    const result = await this.send('Page.captureScreenshot', { format: 'png' }, 30000)
    return result?.data
  }

  snapshot() {
    return {
      running: this.connected === true || this.proc !== undefined,
      connected: this.connected,
      port: this.port,
      url: this.url,
      title: this.title,
      targetId: this.targetId,
      transcript: this.transcript.slice(-30),
      images: this.images.slice(-4).map(item => ({ name: item.name, mediaType: item.mediaType, base64: item.base64, error: item.error })),
      lastError: this.lastError,
    }
  }

  async dispose() {
    try {
      if (this.ws !== undefined) this.ws.close()
    } catch {
      // ignore
    }
    this.ws = undefined
    this.connected = false
    if (this.proc !== undefined) {
      try {
        this.proc.kill()
      } catch {
        // ignore
      }
      this.proc = undefined
    }
  }
}

export const chrome = new ChromeDriver()
