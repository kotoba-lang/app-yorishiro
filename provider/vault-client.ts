/**
 * Shared HashiCorp Vault client for the yorishiro provider runners.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Both runners used to build their Vault client out of defaulted constants:
 *
 *     const VAULT_URL   = process.env.VAULT_URL   ?? "http://vault:8200";
 *     const VAULT_TOKEN = process.env.VAULT_TOKEN ?? "";
 *
 * That fails OPEN, and the failure is silent:
 *
 *   1. `vault` is a single-label host. It resolves through whatever DNS search
 *      domain the machine happens to carry. This project does not own that
 *      name anywhere — there is no compose file, k8s manifest or deploy config
 *      in this repository that defines it.
 *   2. The scheme is `http://`, so there is no TLS server authentication at
 *      all. Whoever answers is trusted. The Vault token crosses the wire in
 *      cleartext.
 *   3. The token defaulted to `""` and was never checked, so a completely
 *      unconfigured deployment still sent `X-Vault-Token: ""` — to a host it
 *      had not authenticated — and nothing in the code said so.
 *   4. Trust flows BOTH ways. Whatever answers supplies the NURO login and the
 *      bank account (`bankCode` / `branchCode` / `accountNumber` /
 *      `accountHolderKana`) that `provider/nuro/flow.ts` types into the NURO
 *      MyPage cashback form and submits. An impostor `vault` does not merely
 *      receive a token: it chooses where the cashback money is paid.
 *
 * WHAT THIS MODULE DOES INSTEAD
 * -----------------------------
 * Both values are required and validated before any network call is made.
 * There is deliberately NO fallback endpoint: this project owns no Vault, and
 * a resolvable default is strictly worse than an unresolvable one, because it
 * fails open into someone else's hands instead of refusing.
 *
 * `http://` is refused unless the host is loopback. The single-label hostname
 * is how the traffic gets misdirected, but cleartext is the actual exposure —
 * a secret-store client that does not authenticate its server has no way to
 * know it is talking to Vault no matter how the name is spelled. Requiring
 * `https://` makes the server prove it owns the name the operator configured,
 * which is also why no separate hostname allowlist is imposed here: there is
 * no owned value to seed one with, and TLS already does the host binding.
 * Loopback is exempted because there the traffic never leaves the machine and
 * a local dev Vault has no certificate to present.
 */

/** Minimal view of the process environment this module reads. */
export type VaultEnv = Readonly<Record<string, string | undefined>>;

/** Thrown when VAULT_URL / VAULT_TOKEN are missing or unsafe. */
export class VaultConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultConfigError";
  }
}

export interface VaultConfig {
  /** Absolute base URL, normalised without a trailing slash. */
  readonly baseUrl: string;
  /** Vault token. Never log this value. */
  readonly token: string;
}

function requiredEnv(env: VaultEnv, name: string): string {
  const raw = env[name];
  if (raw === undefined) {
    throw new VaultConfigError(
      `${name} is not set. The yorishiro providers read credentials from a Vault ` +
        `that must be configured explicitly — there is no default endpoint and no default token.`,
    );
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new VaultConfigError(
      `${name} is set but blank (empty or whitespace only). Set it to a real value, ` +
        `or leave the provider disabled; it will not fall back to a default.`,
    );
  }
  return trimmed;
}

/** RFC 6761 `localhost`, the IPv4 loopback /8, and the IPv6 loopback address. */
function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "[::1]" || host === "::1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Resolve and validate the Vault configuration. Throws `VaultConfigError`
 * rather than returning anything usable, so a misconfigured deployment stops
 * instead of quietly talking to whoever answers.
 */
export function resolveVaultConfig(env: VaultEnv = process.env): VaultConfig {
  const rawUrl = requiredEnv(env, "VAULT_URL");

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new VaultConfigError(
      "VAULT_URL is not a valid absolute URL. Expected something like " +
        "https://vault.<your-domain>:8200 (scheme included).",
    );
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new VaultConfigError(
      `VAULT_URL must use https:// (or http:// for a loopback dev Vault); got scheme "${url.protocol}".`,
    );
  }

  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    // Report scheme + hostname only: the raw value may carry userinfo.
    throw new VaultConfigError(
      `VAULT_URL uses http:// with the non-loopback host "${url.hostname}". ` +
        "The Vault token would cross the network in cleartext and the server would not be " +
        "authenticated, so any host that answers could hand back credentials and a bank account. " +
        "Use https://, or point at loopback (localhost / 127.0.0.0/8 / [::1]) for a local dev Vault.",
    );
  }

  const token = requiredEnv(env, "VAULT_TOKEN");
  if (/[\u0000-\u001f\u007f]/.test(token)) {
    throw new VaultConfigError(
      "VAULT_TOKEN contains control characters and cannot be sent as an HTTP header value.",
    );
  }

  return { baseUrl: url.toString().replace(/\/+$/, ""), token };
}

/**
 * KV v2 responses are `{ data: { data: { <key>: <string> } } }`. Anything else
 * is rejected by name instead of being destructured into `undefined` and
 * carried onward — these fields become login credentials and a payout account.
 */
function extractSecretData(path: string, body: unknown): Record<string, string> {
  const outer = body as { data?: { data?: unknown } } | null | undefined;
  const inner =
    outer !== null && typeof outer === "object" && !Array.isArray(outer)
      ? (outer.data as { data?: unknown } | undefined)?.data
      : undefined;

  if (inner === null || typeof inner !== "object" || Array.isArray(inner)) {
    throw new Error(
      `vault get ${path}: unexpected response shape (expected KV v2 { data: { data: {...} } })`,
    );
  }

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(inner as Record<string, unknown>)) {
    if (typeof value !== "string") {
      throw new Error(`vault get ${path}: field "${key}" is not a string`);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Read one KV v2 secret. Configuration is resolved first, so an unconfigured
 * or cleartext-configured deployment throws before any request is issued.
 */
export async function vaultGet(
  path: string,
  env: VaultEnv = process.env,
): Promise<Record<string, string>> {
  const { baseUrl, token } = resolveVaultConfig(env);
  const r = await fetch(`${baseUrl}/v1/${path}`, {
    headers: { "X-Vault-Token": token },
  });
  if (!r.ok) throw new Error(`vault get ${path} failed: ${r.status}`);
  return extractSecretData(path, await r.json());
}
