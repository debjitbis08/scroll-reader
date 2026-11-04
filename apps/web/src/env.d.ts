/// <reference path="../.astro/types.d.ts" />
/// <reference types="@vite-pwa/astro" />

declare namespace App {
  interface Locals {
    user: import('@supabase/supabase-js').User | null
  }
}

// Virtual modules provided by vite-plugin-pwa (via @vite-pwa/astro). The
// plugin ships these declarations itself, but it is only a transitive
// dependency, so its .d.ts files aren't resolvable from this package.
declare module 'virtual:pwa-info' {
  export interface PwaInfo {
    pwaInDevEnvironment: boolean
    webManifest: { href: string; useCredentials: boolean; linkTag: string }
  }
  export const pwaInfo: PwaInfo | undefined
}

declare module 'virtual:pwa-register' {
  export interface RegisterSWOptions {
    immediate?: boolean
    onNeedReload?: () => void
    onNeedRefresh?: () => void
    onOfflineReady?: () => void
    onRegisteredSW?: (swScriptUrl: string, registration: ServiceWorkerRegistration | undefined) => void
    onRegisterError?: (error: unknown) => void
  }
  export function registerSW(options?: RegisterSWOptions): (reloadPage?: boolean) => Promise<void>
}

// PostHog snippet loaded in the page head
interface Window {
  posthog?: { set_config: (config: Record<string, unknown>) => void } & Record<string, any>
}
