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

onMounted(() => {
  terminal = new Terminal({
    fontSize: 12,
    fontFamily: 'Consolas, monospace',
    theme: {
      background: 'rgba(20, 20, 30, 0.95)',
      foreground: '#e0e0e0',
      cursor: '#e0e0e0',
      selectionBackground: 'rgba(102, 126, 234, 0.4)',
    },
    cursorBlink: false,
    scrollback: 1000,
  })

  fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)

  if (terminalContainer.value) {
    terminal.open(terminalContainer.value)
    fitAddon.fit()

    props.logs.forEach((log) => {
      terminal?.write(log)
    })
    writtenCount = props.logs.length

    resizeObserver = new ResizeObserver(() => {
      fitAddon?.fit()
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
    fitAddon?.fit()
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
  background: rgba(20, 20, 30, 0.95);
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  overflow: hidden;
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
  accent-color: #667eea;
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
}

.clear-btn:hover {
  background: rgba(255, 255, 255, 0.2);
}

.log-content {
  height: 200px;
  overflow: hidden;
  padding: 4px;
}

.log-panel.fill .log-content {
  height: auto;
  flex: 1;
  min-height: 180px;
}

.log-content :deep(.xterm) {
  height: 100%;
}
</style>
