/** Lightweight message helper — wraps Element Plus Message with on-demand import. */
import { ElMessage } from 'element-plus/es/components/message/index.mjs'
import 'element-plus/es/components/message/style/css'

export function toastSuccess(message: string) {
  ElMessage.success(message)
}

export function toastError(message: string) {
  ElMessage.error(message)
}

export function toastWarning(message: string) {
  ElMessage.warning(message)
}
