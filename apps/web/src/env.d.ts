/// <reference path="../.astro/types.d.ts" />
/// <reference types="@vite-pwa/astro" />

declare namespace App {
  interface Locals {
    user: import('@supabase/supabase-js').User | null
  }
}
