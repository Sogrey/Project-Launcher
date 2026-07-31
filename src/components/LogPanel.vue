<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

const props = defineProps<{
  projectPath: string
  logs: string[]
  /** Stretch to fill parent (run-mode drawer). */
  fill?: boolean
}>()

const emit = defineEmits<{
  (e: 'clear'): void
}>()

const terminalContainer = ref<HTMLElement | null>(null)
let terminal: Terminal | null = null
let fitAddon: FitAddon | null = null
let writtenCount = 0
let resizeObserver: ResizeObserver | null = null
const autoScroll = ref(true)

/** Prefer readable line length; narrow panels scroll horizontally instead of mid-word wrap. */
const MIN_COLS = 160

function syncHorizontalScroll() {
  const termEl = terminal?.element
  const screen = termEl?.querySelector('.xterm-screen') as HTMLElement | null
  if (!termEl || !screen) return
  // Canvases are position:absolute and do not expand scrollWidth; pin screen min-width.
  const canvas = screen.querySelector('canvas')
  const width = canvas?.offsetWidth || screen.offsetWidth
  if (width > 0) {
    screen.style.minWidth = `${width}px`
  }
}

function fitTerminal() {
  if (!terminal || !fitAddon || !terminal.element) return
  try {
    // Measure against the panel width (not a previously expanded term width).
    terminal.element.style.width = '100%'
    fitAddon.fit()
    const rows = Math.max(terminal.rows || 0, 8)
    if (terminal.cols > 0 && terminal.cols < MIN_COLS) {
      terminal.resize(MIN_COLS, rows)
    }
    terminal.element.style.width = '100%'
    requestAnimationFrame(syncHorizontalScroll)
  } catch (err) {
    console.warn('fitTerminal failed', err)
  }
}

onMounted(() => {
  terminal = new Terminal({
    convertEol: true,
    fontSize: 12,
    fontFamily: 'JetBrains Mono, Cascadia Code, Consolas, monospace',
    lineHeight: 1.25,
    letterSpacing: 0,
    theme: {
      background: '#0a121f',
      foreground: '#c8e0f8',
      cursor: '#38bdf8',
      selectionBackground: 'rgba(56, 189, 248, 0.35)',
    },
    cursorBlink: false,
    scrollback: 5000,
  })

  fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)

  if (terminalContainer.value) {
    terminal.open(terminalContainer.value)
    fitTerminal()

    props.logs.forEach((log) => {
      terminal?.write(log)
    })
    writtenCount = props.logs.length

    resizeObserver = new ResizeObserver(() => {
      fitTerminal()
    })
    resizeObserver.observe(terminalContainer.value)
  }
})

onUnmounted(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
  terminal?.dispose()
  terminal = null
  fitAddon = null
})

watch(
  () => props.logs,
  (newLogs) => {
    if (!terminal) return

    if (newLogs.length < writtenCount) {
      terminal.clear()
      writtenCount = 0
    }

    for (let i = writtenCount; i < newLogs.length; i++) {
      terminal.write(newLogs[i])
    }
    writtenCount = newLogs.length

    if (autoScroll.value) {
      terminal.scrollToBottom()
    }
  }
)

function handleClear() {
  terminal?.clear()
  writtenCount = 0
  emit('clear')
}

function handleFit() {
  nextTick(() => {
    fitTerminal()
  })
}
</script>

<template>
  <div class="log-panel" :class="{ fill: fill }" @click="handleFit">
    <div class="log-header">
      <span class="log-title">日志输出</span>
      <div class="log-controls">
        <label class="auto-scroll-label">
          <input type="checkbox" v-model="autoScroll" />
          自动滚动
        </label>
        <button class="clear-btn" @click.stop="handleClear">
          清空日志
        </button>
      </div>
    </div>
    <div class="log-content" ref="terminalContainer"></div>
  </div>
</template>

<style scoped>
.log-panel {
  background: #0a121f;
  border-radius: 8px;
  border: 1px solid rgba(56, 189, 248, 0.2);
  overflow: hidden;
  min-width: 0;
}

.log-panel.fill {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.log-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  flex-shrink: 0;
}

.log-title {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.6);
}

.log-controls {
  display: flex;
  align-items: center;
  gap: 12px;
}

.auto-scroll-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.6);
  cursor: pointer;
}

.auto-scroll-label input {
  accent-color: #38bdf8;
}

.clear-btn {
  background: rgba(255, 255, 255, 0.1);
  border: none;
  color: rgba(255, 255, 255, 0.7);
  padding: 4px 12px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
  font-family: inherit;
}

.clear-btn:hover {
  background: rgba(255, 255, 255, 0.2);
}

.log-content {
  height: 200px;
  overflow: hidden;
  padding: 4px;
  box-sizing: border-box;
  min-width: 0;
}

.log-panel.fill .log-content {
  height: auto;
  flex: 1;
  min-height: 180px;
}

.log-content :deep(.xterm) {
  height: 100%;
  width: 100% !important;
  max-width: 100%;
  box-sizing: border-box;
  /* Screen is wider than the panel when MIN_COLS > fitted cols */
  overflow-x: scroll !important;
  overflow-y: hidden !important;
}

.log-content :deep(.xterm-viewport) {
  /* Vertical scroll stays on the visible panel edge */
  overflow-y: scroll !important;
  overflow-x: hidden !important;
}

.log-content :deep(.xterm-screen) {
  /* In-flow width from xterm drives horizontal scrollWidth */
  position: relative;
}

.log-content :deep(.xterm-rows) {
  word-break: normal;
}

/* WebView often hides overlay scrollbars; force a visible horizontal bar */
.log-content :deep(.xterm)::-webkit-scrollbar {
  height: 10px;
  width: 10px;
}

.log-content :deep(.xterm)::-webkit-scrollbar-thumb {
  background: rgba(56, 189, 248, 0.45);
  border-radius: 5px;
}

.log-content :deep(.xterm)::-webkit-scrollbar-track {
  background: rgba(255, 255, 255, 0.06);
}

.log-content :deep(.xterm-viewport)::-webkit-scrollbar {
  width: 10px;
}

.log-content :deep(.xterm-viewport)::-webkit-scrollbar-thumb {
  background: rgba(56, 189, 248, 0.35);
  border-radius: 5px;
}
</style>
