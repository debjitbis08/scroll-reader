// import { PostHog } from 'posthog-node'

const POSTHOG_API_KEY = import.meta.env.PUBLIC_POSTHOG_API_KEY as
  | string
  | undefined;

// let client: PostHog | null = null;

export function getPostHog() {
  // if (!POSTHOG_API_KEY) return null
  // if (!client) {
  //   client = new PostHog(POSTHOG_API_KEY, {
  //     host: 'https://us.i.posthog.com',
  //     enableExceptionAutocapture: true,
  //   })
  // }
  // return client
}

/**
 * Capture a server-side exception with optional context.
 * No-ops if PostHog is not configured.
 */
export function captureException(
  err: unknown,
  distinctId?: string,
  properties?: Record<string, unknown>,
): void {
  // const ph = getPostHog()
  // if (!ph) return
  // ph.captureException(err, distinctId ?? 'server', properties)
}
