import { createIpcTransport, type AgentTransport } from '@genoffice/agent-core'
import { t } from '../i18n/locale'

/** The shared IPC transport wired to the sheets preload bridge (window.desktopApi). */
export function createElectronTransport(): AgentTransport {
  return createIpcTransport({
    onStream: (listener) => window.desktopApi.onAiStream(listener),
    start: (request) => void window.desktopApi.aiStream(request),
    cancel: (requestId) => void window.desktopApi.aiStreamCancel(requestId),
    unknownErrorText: () => t('aiUnknownError'),
  })
}
