/**
 * Client half of the `dsh-browser` bundle.
 *
 * Runs in the Harness page. Long-polls the Host half over the private
 * Connection channel and executes each command against the embedded web AI
 * page: either the right-Sidebar Browser tab (Desktop `<webview>`) or the
 * docked bottom panel this plugin creates itself.
 *
 * Page content is untrusted data: this file only reads it, and only types a
 * prompt after the user approved it in the panel dialog.
 */

window.__ModuleLoader__.load({
  id: 'dsh-browser',
  factory(require) {
    function reportClient(phase, message, stack) {
      try {
        const url = new URL('dsh-browser/log', document.baseURI)
        void fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ phase: 'client-' + phase, message: String(message).slice(0, 2000), stack: stack === undefined ? undefined : String(stack).slice(0, 4000) }),
        }).catch(() => {})
      } catch {
        // ignore
      }
    }
    try {
      return bootstrapClient(require)
    } catch (error) {
      reportClient('factory-throw', error && error.message ? error.message : String(error), error && error.stack ? error.stack : undefined)
      throw error
    }

    function bootstrapClient(require) {
    const React = require('react')
    const POLL_WAIT_MS = 25000
    const FRAME_SELECTOR = 'webview[data-sidebar-browser-frame]'
    const DOCK_ID = 'dsh-browser-dock'
    const DOCK_SLOT = 'shell.bottom'
    const PANEL_ID = 'dsh-browser-panel'
    const PLACEMENT_ORDER = ['right', 'bottom', 'left', 'top']
    const PLACEMENT_LABEL = { right: '右侧', bottom: '底部', left: '左侧', top: '顶部' }
    const DEFAULT_URL = 'https://chatgpt.com'
    // Google's sign-in flow rejects the Electron user agent inside a guest, so the panel presents
    // itself as a regular desktop Chrome to sites that gate on the UA.
    const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
    const SIZE_KEY = 'dsh-browser.sizes.v1'
    const VERSION = '0.2.8'
    const HELLO_PATH = 'dsh-browser/hello'

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    function safe(read) {
      try {
        return read()
      } catch {
        return undefined
      }
    }

    const SITES = {
      chatgpt: {
        hosts: ['chatgpt.com', 'chat.openai.com'],
        composer: ['#prompt-textarea', 'textarea[data-testid="prompt-textarea"]', 'div[contenteditable="true"]'],
        send: ['[data-testid="send-button"]', 'button[aria-label*="Send"]', 'button[data-testid="fruitjuice-send-button"]'],
        messages: ['[data-message-author-role]'],
        roleAttr: 'data-message-author-role',
        stop: ['[data-testid="stop-button"]', 'button[aria-label*="Stop"]'],
      },
      claude: {
        hosts: ['claude.ai'],
        composer: ['div[contenteditable="true"].ProseMirror', 'div[contenteditable="true"]', 'textarea'],
        send: ['button[aria-label*="Send"]', 'button[aria-label*="Reply"]'],
        messages: ['[data-testid="user-message"]', '[data-testid="assistant-message"]', 'div.font-claude-message'],
        roleAttr: 'data-testid',
        stop: ['button[aria-label*="Stop"]'],
      },
      deepseek: {
        hosts: ['chat.deepseek.com'],
        composer: ['textarea[placeholder*="DeepSeek"]', 'textarea'],
        send: ['div.ds-button--primary'],
        messages: ['.ds-message'],
        roleAttr: '',
        stop: ['div[class*="stop"]'],
      },
      gemini: {
        hosts: ['gemini.google.com'],
        composer: ['rich-textarea div[contenteditable="true"]', 'div[contenteditable="true"]', 'textarea'],
        send: ['button[aria-label*="Send"]', 'button.send-button'],
        messages: ['user-query', 'model-response'],
        roleAttr: '',
        stop: ['button[aria-label*="Stop"]'],
      },
      generic: {
        hosts: [],
        composer: ['div[contenteditable="true"]', 'textarea'],
        send: ['button[type="submit"]', 'button[aria-label*="Send"]', 'button[aria-label*="发送"]'],
        messages: ['[data-message-author-role]', 'article', '.markdown', '.message'],
        roleAttr: '',
        stop: ['button[aria-label*="Stop"]'],
      },
    }

    function siteProfile(name, href) {
      const host = String(href || '')
      if (name !== undefined && name !== null && name !== '' && name !== 'auto' && SITES[name] !== undefined) return SITES[name]
      for (const profile of [SITES.chatgpt, SITES.claude, SITES.gemini, SITES.deepseek]) {
        if (profile.hosts.some((candidate) => host.includes(candidate))) return profile
      }
      return SITES.generic
    }

    //#region Page scripts — stringified and evaluated inside the embedded page.
    function pageThread(options) {
      const profile = JSON.parse(options.profile)
      const maxChars = Number(options.maxChars) > 0 ? Number(options.maxChars) : 12000
      const hit = (selectors) => {
        for (const selector of selectors) {
          try {
            const nodes = Array.from(document.querySelectorAll(selector))
            if (nodes.length > 0) return nodes
          } catch {
            // ignore a selector the page cannot parse
          }
        }
        return []
      }
      const nodes = hit(profile.messages)
      const messages = []
      let total = 0
      for (const node of nodes) {
        if (total >= maxChars) break
        let role = 'unknown'
        const answer = typeof node.querySelector === 'function' ? node.querySelector('.ds-assistant-message-main-content') : null
        const attr = profile.roleAttr ? node.getAttribute(profile.roleAttr) || '' : ''
        if (attr !== '') role = attr
        else if (node.closest('[data-message-author-role]') !== null) role = node.closest('[data-message-author-role]').getAttribute('data-message-author-role') || 'unknown'
        else if (node.tagName.toLowerCase() === 'user-query') role = 'user'
        else if (node.tagName.toLowerCase() === 'model-response') role = 'assistant'
        else if (node.matches('[data-testid="user-message"]')) role = 'user'
        else if (node.matches('[data-testid="assistant-message"]')) role = 'assistant'
        else if (answer !== null) role = 'assistant'
        else if (typeof node.matches === 'function' && node.matches('.ds-message')) role = 'user'
        const source = answer !== null ? answer : node
        const text = String(source.innerText || '').replace(/\n{3,}/g, '\n\n').trim()
        if (text.length === 0) continue
        const slice = text.slice(0, 4000)
        total += slice.length
        messages.push({ role, text: slice })
      }
      return {
        url: String(location.href),
        title: String(document.title || ''),
        messages,
        truncated: total >= maxChars,
      }
    }

    function pageLastReply(options) {
      const profile = JSON.parse(options.profile)
      const maxChars = Number(options.maxChars) > 0 ? Number(options.maxChars) : 12000
      const hit = (selectors) => {
        for (const selector of selectors) {
          try {
            const nodes = Array.from(document.querySelectorAll(selector))
            if (nodes.length > 0) return nodes
          } catch {
            // ignore
          }
        }
        return []
      }
      const nodes = hit(profile.messages).filter((node) => String(node.innerText || '').trim().length > 0)
      const stops = hit(profile.stop)
      const stopVisible = stops.some((node) => {
        const rect = node.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== 'hidden'
      })
      if (nodes.length === 0) return { text: '', stop: stopVisible, role: '', url: String(location.href) }
      const last = nodes[nodes.length - 1]
      let role = 'unknown'
      const answer = typeof last.querySelector === 'function' ? last.querySelector('.ds-assistant-message-main-content') : null
      const attr = profile.roleAttr ? last.getAttribute(profile.roleAttr) || '' : ''
      if (attr !== '') role = attr
      else if (last.matches('user-query')) role = 'user'
      else if (last.matches('model-response')) role = 'assistant'
      else if (last.matches('[data-testid="user-message"]')) role = 'user'
      else if (last.matches('[data-testid="assistant-message"]')) role = 'assistant'
      else if (answer !== null) role = 'assistant'
      else if (typeof last.matches === 'function' && last.matches('.ds-message')) role = 'user'
      const source = answer !== null ? answer : last
      const text = String(source.innerText || '').replace(/\n{3,}/g, '\n\n').trim()
      return {
        text: text.slice(0, maxChars),
        stop: stopVisible,
        role,
        url: String(location.href),
        title: String(document.title || ''),
        truncated: text.length > maxChars,
      }
    }

    function pageComposerSubmit(options) {
      const profile = JSON.parse(options.profile)
      const find = (selectors) => {
        for (const selector of selectors) {
          try {
            const node = document.querySelector(selector)
            if (node !== null && node.getClientRects().length > 0) return node
          } catch {
            // ignore
          }
        }
        return null
      }
      const composer = find(profile.composer)
      if (composer === null) throw new Error('Could not find the message box on this page. Is the web AI chat open and logged in?')
      composer.scrollIntoView({ block: 'center' })
      composer.focus()
      const text = String(options.text)
      if (composer.tagName.toLowerCase() === 'textarea' || composer.tagName.toLowerCase() === 'input') {
        const proto = composer.tagName.toLowerCase() === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
        setter.call(composer, text)
        composer.dispatchEvent(new Event('input', { bubbles: true }))
        composer.dispatchEvent(new Event('change', { bubbles: true }))
      } else {
        const selection = window.getSelection()
        const range = document.createRange()
        range.selectNodeContents(composer)
        selection.removeAllRanges()
        selection.addRange(range)
        let inserted = false
        try {
          inserted = document.execCommand('insertText', false, text)
        } catch {
          inserted = false
        }
        if (!inserted) {
          composer.innerText = text
          composer.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }))
        }
      }
      const senders = (() => {
        for (const selector of profile.send) {
          try {
            const nodes = Array.from(document.querySelectorAll(selector))
            if (nodes.length > 0) return nodes
          } catch {
            // ignore
          }
        }
        return []
      })()
      const button = senders.find((node) => node.disabled !== true && node.getAttribute('aria-disabled') !== 'true')
      if (button !== undefined) {
        button.click()
        return { submitted: 'button' }
      }
      composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
      composer.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
      composer.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
      return { submitted: 'enter' }
    }

    function pageImages(options) {
      const profile = JSON.parse(options.profile)
      const limit = Number(options.limit) > 0 ? Math.min(Number(options.limit), 8) : 4
      const hit = (selectors) => {
        for (const selector of selectors) {
          try {
            const nodes = Array.from(document.querySelectorAll(selector))
            if (nodes.length > 0) return nodes
          } catch {
            // ignore
          }
        }
        return []
      }
      const nodes = hit(profile.messages).filter((node) => String(node.innerText || '').trim().length > 0)
      const scope = nodes.length === 0 ? document.body : nodes[nodes.length - 1]
      const images = Array.from(scope.querySelectorAll('img')).filter((img) => {
        const rect = img.getBoundingClientRect()
        return rect.width >= 32 && rect.height >= 32 && img.complete === true
      })
      return images.slice(0, limit).map((img) => ({
        src: String(img.currentSrc || img.src || '').slice(0, 2000),
        alt: String(img.alt || '').slice(0, 200),
        width: Math.round(img.getBoundingClientRect().width),
        height: Math.round(img.getBoundingClientRect().height),
      }))
    }

    async function pageImageBytes(options) {
      const src = String(options.src || '')
      if (src.length === 0) return null
      const inline = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/i.exec(src)
      if (inline !== null) return { base64: inline[2], mediaType: inline[1] }
      if (!/^https?:|^blob:/i.test(src)) return null
      const response = await fetch(src, { credentials: 'include' })
      if (response.ok !== true) return null
      const blob = await response.blob()
      const mediaType = blob.type || 'image/png'
      if (!/^image\//.test(mediaType)) return null
      const buffer = await blob.arrayBuffer()
      let binary = ''
      const bytes = new Uint8Array(buffer)
      const chunk = 0x8000
      for (let index = 0; index < bytes.length; index += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk))
      }
      return { base64: btoa(binary), mediaType }
    }
    //#endregion

    function sidebarRightOf(ctx) {
      if (typeof ctx.get === 'function') return ctx.get('sidebarRight')
      return ctx.sidebarRight
    }

    function browserFrames() {
      return Array.from(document.querySelectorAll(FRAME_SELECTOR))
    }

    function frameIsVisible(element) {
      try {
        if (element === undefined || element === null || element.isConnected !== true) return false
        const rect = element.getBoundingClientRect()
        if (rect.width < 2 || rect.height < 2) return false
        const style = window.getComputedStyle(element)
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0
      } catch {
        return false
      }
    }

    function activeTabOf(ctx) {
      const sidebarRight = sidebarRightOf(ctx)
      if (sidebarRight === undefined || sidebarRight === null || typeof sidebarRight.active !== 'function') return undefined
      return safe(() => sidebarRight.active())
    }

    function frameForTab(tab) {
      if (tab === undefined || tab === null || tab.id === undefined || tab.id === null) return undefined
      const escape = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(String(tab.id)) : String(tab.id)
      return document.querySelector('div[data-sidebar-right-tab="' + escape + '"] ' + FRAME_SELECTOR) || undefined
    }

    function pickFrame(state, ctx) {
      const tab = activeTabOf(ctx)
      if (tab !== undefined && tab !== null && tab.kind === 'browser') {
        const exact = frameForTab(tab)
        if (exact !== undefined) return exact
      }
      const frames = browserFrames()
      if (frames.length === 0) return undefined
      if (state.last !== undefined && state.last.isConnected === true && frames.includes(state.last)) return state.last
      const visible = frames.filter(frameIsVisible)
      if (visible.length > 0) return visible[visible.length - 1]
      return frames[frames.length - 1]
    }

    function collapseRightColumn(ctx) {
      const sidebarRight = sidebarRightOf(ctx)
      if (sidebarRight === undefined || sidebarRight === null) return
      if (safe(() => sidebarRight.isExpanded()) === true && typeof sidebarRight.toggleExpanded === 'function') {
        safe(() => sidebarRight.toggleExpanded())
      }
    }

    async function frameReady(frame, timeoutMs) {
      const deadline = Date.now() + timeoutMs
      let lastError
      while (Date.now() < deadline) {
        try {
          if (frame.isConnected === false) throw new Error('the panel was closed')
          const ping = await frame.executeJavaScript('1', true)
          if (ping === 1) return true
        } catch (error) {
          lastError = error
        }
        await sleep(150)
      }
      throw new Error('The embedded page is not ready'
        + (lastError instanceof Error && lastError.message ? ': ' + lastError.message : '. Open or reload the panel and retry.'))
    }

    async function openRightTab(ctx, url) {
      const sidebarRight = sidebarRightOf(ctx)
      if (sidebarRight === undefined || sidebarRight === null) {
        throw new Error('The right Sidebar is unavailable in this Harness page. Use action "layout" with mode "bottom" instead.')
      }
      safe(() => sidebarRight.openTab('browser', { params: { url } }))
      const deadline = Date.now() + 20000
      while (Date.now() < deadline) {
        const tab = activeTabOf(ctx)
        const frame = (tab === undefined ? undefined : frameForTab(tab)) || browserFrames()[0]
        if (frame !== undefined) return frame
        await sleep(150)
      }
      throw new Error('The Browser tab was requested but no page appeared. Check that the built-in right-Sidebar Browser is enabled in this build.')
    }

    function ensureRightColumn(ctx) {
      const sidebarRight = sidebarRightOf(ctx)
      if (sidebarRight === undefined || sidebarRight === null) return
      if (safe(() => sidebarRight.isExpanded()) !== true && typeof sidebarRight.toggleExpanded === 'function') {
        safe(() => sidebarRight.toggleExpanded())
      }
      const tab = activeTabOf(ctx)
      if (tab !== undefined && tab !== null && tab.id !== undefined && typeof sidebarRight.focus === 'function') {
        safe(() => sidebarRight.focus(tab.id))
      }
    }

    //#region Split panel (right / bottom / left / top)
    function desktopBrowser() {
      const carrier = globalThis.dshDesktop
      if (carrier === undefined || carrier === null) return undefined
      if (carrier.protocolVersion !== 1) return undefined
      return carrier.browser
    }

    async function workspaceKeyFor(ctx) {
      let sessionId
      try {
        sessionId = ctx.get('sessions')?.activeId
      } catch (error) {
        sessionId = undefined
      }
      try {
        const items = ctx.get('workspaces')?.list?.getSnapshot?.()?.items ?? []
        const found = items.find((item) => Array.isArray(item.sessionIds) && item.sessionIds.includes(sessionId))
        if (found !== undefined && found !== null && typeof found.path === 'string') return 'cwd:' + found.path
      } catch (error) {
        console.error('[dsh-browser] workspace lookup', error)
      }
      return 'session:' + String(sessionId === undefined ? 'dsh-browser' : sessionId)
    }

    function panelRootOf(state) {
      if (state.panelRoot !== undefined && state.panelRoot !== null && state.panelRoot.isConnected) return state.panelRoot
      return undefined
    }

    function frameCandidates() {
      return ['[data-dsh-frame]', '#root > div', '#root', 'body > div']
    }

    function findFrameRoot() {
      for (const selector of frameCandidates()) {
        const element = document.querySelector(selector)
        if (element === null || element === undefined) continue
        if (typeof element.closest === 'function' && element.closest('#' + PANEL_ID) !== null) continue
        const rect = element.getBoundingClientRect()
        if (rect.width > 320 && rect.height > 240) return { element, selector }
      }
      return undefined
    }

    function findLayoutFrame() {
      const explicit = document.querySelector('[data-dsh-frame]')
      if (explicit !== null && explicit !== undefined && explicit.getBoundingClientRect().width > 320) return explicit
      const area = window.innerWidth * window.innerHeight
      let best
      for (const element of Array.from(document.querySelectorAll('div'))) {
        if (element.id === PANEL_ID) continue
        if (typeof element.closest === 'function' && element.closest('#' + PANEL_ID) !== null) continue
        const computed = getComputedStyle(element)
        if (computed.display !== 'grid') continue
        if (element.children.length < 2) continue
        const rect = element.getBoundingClientRect()
        if (rect.width * rect.height < area * 0.55) continue
        if (best === undefined || rect.width * rect.height > best.area) best = { element, area: rect.width * rect.height }
      }
      return best === undefined ? undefined : best.element
    }

    function layoutParts(frame) {
      if (frame === undefined || frame === null) return undefined
      const kids = Array.from(frame.children).filter((element) => {
        if (element.id === PANEL_ID) return false
        const rect = element.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      })
      if (kids.length < 2) return undefined
      const sidebar = kids[0]
      const main = kids[1]
      const rightbar = kids[2]
      const sbW = Math.round(sidebar.getBoundingClientRect().width)
      if (sbW < 32 || sbW > 640) return undefined
      return { frame, sidebar, main, rightbar, sbW }
    }

    function guessSidebarWidth() {
      for (const selector of ['[data-shell-sidebar]', '[data-sidebar]', 'aside', 'nav']) {
        const element = document.querySelector(selector)
        if (element === null || element === undefined) continue
        if (typeof element.closest === 'function' && element.closest('#' + PANEL_ID) !== null) continue
        const rect = element.getBoundingClientRect()
        if (rect.width >= 48 && rect.width <= 640 && rect.height > 200) return Math.round(rect.width)
      }
      return undefined
    }

    function restoreLayout(state) {
      const saved = state.gridSaved
      state.gridSaved = undefined
      state.gridParts = undefined
      if (saved !== undefined && saved !== null) {
        try {
          saved.frame.style.gridTemplateColumns = saved.columns
          saved.frame.style.gridTemplateRows = saved.rows
          for (const item of saved.items) {
            item.element.style.gridColumn = item.column
            item.element.style.gridRow = item.row
            item.element.style.height = item.height
            item.element.style.width = item.width
          }
        } catch (error) {
          console.error('[dsh-browser] restore grid', error)
        }
      }
      const element = state.shiftEl
      state.shiftEl = undefined
      if (element === undefined || element === null) return
      try {
        element.style.marginLeft = ''
        element.style.marginTop = ''
        element.style.marginBottom = ''
        element.style.width = ''
        element.style.height = ''
        element.style.maxHeight = ''
      } catch {
        // A frame node that disappeared must never break the panel.
      }
    }

    function clearFrameShift(state) {
      restoreLayout(state)
    }

    function splitTargetOf(state) {
      const parts = layoutParts(findLayoutFrame())
      state.gridParts = parts
      return parts
    }

    function splitSbW(state, parts) {
      if (parts !== undefined && Number(parts.sbW) > 0) return Math.round(Number(parts.sbW))
      const guess = guessSidebarWidth()
      return Math.round(Number(guess) > 0 ? Number(guess) : 280)
    }

    function positionPanelOver(state, edge, size, sbW) {
      const root = panelRootOf(state)
      if (root === undefined) return false
      root.style.position = 'fixed'
      root.style.margin = '0'
      root.style.gridColumn = ''
      root.style.gridRow = ''
      root.style.zIndex = '2147483000'
      if (edge === 'left') {
        root.style.left = sbW + 'px'
        root.style.top = '0'
        root.style.right = 'auto'
        root.style.bottom = 'auto'
        root.style.width = Math.round(size) + 'px'
        root.style.height = window.innerHeight + 'px'
      } else if (edge === 'top') {
        root.style.left = sbW + 'px'
        root.style.top = '0'
        root.style.right = '0'
        root.style.bottom = 'auto'
        root.style.width = 'auto'
        root.style.height = Math.round(size) + 'px'
      } else {
        root.style.left = sbW + 'px'
        root.style.right = '0'
        root.style.top = 'auto'
        root.style.bottom = '0'
        root.style.width = 'auto'
        root.style.height = Math.round(size) + 'px'
      }
      return true
    }

    function shiftContentFor(state, edge, size) {
      const parts = state.gridParts
      if (parts === undefined || parts === null) return false
      const { main, rightbar } = parts
      if (main === undefined || main === null || !main.isConnected) return false
      state.shiftEl = main
      const px = Math.max(0, Math.round(size)) + 'px'
      main.style.marginLeft = edge === 'left' ? px : ''
      main.style.marginTop = edge === 'top' ? px : ''
      main.style.marginBottom = edge === 'bottom' ? px : ''
      if (rightbar !== undefined && rightbar !== null && rightbar.isConnected) {
        rightbar.style.marginLeft = ''
        rightbar.style.marginTop = ''
        rightbar.style.marginBottom = edge === 'bottom' ? px : ''
      }
      return true
    }

    function applyGridSplit(state, edge, size) {
      const parts = splitTargetOf(state)
      const sbW = splitSbW(state, parts)
      if (parts !== undefined && parts !== null) shiftContentFor(state, edge, size)
      positionPanelOver(state, edge, size, sbW)
      return true
    }

    function fallbackPlace(state, edge, size, sbGuess) {
      const root = panelRootOf(state)
      if (root === undefined) return 'no-root'
      const px = Math.round(size) + 'px'
      const offset = Math.round(sbGuess === undefined ? 0 : sbGuess)
      root.style.position = 'fixed'
      if (edge === 'left') {
        root.style.left = offset + 'px'
        root.style.top = '0'
        root.style.bottom = '0'
        root.style.width = px
      } else if (edge === 'top') {
        root.style.left = offset + 'px'
        root.style.right = '0'
        root.style.top = '0'
        root.style.height = px
      } else {
        root.style.left = '0'
        root.style.right = '0'
        root.style.bottom = '0'
        root.style.height = px
      }
      attachRootTo(root, document.body)
      return 'overlay'
    }

    function persistSizes(state) {
      try {
        localStorage.setItem(SIZE_KEY, JSON.stringify({ height: state.panelHeight, width: state.panelWidth }))
      } catch (error) {
        console.error('[dsh-browser] persist sizes', error)
      }
    }


    function panelButton(state, label, onClick) {
      const button = document.createElement('button')
      button.textContent = label
      Object.assign(button.style, {
        background: 'transparent',
        color: 'inherit',
        border: '1px solid rgba(148, 163, 184, .35)',
        borderRadius: '5px',
        cursor: 'pointer',
        padding: '2px 8px',
        font: 'inherit',
        whiteSpace: 'nowrap',
      })
      button.addEventListener('click', onClick)
      return button
    }

    function makeResizer(state, edge) {
      const handle = document.createElement('div')
      handle.setAttribute('data-dsh-browser-resize', edge)
      const vertical = edge === 'top' || edge === 'bottom'
      Object.assign(handle.style, {
        position: 'absolute',
        zIndex: '6',
        display: 'none',
        background: 'transparent',
        touchAction: 'none',
      })
      if (vertical) {
        handle.style.left = '0'
        handle.style.right = '0'
        handle.style.height = '10px'
        handle.style.cursor = 'ns-resize'
        handle.style[edge === 'top' ? 'top' : 'bottom'] = '-5px'
      } else {
        handle.style.top = '0'
        handle.style.bottom = '0'
        handle.style.width = '10px'
        handle.style.cursor = 'ew-resize'
        handle.style[edge === 'right' ? 'right' : 'left'] = '-5px'
      }
      handle.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return
        if (typeof state.beginResize !== 'function') return
        event.preventDefault()
        state.beginResize(edge, event)
      })
      return handle
    }

    function updateResizeHandles(state, mode) {
      const resizers = state.panelResizers
      if (resizers === undefined || resizers === null) return
      resizers.top.style.display = mode === 'bottom' ? 'block' : 'none'
      resizers.right.style.display = mode === 'left' ? 'block' : 'none'
      resizers.bottom.style.display = mode === 'top' ? 'block' : 'none'
    }

    function ensurePanelShell(state) {
      const existing = panelRootOf(state)
      if (existing !== undefined) return existing
      const root = document.createElement('div')
      root.id = PANEL_ID
      root.setAttribute('data-dsh-browser-panel', '')
      Object.assign(root.style, {
        display: 'flex',
        flexDirection: 'column',
        minHeight: '0',
        minWidth: '0',
        background: 'var(--dsh-surface, #17181c)',
        color: 'var(--dsh-text, #e8e8ea)',
        boxShadow: '0 0 0 1px rgba(148,163,184,.28), 0 18px 40px rgba(0,0,0,.35)',
        font: '12px/1.4 system-ui, -apple-system, Segoe UI, sans-serif',
        zIndex: '2147483000',
      })
      const bar = document.createElement('div')
      bar.setAttribute('data-dsh-browser-bar', '')
      Object.assign(bar.style, {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '5px 8px',
        borderBottom: '1px solid rgba(148, 163, 184, .22)',
        userSelect: 'none',
        flexWrap: 'wrap',
      })
      const title = document.createElement('span')
      title.textContent = '\u7f51\u9875 AI'
      title.style.fontWeight = '700'
      const input = document.createElement('input')
      input.type = 'text'
      input.placeholder = DEFAULT_URL
      input.spellcheck = false
      Object.assign(input.style, {
        flex: '1',
        minWidth: '150px',
        background: 'rgba(148,163,184,.12)',
        color: 'inherit',
        border: '1px solid rgba(148,163,184,.3)',
        borderRadius: '5px',
        padding: '2px 8px',
        font: 'inherit',
      })
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          void state.onNavigate(input.value)
        }
      })
      const openButton = panelButton(state, '\u6253\u5f00', () => { void state.onNavigate(input.value) })
      const pickers = []
      for (const mode of PLACEMENT_ORDER) {
        const button = panelButton(state, PLACEMENT_LABEL[mode], () => { void state.onPlacement(mode) })
        button.setAttribute('data-placement', mode)
        button.title = '\u628a\u7f51\u9875 AI \u653e\u5230' + PLACEMENT_LABEL[mode]
        pickers.push(button)
      }
      const reloadButton = panelButton(state, '\u5237\u65b0', () => { void state.onReload() })
      const closeButton = panelButton(state, '\u5173\u95ed', () => { void state.onClose() })
      bar.append(title, input, openButton, ...pickers, reloadButton, closeButton)
      const viewHost = document.createElement('div')
      viewHost.setAttribute('data-dsh-browser-view-host', '')
      Object.assign(viewHost.style, {
        position: 'relative',
        display: 'flex',
        flex: '1',
        minHeight: '0',
        minWidth: '0',
      })
      root.append(bar, viewHost)
      const resizers = {
        top: makeResizer(state, 'top'),
        right: makeResizer(state, 'right'),
        bottom: makeResizer(state, 'bottom'),
      }
      root.append(resizers.top, resizers.right, resizers.bottom)
      state.panelResizers = resizers
      state.panelRoot = root
      state.panelBar = bar
      state.panelInput = input
      state.panelViewHost = viewHost
      state.panelPickers = pickers
      return root
    }

    function highlightPlacement(state, mode) {
      for (const button of state.panelPickers || []) {
        const active = button.getAttribute('data-placement') === mode
        button.style.background = active ? 'rgba(125,211,252,.22)' : 'transparent'
        button.style.borderColor = active ? 'rgba(125,211,252,.85)' : 'rgba(148,163,184,.35)'
      }
    }

    function describePlacement() {
      return 'bottom uses the shell.bottom slot when the frame provides it (otherwise a fixed band plus a frame shift); '
        + 'left and top use a fixed panel and push the Harness frame; right keeps the native right Sidebar column'
    }

    function attachRootTo(root, parent) {
      if (root.parentNode !== parent) parent.appendChild(root)
    }

    function mountPanel(state, mode) {
      const root = ensurePanelShell(state)
      const height = Math.max(160, Number(state.panelHeight) || 420)
      const width = Math.max(300, Number(state.panelWidth) || 480)
      state.panelHeight = height
      state.panelWidth = width
      clearFrameShift(state)
      for (const key of ['position', 'inset', 'left', 'right', 'top', 'bottom', 'width', 'height', 'margin', 'opacity', 'pointerEvents', 'gridColumn', 'gridRow', 'boxShadow', 'minWidth', 'minHeight']) {
        root.style[key] = ''
      }
      Object.assign(root.style, {
        display: 'flex',
        flexDirection: 'column',
        minHeight: '0',
        minWidth: '0',
        boxShadow: '0 0 0 1px rgba(148,163,184,.28), 0 18px 40px rgba(0,0,0,.35)',
        zIndex: '2147483000',
      })
      root.removeAttribute('data-resident')
      attachRootTo(root, document.body)
      if (mode === 'left' || mode === 'top' || mode === 'bottom') {
        const size = mode === 'left' ? width : height
        const parts = splitTargetOf(state)
        const sbW = splitSbW(state, parts)
        if (parts !== undefined && parts !== null) shiftContentFor(state, mode, size)
        positionPanelOver(state, mode, size, sbW)
        state.shiftSelector = (mode === 'bottom' ? 'bottom band' : mode === 'left' ? 'left column' : 'top band')
          + ' at ' + String(size) + 'px; sidebar ' + String(sbW) + 'px stays fixed (content shifted, guest kept alive)'
        root.setAttribute('data-resident', 'overlay')
      } else {
        root.style.left = '0'
        root.style.top = '0'
        root.style.width = '1px'
        root.style.height = '1px'
        root.style.opacity = '0'
        root.style.pointerEvents = 'none'
        root.setAttribute('data-resident', 'hidden')
      }
      highlightPlacement(state, mode)
      updateResizeHandles(state, mode)
      reportClient('panel-size', 'mode=' + String(mode) + ' stateHeight=' + String(state.panelHeight) + ' stateWidth=' + String(state.panelWidth) + ' styleHeight=' + String(root.style.height) + ' rectH=' + String(Math.round(root.getBoundingClientRect().height)))
      return root
    }

    async function disposePanel(state) {
      clearFrameShift(state)
      if (typeof state.panelOpenUnsub === 'function') {
        try {
          state.panelOpenUnsub()
        } catch (error) {
          console.error('[dsh-browser] panel open listener cleanup', error)
        }
        state.panelOpenUnsub = undefined
      }
      const view = state.panelView
      const lease = state.panelLease
      state.panelView = undefined
      state.panelLease = undefined
      if (view !== undefined) state.lastPanelUrl = String(safe(() => view.getURL()) || state.lastPanelUrl || '')
      if (view !== undefined && view.isConnected) view.remove()
      const root = panelRootOf(state)
      if (root !== undefined) root.remove()
      state.panelRoot = undefined
      if (lease !== undefined) {
        const bridge = desktopBrowser()
        if (bridge !== undefined) {
          try {
            await bridge.release(lease)
          } catch (error) {
            console.error('[dsh-browser] release lease', error)
          }
        }
      }
    }

    async function closePanel(state) {
      await disposePanel(state)
      if (state.mode === 'bottom' || state.mode === 'left' || state.mode === 'top') state.mode = undefined
    }
    //#endregion

    async function openPanelPage(state, ctx, url, options) {
      const requested = String(url === undefined || url === '' ? DEFAULT_URL : url)
      state.lastUrl = requested
      if (state.mode === 'right') {
        const frame = await openRightTab(ctx, requested)
        await frameReady(frame, 20000)
        ensureRightColumn(ctx)
        state.last = frame
        return frame
      }
      if (options !== undefined && options !== null && Number(options.height) > 0) {
        state.panelHeight = Math.max(160, Math.round(Number(options.height)))
      }
      if (options !== undefined && options !== null && Number(options.width) > 0) {
        state.panelWidth = Math.max(300, Math.round(Number(options.width)))
      }
      const nextMode = state.mode === undefined ? 'bottom' : state.mode
      const leavingNative = state.panelPlacement === 'right' && nextMode !== 'right'
      if (state.panelView !== undefined && state.panelPlacement !== nextMode && (nextMode === 'right' || leavingNative)) {
        state.lastPanelUrl = String(safe(() => state.panelView.getURL()) || state.lastPanelUrl || '')
        state.panelView.remove()
        state.panelView = undefined
        const oldLease = state.panelLease
        state.panelLease = undefined
        const oldBridge = desktopBrowser()
        if (oldLease !== undefined && oldBridge !== undefined) {
          try {
            await oldBridge.release(oldLease)
          } catch (error) {
            console.error('[dsh-browser] release lease on move', error)
          }
        }
      }
      state.panelPlacement = nextMode
      const root = mountPanel(state, nextMode)
      if (state.panelInput !== undefined) state.panelInput.value = requested
      const viewHost = state.panelViewHost === undefined ? root.querySelector('[data-dsh-browser-view-host]') : state.panelViewHost
      const existing = state.panelView
      if (existing !== undefined && existing.isConnected) {
        const current = String(safe(() => existing.getURL()) || '')
        if (current === '') {
          reportClient('panel-dead-guest', 'dropping a guest with no committed page')
          existing.remove()
          state.panelView = undefined
        } else if (current !== requested) {
          try {
            await existing.loadURL(requested)
          } catch (error) {
            if (!/ERR_ABORTED/i.test(error instanceof Error ? error.message : String(error))) {
              console.error('[dsh-browser] panel navigate', error)
            }
          }
        }
        if (state.panelView === existing) return existing
      }
      const bridge = desktopBrowser()
      if (bridge === undefined) {
        throw new Error('The split panel needs the DSH desktop runtime (embedded Chromium). On the Web carrier use placement "right".')
      }
      const reservation = await bridge.acquire(await workspaceKeyFor(ctx))
      const view = document.createElement('webview')
      view.setAttribute('data-dsh-browser-view', '')
      view.setAttribute('allowpopups', '')
      view.setAttribute('name', reservation.lease)
      view.setAttribute('partition', reservation.partition)
      view.setAttribute('useragent', CHROME_UA)
      view.setAttribute('src', 'about:blank#' + reservation.lease)
      Object.assign(view.style, {
        flex: '1',
        width: '100%',
        minWidth: '0',
        height: '100%',
        minHeight: '0',
        border: '0',
        background: '#fff',
      })
      viewHost.appendChild(view)
      state.panelLease = reservation.lease
      if (typeof bridge.onOpenRequested === 'function') {
        const unsubscribe = bridge.onOpenRequested(reservation.lease, (target) => {
          reportClient('panel-open-requested', 'url=' + String(target))
          void navigateGuest(view, target).catch((error) => {
            console.error('[dsh-browser] open requested navigation failed', error)
          })
        })
        state.panelOpenUnsub = typeof unsubscribe === 'function' ? unsubscribe : undefined
      }
      for (const name of ['dom-ready', 'did-navigate', 'did-fail-load', 'render-process-gone', 'destroyed']) {
        view.addEventListener(name, (event) => {
          const detail = event !== null && typeof event === 'object'
            ? ' code=' + String(event.errorCode) + ' reason=' + String(event.reason) + ' host=' + String(event.host)
            : ''
          reportClient('guest-' + name, 'url=' + String(safe(() => view.getURL()) || '') + detail)
        })
      }
      try {
        await waitGuestReady(view, 20000)
        try {
          if (typeof view.setUserAgent === 'function') view.setUserAgent(CHROME_UA)
        } catch (error) {
          reportClient('guest-ua-failed', error instanceof Error ? error.message : String(error))
        }
        await navigateGuest(view, requested)
      } catch (error) {
        view.remove()
        state.panelLease = undefined
        await disposePanel(state)
        throw error
      }
      state.panelView = view
      reportClient('panel-created', 'url=' + String(safe(() => view.getURL()) || ''))
      return view
    }

    async function navigateGuest(view, url) {
      try {
        await view.loadURL(String(url))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!/ERR_ABORTED/i.test(message)) throw error
      }
      const deadline = Date.now() + 20000
      while (Date.now() < deadline) {
        const current = String(safe(() => view.getURL()) || '')
        if (/^https?:/i.test(current)) return current
        await sleep(200)
      }
      return String(safe(() => view.getURL()) || '')
    }

    function waitGuestReady(view, timeoutMs) {
      return new Promise((resolve, reject) => {
        let settled = false
        const finish = (error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          view.removeEventListener('dom-ready', onReady)
          view.removeEventListener('did-fail-load', onFail)
          if (error === undefined) resolve(view)
          else reject(error)
        }
        const onReady = () => finish()
        const onFail = (event) => {
          const code = event !== null && typeof event === 'object' ? event.errorCode : undefined
          const description = event !== null && typeof event === 'object' ? event.errorDescription : undefined
          if (code === undefined || code === -3) return
          finish(new Error('The embedded page failed to load: ' + String(code) + ' ' + String(description)))
        }
        const timer = setTimeout(() => finish(new Error('Timed out waiting for the embedded page to attach (20s).')), timeoutMs)
        view.addEventListener('dom-ready', onReady)
        view.addEventListener('did-fail-load', onFail)
      })
    }

    function targetOf(state, ctx) {
      if (state.panelView !== undefined && state.panelView.isConnected) return state.panelView
      return pickFrame(state, ctx)
    }

    function frameInventory() {
      const items = []
      for (const element of Array.from(document.querySelectorAll('webview'))) {
        const attrs = []
        for (const attribute of Array.from(element.attributes || [])) attrs.push(attribute.name + '=' + String(attribute.value).slice(0, 48))
        items.push({ attrs, url: currentUrl(element), linked: element.isConnected !== false })
      }
      return items
    }

    function describeFrames() {
      const items = frameInventory()
      if (items.length === 0) return 'no <webview> element exists in this document'
      return items.map((item, index) => '#' + index + ' [' + item.attrs.join(' ') + '] url=' + item.url).join('; ')
    }

    function domSnapshot(state) {
      const rect = (element) => {
        const box = element.getBoundingClientRect()
        return { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) }
      }
      const name = (element) => {
        if (element === null || element === undefined) return 'null'
        const id = element.id === '' ? '' : '#' + element.id
        const classes = typeof element.className === 'string' && element.className !== '' ? '.' + element.className.trim().split(/\s+/).slice(0, 4).join('.') : ''
        return element.tagName.toLowerCase() + id + classes
      }
      const describe = (selector) => {
        const element = document.querySelector(selector)
        if (element === null || element === undefined) return { selector, found: false }
        const computed = getComputedStyle(element)
        return {
          selector,
          found: true,
          node: name(element),
          rect: rect(element),
          display: computed.display,
          position: computed.position,
          grid: String(computed.gridTemplateColumns || '').slice(0, 120),
          marginLeft: computed.marginLeft,
          width: computed.width,
        }
      }
      const bodyChildren = Array.from(document.body ? document.body.children : []).slice(0, 8).map((element) => ({ node: name(element), rect: rect(element), position: getComputedStyle(element).position }))
      const describeShift = (element) => {
        if (element === null || element === undefined) return null
        if (!element.isConnected) return { node: name(element), connected: false }
        return {
          node: name(element),
          connected: true,
          rect: rect(element),
          marginLeft: element.style.marginLeft === '' ? '' : element.style.marginLeft,
          marginTop: element.style.marginTop === '' ? '' : element.style.marginTop,
          marginBottom: element.style.marginBottom === '' ? '' : element.style.marginBottom,
        }
      }
      const layoutFrame = findLayoutFrame()
      const parts = layoutParts(layoutFrame)
      const launcher = document.querySelector('[data-dsh-browser-launcher]')
      const layout = {
        frame: layoutFrame === undefined || layoutFrame === null
          ? null
          : { node: name(layoutFrame), rect: rect(layoutFrame), sbW: parts === undefined ? null : parts.sbW },
        sidebar: parts === undefined ? null : describeShift(parts.sidebar),
        main: parts === undefined ? null : describeShift(parts.main),
        rightbar: parts === undefined ? null : describeShift(parts.rightbar),
        shiftSelector: state !== undefined && state !== null && typeof state.shiftSelector === 'string' ? state.shiftSelector : null,
        launcher: launcher === null || launcher === undefined ? null : { rect: rect(launcher), text: String(launcher.textContent || '').slice(0, 40) },
      }
      return {
        title: String(document.title || ''),
        viewport: { w: window.innerWidth, h: window.innerHeight },
        candidates: frameCandidates().map(describe),
        overlays: describe('[data-shell-bottom]'),
        bodyChildren,
        layout,
        panel: panelRootOf({ panelRoot: document.querySelector('#' + PANEL_ID) }) === undefined ? null : { rect: rect(document.querySelector('#' + PANEL_ID)), resident: document.querySelector('#' + PANEL_ID).getAttribute('data-resident') },
      }
    }

    async function requireFrame(state, ctx) {
      if (state.panelView !== undefined && state.panelView.isConnected) return state.panelView
      if (state.mode === 'bottom' || state.mode === 'left' || state.mode === 'top') {
        throw new Error('The split panel is not open. Call action "open" or "layout" with mode="' + String(state.mode) + '" first.')
      }
      let frame = pickFrame(state, ctx)
      if (frame !== undefined) return frame
      ensureRightColumn(ctx)
      try {
        frame = await openRightTab(ctx, state.lastUrl || DEFAULT_URL)
      } catch (error) {
        throw new Error('Cannot open the right-Sidebar Browser page: '
          + (error instanceof Error ? error.message : String(error))
          + '. Webviews present: ' + describeFrames())
      }
      await frameReady(frame, 20000)
      ensureRightColumn(ctx)
      state.last = frame
      return frame
    }

    function exec(target, fn, args) {
      const code = '(async () => { try {'
        + ' const value = await (' + fn.toString() + ')(' + JSON.stringify(args === undefined ? {} : args) + ');'
        + ' return value === undefined ? null : value;'
        + ' } catch (error) { return { __dshError: error && error.message ? String(error.message) : String(error) } } })()'
      return target.executeJavaScript(code, true).then((value) => {
        if (value !== null && typeof value === 'object' && typeof value.__dshError === 'string') {
          throw new Error(value.__dshError)
        }
        return value
      })
    }

    function currentUrl(target) {
      return String(safe(() => target.getURL()) || '')
    }

    function siteOf(state, target, hint) {
      return siteProfile(hint, currentUrl(target) || (state.mode === 'bottom' ? 'unknown' : ''))
    }

    async function statusText(state, ctx) {
      const lines = []
      lines.push(`plugin: dsh-browser ${VERSION} (split panel: right / bottom / left / top)`)
      const platform = typeof navigator !== 'undefined' && /Electron/i.test(String(navigator.userAgent || '')) ? 'Desktop (webview)' : 'Web (iframe; page access limited)'
      lines.push('platform: ' + platform)
      lines.push('placement: ' + (state.mode === undefined ? 'closed' : String(state.mode) + ' (' + PLACEMENT_LABEL[state.mode] + ')'))
      const tab = activeTabOf(ctx)
      lines.push('right-Sidebar active tab: ' + (tab === undefined || tab === null ? 'none' : String(tab.kind) + ' ' + String(tab.id)))
      lines.push('browser frames via FRAME_SELECTOR: ' + String(browserFrames().length))
      lines.push('webviews: ' + describeFrames())
      if (state.dockSlotError !== undefined) lines.push('bottom slot: FAILED ' + state.dockSlotError)
      const panel = panelRootOf(state)
      lines.push('split panel: ' + (panel === undefined ? 'closed' : 'open (' + String(panel.getAttribute('data-resident')) + ', ' + String(state.panelHeight) + 'px x ' + String(state.panelWidth) + 'px)'))
      lines.push('split sizes: height ' + String(state.panelHeight) + 'px, width ' + String(state.panelWidth) + 'px' + (state.mode === 'bottom' || state.mode === 'top' ? ' (drag the panel edge to resize)' : state.mode === 'left' ? ' (drag the right edge to resize)' : ''))
      if (state.shiftSelector !== undefined) lines.push('layout: ' + String(state.shiftSelector))
      const view = state.panelView
      if (view !== undefined) {
        const partition = String(safe(() => view.getAttribute('partition')) || '')
        lines.push('guest storage: ' + (partition === '' ? 'unknown' : partition) + (partition.indexOf('dsh-sidebar-browser-') === 0 ? ' (in-memory session: DSH restart clears the web AI login)' : ''))
      }
      if (state.panelView !== undefined && state.panelView.isConnected) lines.push('panel url: ' + currentUrl(state.panelView))
      else if (browserFrames().length > 0) lines.push('right-tab url: ' + currentUrl(browserFrames()[0]))
      lines.push('bottom slot: ' + (state.dockSlotError !== undefined ? 'FAILED ' + state.dockSlotError : state.dockSlot === undefined ? 'not registered' : 'registered via ' + state.dockSlot))
      lines.push('approval: ' + (state.sessionApproved ? 'auto-approved for this session' : 'asks before every send'))
      return lines.join('\n')
    }

    function confirmInPanel(state, prompt) {
      return new Promise((resolve) => {
        const overlay = document.createElement('div')
        overlay.setAttribute('data-dsh-browser-confirm', '')
        Object.assign(overlay.style, {
          position: 'fixed',
          inset: '0',
          zIndex: '2147483001',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'rgba(2, 6, 23, .55)',
          backdropFilter: 'blur(3px)',
        })
        const card = document.createElement('div')
        Object.assign(card.style, {
          width: 'min(560px, 92vw)',
          maxHeight: '70vh',
          overflow: 'auto',
          background: 'var(--dsh-surface, #1b1d23)',
          color: 'var(--dsh-text, #e8e8ea)',
          border: '1px solid rgba(148, 163, 184, .35)',
          borderRadius: '10px',
          padding: '16px 18px',
          boxShadow: '0 24px 60px rgba(0,0,0,.5)',
          font: '13px/1.5 system-ui, -apple-system, Segoe UI, sans-serif',
        })
        const title = document.createElement('div')
        title.textContent = 'DSH 想向网页版 AI 发送一条消息'
        title.style.fontWeight = '700'
        title.style.fontSize = '14px'
        title.style.marginBottom = '8px'
        const hint = document.createElement('div')
        hint.textContent = '请确认下方内容是否允许发送到当前网页。网页返回的内容会被当作不可信数据读取，不会被执行。'
        hint.style.opacity = '.75'
        hint.style.marginBottom = '10px'
        const body = document.createElement('pre')
        body.textContent = String(prompt).slice(0, 4000)
        Object.assign(body.style, {
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          background: 'rgba(148, 163, 184, .12)',
          border: '1px solid rgba(148, 163, 184, .2)',
          borderRadius: '6px',
          padding: '10px',
          margin: '0 0 14px 0',
          maxHeight: '32vh',
          overflow: 'auto',
          font: '12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace',
        })
        const actions = document.createElement('div')
        Object.assign(actions.style, { display: 'flex', gap: '8px', justifyContent: 'flex-end' })
        const make = (label, decision, primary) => {
          const button = document.createElement('button')
          button.textContent = label
          Object.assign(button.style, {
            padding: '5px 12px',
            borderRadius: '6px',
            cursor: 'pointer',
            font: 'inherit',
            color: primary ? '#0b1220' : 'inherit',
            background: primary ? '#7dd3fc' : 'transparent',
            border: '1px solid ' + (primary ? '#7dd3fc' : 'rgba(148, 163, 184, .4)'),
          })
          button.addEventListener('click', () => {
            overlay.remove()
            if (decision === 'session') state.sessionApproved = true
            resolve({ decision, prompt: String(prompt).slice(0, 200) })
          })
          return button
        }
        actions.append(make('拒绝', 'deny', false), make('允许本次', 'once', false), make('本会话都允许', 'session', true))
        card.append(title, hint, body, actions)
        overlay.append(card)
        document.body.appendChild(overlay)
      })
    }

    async function ensureRightPage(state, ctx, url) {
      let frame = pickFrame(state, ctx)
      if (frame === undefined || (url !== undefined && currentUrl(frame) !== url && frame.isConnected !== true)) {
        frame = await openRightTab(ctx, url === undefined ? DEFAULT_URL : url)
      }
      await frameReady(frame, 20000)
      ensureRightColumn(ctx)
      state.last = frame
      return frame
    }

    async function askFlow(state, ctx, args) {
      const url = args.url === undefined
        ? String(state.lastUrl || state.lastPanelUrl || DEFAULT_URL)
        : String(args.url)
      let target
      let opened = false
      if (state.mode !== 'right' || state.panelView !== undefined) {
        if (state.mode === 'right' || state.mode === undefined) state.mode = 'bottom'
        target = await openPanelPage(state, ctx, url, args)
        collapseRightColumn(ctx)
        opened = true
      } else {
        target = pickFrame(state, ctx)
        if (target === undefined) {
          target = await openRightTab(ctx, url)
          opened = true
        }
        await frameReady(target, 20000)
        ensureRightColumn(ctx)
        state.last = target
      }
      const href = currentUrl(target)
      if (!/^https?:/i.test(href)) {
        throw new Error('The panel is not showing a web page yet (' + JSON.stringify(href) + '). Sign in to the web AI in the panel first.')
      }
      const prompt = String(args.prompt)
      if (state.sessionApproved !== true && args.auto !== true) {
        const answer = await confirmInPanel(state, prompt)
        if (answer.decision === 'deny') {
          const error = new Error('用户拒绝了这条消息的发送请求。')
          error.audit = { decision: 'deny', preview: answer.prompt, at: Date.now() }
          throw error
        }
        state.lastDecision = answer.decision
      }
      const profile = siteOf(state, target, args.site)
      const before = await exec(target, pageLastReply, { profile: JSON.stringify(profile), maxChars: 4000 })
      const baseline = before?.text || ''
      await exec(target, pageComposerSubmit, { profile: JSON.stringify(profile), text: prompt })
      const deadline = Date.now() + (Number(args.timeout_ms) > 0 ? Number(args.timeout_ms) : 180000)
      let latest = baseline
      let stable = 0
      while (Date.now() < deadline) {
        await sleep(1200)
        const snapshot = await exec(target, pageLastReply, { profile: JSON.stringify(profile), maxChars: 20000 })
        const text = snapshot?.text || ''
        if (text !== baseline && text.length > 0) {
          if (text === latest) stable += 1
          else {
            stable = 0
            latest = text
          }
          if (stable >= 2 && snapshot?.stop !== true) break
        }
      }
      if (latest === baseline) {
        throw new Error('已发送问题，但在超时前没有检测到新的回复。请确认网页已登录、页面未停在验证码/新会话页，然后在面板中查看。')
      }
      const images = await collectImages(state, target, profile)
      return {
        text: latest,
        images,
        audit: { decision: args.auto === true ? 'auto' : (state.lastDecision || 'once'), preview: prompt.slice(0, 200), at: Date.now(), opened },
      }
    }

    async function collectImages(state, target, profile) {
      const found = await exec(target, pageImages, { profile: JSON.stringify(profile), limit: 6 })
      const images = []
      for (const item of Array.isArray(found) ? found : []) {
        try {
          const bytes = await exec(target, pageImageBytes, { src: item.src })
          if (bytes !== null && bytes !== undefined && typeof bytes.base64 === 'string') {
            images.push({
              base64: bytes.base64,
              mediaType: bytes.mediaType,
              name: 'webai-image-' + String(images.length + 1) + '.png',
            })
          }
        } catch {
          // A single unreadable image must not fail the whole call.
        }
      }
      return images
    }

    async function executeCommand(state, ctx, command) {
      const args = command.args === undefined || command.args === null ? {} : command.args
      const scriptArg = args.script === undefined ? '({})' : String(args.script)
      switch (command.action) {
        case 'status':
          return { text: await statusText(state, ctx) }
        case 'open': {
          const url = String(args.url || DEFAULT_URL)
          const mode = args.mode === undefined ? (state.mode === undefined ? 'right' : state.mode) : args.mode
          if (mode === 'right') {
            await disposePanel(state)
            state.mode = 'right'
            const frame = await openRightTab(ctx, url)
            await frameReady(frame, 20000)
            ensureRightColumn(ctx)
            state.last = frame
            state.lastUrl = url
            return { text: '\u5df2\u6253\u5f00 ' + url + '\uff08\u53f3\u4fa7\u5206\u680f\uff1aDSH \u5728\u5de6\uff0c\u7f51\u9875\u5728\u53f3\uff1b\u5de6\u4fa7 Sidebar \u672a\u6539\u52a8\uff09\u3002\n' + await statusText(state, ctx) }
          }
          state.mode = mode
          await openPanelPage(state, ctx, url, args)
          collapseRightColumn(ctx)
          return { text: '\u5df2\u628a\u7f51\u9875 AI \u653e\u5230' + PLACEMENT_LABEL[mode] + '\u3002\n' + describePlacement() + '\n' + await statusText(state, ctx) }
        }
        case 'layout': {
          const previous = state.lastUrl || state.lastPanelUrl || DEFAULT_URL
          const mode = args.mode === undefined ? (state.mode === 'right' ? 'bottom' : 'right') : args.mode
          const url = String(args.url || previous)
          if (mode === 'right') {
            await disposePanel(state)
            state.mode = 'right'
            const frame = await openRightTab(ctx, url)
            await frameReady(frame, 20000)
            ensureRightColumn(ctx)
            state.last = frame
            state.lastUrl = url
            return { text: '\u5206\u5c4f\u4f4d\u7f6e\uff1a' + PLACEMENT_LABEL[mode] + '\uff08\u7f51\u9875\u5728\u53f3\uff09\u3002\n' + await statusText(state, ctx) }
          }
          state.mode = mode
          await openPanelPage(state, ctx, url, args)
          collapseRightColumn(ctx)
          return { text: '\u5206\u5c4f\u4f4d\u7f6e\uff1a' + PLACEMENT_LABEL[mode] + '\u3002\n' + describePlacement() + '\n' + await statusText(state, ctx) }
        }
        case 'dom': {
          return { text: JSON.stringify(domSnapshot(state), null, 2) }
        }
        case 'ask': {
          const outcome = await askFlow(state, ctx, args)
          return outcome
        }
        case 'thread': {
          const target = await requireFrame(state, ctx)
          if (target === undefined) throw new Error('The web AI panel is not open. Call action "open" or "layout" first.')
          await frameReady(target, 15000)
          const profile = siteOf(state, target, args.site)
          const thread = await exec(target, pageThread, { profile: JSON.stringify(profile), maxChars: args.max_chars || 12000 })
          const lines = (thread?.messages || []).map((message) => `[${message.role}]\n${message.text}`)
          return {
            text: 'url: ' + String(thread?.url || '') + '\ntitle: ' + String(thread?.title || '')
              + '\n\n' + (lines.join('\n\n---\n\n') || '(no messages found)')
              + (thread?.truncated === true ? '\n\n(truncated)' : ''),
          }
        }
        case 'last_reply': {
          const target = await requireFrame(state, ctx)
          if (target === undefined) throw new Error('The web AI panel is not open. Call action "open" or "layout" first.')
          await frameReady(target, 15000)
          const profile = siteOf(state, target, args.site)
          const reply = await exec(target, pageLastReply, { profile: JSON.stringify(profile), maxChars: args.max_chars || 12000 })
          return {
            text: 'url: ' + String(reply?.url || '') + '\nrole: ' + String(reply?.role || '')
              + '\n\n' + (String(reply?.text || '') || '(no reply text found)')
              + (reply?.truncated === true ? '\n\n(truncated)' : ''),
          }
        }
        case 'images': {
          const target = await requireFrame(state, ctx)
          if (target === undefined) throw new Error('The web AI panel is not open. Call action "open" or "layout" first.')
          await frameReady(target, 15000)
          const profile = siteOf(state, target, args.site)
          const images = await collectImages(state, target, profile)
          return {
            text: images.length === 0 ? 'No images found in the newest answer.' : 'Attached ' + images.length + ' image(s) from the newest answer.',
            images,
          }
        }
        case 'screenshot': {
          const target = await requireFrame(state, ctx)
          if (target === undefined) throw new Error('The web AI panel is not open. Call action "open" or "layout" first.')
          await frameReady(target, 15000)
          if (typeof target.capturePage !== 'function') throw new Error('This Harness build does not expose capturePage for the embedded page.')
          const png = await target.capturePage()
          return { text: 'Captured the visible page.', png: { base64: png, mediaType: 'image/png' } }
        }
        case 'eval': {
          const evalUrl = typeof args.url === 'string' && args.url !== '' ? args.url : (state.lastPanelUrl || state.lastUrl || DEFAULT_URL)
          let view = targetOf(state, ctx)
          if (view === undefined) view = await openPanelPage(state, ctx, evalUrl, {})
          await frameReady(view, 20000)
          const result = await view.executeJavaScript(scriptArg, true)
          const shown = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
          const liveUrl = String(safe(() => view.getURL()) || evalUrl)
          return { text: 'evaluated: ' + liveUrl + '\n' + String(shown).slice(0, 20000) }
        }
        case 'close': {
          if (state.panelRoot !== undefined || state.panelView !== undefined) {
            await closePanel(state)
            return { text: '已关闭分屏面板。' }
          }
          const sidebarRight = sidebarRightOf(ctx)
          const tab = activeTabOf(ctx)
          if (sidebarRight !== undefined && sidebarRight !== null && tab !== undefined && tab !== null && tab.kind === 'browser' && typeof sidebarRight.close === 'function') {
            sidebarRight.close(tab.id)
            state.last = undefined
            return { text: 'Closed the Browser tab ' + String(tab.id) + '.' }
          }
          return { text: 'There was no embedded web AI panel to close.' }
        }
        default:
          throw new Error('Unsupported action ' + JSON.stringify(command.action))
      }
    }

    function randomInstanceId() {
      try {
        return 'page-' + crypto.randomUUID()
      } catch {
        return 'page-' + String(Date.now()) + '-' + String(Math.random()).slice(2)
      }
    }

    function applyInner(ctx) {
      reportClient('apply-start', 'apply called')
      const state = {
        ctx,
        last: undefined,
        running: true,
        mode: 'right',
        sessionApproved: false,
        panelRoot: undefined,
        panelView: undefined,
        panelLease: undefined,
        panelHost: undefined,
        panelHeight: (function () {
          const saved = safe(() => JSON.parse(localStorage.getItem(SIZE_KEY) || 'null'))
          return saved !== undefined && saved !== null && Number.isFinite(Number(saved.height)) ? Math.max(160, Math.round(Number(saved.height))) : 420
        })(),
        panelWidth: (function () {
          const saved = safe(() => JSON.parse(localStorage.getItem(SIZE_KEY) || 'null'))
          return saved !== undefined && saved !== null && Number.isFinite(Number(saved.width)) ? Math.max(300, Math.round(Number(saved.width))) : 480
        })(),
        panelResizers: undefined,
        gridParts: undefined,
        gridSaved: undefined,
        beginResize: undefined,
        shiftEl: undefined,
        shiftSelector: undefined,
        lastPanelUrl: undefined,
        lastUrl: undefined,
        dockSlot: undefined,
        dockSlotError: undefined,
      }

      for (const stale of Array.from(document.querySelectorAll('[data-dsh-browser-dock], [data-dsh-browser-panel], [data-dsh-browser-launcher]'))) {
        try {
          stale.remove()
        } catch (error) {
          console.warn('[dsh-browser] could not remove a stale dock node', error)
        }
      }

      state.beginResize = (edge, event) => {
        const mode = state.mode
        const startX = event.clientX
        const startY = event.clientY
        const startHeight = Number(state.panelHeight) || 420
        const startWidth = Number(state.panelWidth) || 480
        const move = (moveEvent) => {
          try {
            if (mode === 'left') {
              const next = Math.max(300, Math.min(window.innerWidth - 320, startWidth + (moveEvent.clientX - startX)))
              state.panelWidth = Math.round(next)
              applyGridSplit(state, 'left', state.panelWidth)
            } else if (mode === 'top') {
              const next = Math.max(160, Math.min(window.innerHeight - 240, startHeight + (moveEvent.clientY - startY)))
              state.panelHeight = Math.round(next)
              applyGridSplit(state, 'top', state.panelHeight)
            } else if (mode === 'bottom') {
              const next = Math.max(160, Math.min(window.innerHeight - 240, startHeight + (startY - moveEvent.clientY)))
              state.panelHeight = Math.round(next)
              applyGridSplit(state, 'bottom', state.panelHeight)
            }
          } catch (error) {
            console.error('[dsh-browser] resize', error)
          }
        }
        const stop = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', stop)
          window.removeEventListener('pointercancel', stop)
          persistSizes(state)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', stop)
        window.addEventListener('pointercancel', stop)
      }

      function BottomDockHost() {
        const ref = React.useRef(null)
        React.useEffect(() => {
          state.dockHost = ref.current
          return () => {
            state.dockHost = undefined
          }
        }, [])
        return React.createElement('div', {
          ref,
          'data-dsh-browser-dock-host': '',
          style: { display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 },
        })
      }

      state.onNavigate = async (value) => {
        try {
          const url = String(value || '').trim() === '' ? DEFAULT_URL : String(value).trim()
          const target = /^https?:\/\//i.test(url) ? url : 'https://' + url.replace(/^\/+/, '')
          await openPanelPage(state, ctx, target)
        } catch (error) {
          console.error('[dsh-browser] panel navigate failed', error)
        }
      }
      state.onPlacement = async (mode) => {
        try {
          const url = state.lastUrl || state.lastPanelUrl || DEFAULT_URL
          if (mode === 'right') {
            await disposePanel(state)
            state.mode = 'right'
            const frame = await openRightTab(ctx, url)
            await frameReady(frame, 20000)
            ensureRightColumn(ctx)
            state.last = frame
            return
          }
          state.mode = mode
          await openPanelPage(state, ctx, url)
          collapseRightColumn(ctx)
        } catch (error) {
          console.error('[dsh-browser] placement failed', error)
        }
      }
      state.onReload = async () => {
        try {
          const view = state.panelView
          if (view !== undefined && typeof view.reload === 'function') view.reload()
        } catch (error) {
          console.error('[dsh-browser] reload failed', error)
        }
      }
      state.onClose = async () => {
        try {
          await closePanel(state)
        } catch (error) {
          console.error('[dsh-browser] close failed', error)
        }
      }

      ctx.effect(() => () => {
        void disposePanel(state)
      }, 'dsh-browser: split panel cleanup')

      async function post(name, payload, signal) {
        const url = new URL('dsh-browser/' + name, document.baseURI)
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload === undefined ? {} : payload),
          credentials: 'same-origin',
          signal,
        })
        if (response.ok !== true) throw new Error('dsh-browser request failed: HTTP ' + String(response.status))
        return await response.json()
      }

      async function loop(signal) {
        const instance = randomInstanceId()
        while (state.running === true && signal.aborted === false) {
          try {
            const outcome = await post('poll', { instance, waitMs: POLL_WAIT_MS }, signal)
            if (signal.aborted || state.running === false) return
            const commands = Array.isArray(outcome && outcome.commands) ? outcome.commands : []
            for (const command of commands) {
              if (signal.aborted || state.running === false) return
              let message
              try {
                const value = await executeCommand(state, ctx, command)
                const audit = value && value.audit !== undefined ? value.audit : undefined
                const payloadValue = value && value.audit !== undefined ? { ...value, audit: undefined } : value
                message = { ok: true, value: JSON.parse(JSON.stringify(payloadValue)) }
                if (audit !== undefined) message.audit = audit
              } catch (error) {
                message = {
                  ok: false,
                  error: { message: error instanceof Error ? error.message : String(error) },
                  ...(error && error.audit !== undefined ? { audit: error.audit } : {}),
                }
              }
              try {
                await post('result', { instance, commandId: command.id, ...message }, signal)
              } catch {
                // The Host may have timed the command out; the next poll recovers.
              }
            }
          } catch {
            if (signal.aborted || state.running === false) return
            await sleep(900)
          }
        }
      }

      function sendHello() {
        try {
          const url = new URL(HELLO_PATH, document.baseURI)
          void fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({
              instance: randomInstanceId(),
              version: VERSION,
              ua: String(navigator.userAgent || ''),
              href: typeof location === 'undefined' ? undefined : String(location.href),
            }),
          }).catch(() => {})
        } catch (error) {
          console.warn('[dsh-browser] hello failed', error)
        }
      }
      console.info('[dsh-browser] client half ' + VERSION + ' applied')
      sendHello()

      // The poller starts before anything optional so status/ask keep working even if the
      // bottom-split slot is refused by this Harness build.
      ctx.effect(() => {
        const controller = new AbortController()
        loop(controller.signal).catch((error) => {
          console.error('[dsh-browser] command poller stopped', error)
        })
        return () => {
          state.running = false
          controller.abort()
        }
      }, 'dsh-browser: command poller')

      ctx.effect(() => {
        const onResize = () => {
          try {
            if (state.mode !== 'left' && state.mode !== 'top' && state.mode !== 'bottom') return
            const size = state.mode === 'left' ? state.panelWidth : state.panelHeight
            const parts = splitTargetOf(state)
            const sbW = splitSbW(state, parts)
            if (parts !== undefined && parts !== null) shiftContentFor(state, state.mode, size)
            positionPanelOver(state, state.mode, size, sbW)
          } catch (error) {
            console.error('[dsh-browser] layout resize', error)
          }
        }
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, 'dsh-browser: layout resize')

      function registerBottomSlot() {
        const slots = ctx.slots
        if (slots === undefined || slots === null) {
          state.dockSlotError = 'ctx.slots is unavailable'
          return undefined
        }
        const variants = [
          ['inject', () => (typeof slots.inject === 'function'
            ? slots.inject('shell.bottom', () => slots.register({ name: 'shell.bottom' }, BottomDockHost))
            : slots.register({ name: 'shell.bottom' }, BottomDockHost))],
          ['plain', () => slots.register({ name: 'shell.bottom' }, BottomDockHost)],
          ['with-id', () => slots.register({ name: 'shell.bottom', id: 'dsh-browser-dock', order: 10 }, BottomDockHost)],
        ]
        const errors = []
        for (const [name, mount] of variants) {
          try {
            const dispose = mount()
            state.dockSlot = name
            state.dockSlotError = undefined
            console.info('[dsh-browser] bottom slot registered via ' + name)
            return typeof dispose === 'function' ? dispose : undefined
          } catch (error) {
            errors.push(name + ': ' + (error instanceof Error ? error.message : String(error)))
          }
        }
        state.dockSlotError = errors.join(' | ')
        console.warn('[dsh-browser] bottom slot registration failed: ' + state.dockSlotError)
        return undefined
      }
      ctx.effect(() => registerBottomSlot(), 'dsh-browser: bottom split slot')

      function Launcher() {
        return React.createElement('button', {
          'data-dsh-browser-launcher': '',
          title: '浏览器分屏：打开 / 关闭网页 AI',
          onClick: (event) => {
            event.preventDefault()
            event.stopPropagation()
            void (async () => {
              try {
                if (panelRootOf(state) !== undefined) await closePanel(state)
                else {
                  state.mode = state.mode === 'right' ? 'bottom' : (state.mode || 'bottom')
                  await openPanelPage(state, ctx, state.lastUrl || state.lastPanelUrl || DEFAULT_URL)
                  collapseRightColumn(ctx)
                }
              } catch (error) {
                console.error('[dsh-browser] launcher failed', error)
              }
            })()
          },
          style: {
            position: 'fixed',
            right: '0px',
            top: '50%',
            transform: 'translateY(-50%)',
            zIndex: '2147483100',
            width: '22px',
            height: '92px',
            padding: '6px 0',
            borderRadius: '8px 0 0 8px',
            border: '1px solid rgba(148,163,184,.45)',
            borderRight: 'none',
            background: 'var(--dsh-surface, #17181c)',
            color: 'var(--dsh-text, #e8e8ea)',
            font: '600 10px/1.1 system-ui, -apple-system, Segoe UI, sans-serif',
            letterSpacing: '.08em',
            writingMode: 'vertical-rl',
            cursor: 'pointer',
            opacity: '0.82',
            boxShadow: '-6px 0 18px rgba(0,0,0,.28)',
          },
        }, '网页 AI')
      }

      function registerLauncher() {
        const slots = ctx.slots
        if (slots === undefined || slots === null) {
          state.launcherError = 'ctx.slots is unavailable'
          return undefined
        }
        try {
          const dispose = typeof slots.inject === 'function'
            ? slots.inject('shell.overlay', () => slots.register({ name: 'shell.overlay', id: 'dsh-browser-launcher', order: 900 }, Launcher))
            : slots.register({ name: 'shell.overlay', id: 'dsh-browser-launcher', order: 900 }, Launcher)
          state.launcherError = undefined
          return typeof dispose === 'function' ? dispose : undefined
        } catch (error) {
          state.launcherError = error instanceof Error ? error.message : String(error)
          console.warn('[dsh-browser] launcher registration failed: ' + state.launcherError)
          return undefined
        }
      }
      ctx.effect(() => registerLauncher(), 'dsh-browser: launcher')
    }

    function apply(ctx) {
      try {
        return applyInner(ctx)
      } catch (error) {
        reportClient('apply-throw', error && error.message ? error.message : String(error), error && error.stack ? error.stack : undefined)
        throw error
      }
    }

    return {
      inject: ['slots'],
      apply,
    }
    }
  },
})
