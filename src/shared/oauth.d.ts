/** The 1.x OAuth helper, shipped as plain ESM in lib/oauth.js. */
declare module '*/oauth.js' {
  export function discover(serverUrl: string, options?: Record<string, unknown>): Promise<Record<string, unknown>>
  export function register(meta: Record<string, unknown>, options?: Record<string, unknown>): Promise<Record<string, unknown>>
  export function authorizeUrl(input: Record<string, unknown>): string
  export function exchangeCode(input: Record<string, unknown>): Promise<Record<string, unknown>>
  export function createPkce(): { verifier: string; challenge: string }
}
