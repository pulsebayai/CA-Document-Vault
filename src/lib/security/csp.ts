/**
 * Content-Security-Policy with a per-request nonce (Next.js 16 guidance: docs/01-app/02-guides/content-security-policy.md).
 * Blocks injected/inline scripts, framing, plugins, and connections to anything but this app and our Supabase project.
 */
export function buildCsp(nonce: string, supabaseUrl: string, isDev = process.env.NODE_ENV === "development"): string {
  const supabase = new URL(supabaseUrl).origin;
  return [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'nonce-${nonce}'`,
    `img-src 'self' blob: data:`,
    `font-src 'self'`,
    `connect-src 'self' ${supabase}`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    `upgrade-insecure-requests`,
  ].join("; ");
}

export function newNonce(): string {
  return Buffer.from(crypto.randomUUID()).toString("base64");
}
