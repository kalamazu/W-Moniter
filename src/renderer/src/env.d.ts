/// <reference types="vite/client" />

import type { ControllerApi } from '../../shared/types'

declare global {
  interface Window {
    monitor: ControllerApi
  }
}

export {}
