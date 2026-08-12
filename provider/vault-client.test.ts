/**
 * Tests for the shared Vault client and for the two runners that use it.
 *
 * All values here are obviously synthetic: hostnames use the reserved
 * `.invalid` TLD (RFC 2606) so they can never resolve, and tokens are the
 * literal string "synthetic-not-a-real-token".
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveVaultConfig, vaultGet, VaultConfigError, type VaultEnv } from "./vault-client.js";

const TOKEN = "synthetic-not-a-real-token";
const HTTPS_URL = "https://vault.example.invalid:8200";

/** A fully and correctly configured environment — the positive control. */
const CONFIGURED: VaultEnv = { VAULT_URL: HTTPS_URL, VAULT_TOKEN: TOKEN };

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Positive controls: a properly configured client must still work end to end.
// ---------------------------------------------------------------------------

describe("positive control — an explicitly configured Vault still works", () => {
  it("resolves an https URL + token unchanged", () => {
    const cfg = resolveVaultConfig(CONFIGURED);
    expect(cfg.baseUrl).toBe(HTTPS_URL);
    expect(cfg.token).toBe(TOKEN);
  });

  it("issues the request to the configured URL with the token header and returns the secret", async () => {
    const calls: Array<{ url: string; token: unknown }> = [];
    vi.stubGlobal("fetch", async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, token: init.headers["X-Vault-Token"] });
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { data: { userId: "synthetic-user", password: "synthetic-pass" } } }),
      };
    });

    const data = await vaultGet("secret/data/orgs/o1/users/u1/services/nuro/login", CONFIGURED);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${HTTPS_URL}/v1/secret/data/orgs/o1/users/u1/services/nuro/login`);
    expect(calls[0].token).toBe(TOKEN);
    expect(data).toEqual({ userId: "synthetic-user", password: "synthetic-pass" });
  });

  it("accepts a loopback dev Vault over http", () => {
    for (const url of ["http://localhost:8200", "http://127.0.0.1:8200", "http://[::1]:8200"]) {
      expect(resolveVaultConfig({ VAULT_URL: url, VAULT_TOKEN: TOKEN }).baseUrl).toBe(url);
    }
  });

  it("preserves a base path on the configured URL", () => {
    expect(
      resolveVaultConfig({ VAULT_URL: "https://gw.example.invalid/vault", VAULT_TOKEN: TOKEN }).baseUrl,
    ).toBe("https://gw.example.invalid/vault");
  });
});

// ---------------------------------------------------------------------------
// The defect: unconfigured deployments must refuse, not fall back.
// ---------------------------------------------------------------------------

describe("VAULT_URL is required — there is no default endpoint", () => {
  it("throws when unset", () => {
    expect(() => resolveVaultConfig({ VAULT_TOKEN: TOKEN })).toThrow(VaultConfigError);
    expect(() => resolveVaultConfig({ VAULT_TOKEN: TOKEN })).toThrow(/VAULT_URL is not set/);
  });

  it("throws when blank", () => {
    expect(() => resolveVaultConfig({ VAULT_URL: "", VAULT_TOKEN: TOKEN })).toThrow(/VAULT_URL/);
  });

  it("throws when whitespace only", () => {
    expect(() => resolveVaultConfig({ VAULT_URL: "   \t\n ", VAULT_TOKEN: TOKEN })).toThrow(/blank/);
  });

  it("throws when not an absolute URL", () => {
    expect(() => resolveVaultConfig({ VAULT_URL: "vault", VAULT_TOKEN: TOKEN })).toThrow(
      /not a valid absolute URL/,
    );
  });

  it("throws on a non-http(s) scheme", () => {
    expect(() => resolveVaultConfig({ VAULT_URL: "ftp://vault.example.invalid", VAULT_TOKEN: TOKEN })).toThrow(
      /must use https/,
    );
  });

  it("trims surrounding whitespace on an otherwise valid URL", () => {
    expect(resolveVaultConfig({ VAULT_URL: `  ${HTTPS_URL}  `, VAULT_TOKEN: TOKEN }).baseUrl).toBe(HTTPS_URL);
  });

  it("normalises trailing slashes so the request path has no double slash", () => {
    expect(resolveVaultConfig({ VAULT_URL: `${HTTPS_URL}/`, VAULT_TOKEN: TOKEN }).baseUrl).toBe(HTTPS_URL);
    expect(resolveVaultConfig({ VAULT_URL: `${HTTPS_URL}///`, VAULT_TOKEN: TOKEN }).baseUrl).toBe(HTTPS_URL);
  });
});

describe("cleartext to a non-loopback host is refused", () => {
  it("refuses the removed default endpoint", () => {
    // The exact value the code used to fall back to.
    expect(() => resolveVaultConfig({ VAULT_URL: "http://vault:8200", VAULT_TOKEN: TOKEN })).toThrow(
      VaultConfigError,
    );
    expect(() => resolveVaultConfig({ VAULT_URL: "http://vault:8200", VAULT_TOKEN: TOKEN })).toThrow(
      /cleartext/,
    );
  });

  it("refuses any other non-loopback http host, single-label or not", () => {
    for (const url of ["http://vault", "http://vault.example.invalid:8200", "http://10.0.0.5:8200"]) {
      expect(() => resolveVaultConfig({ VAULT_URL: url, VAULT_TOKEN: TOKEN })).toThrow(/non-loopback/);
    }
  });

  it("does not leak userinfo from the configured URL into the error message", () => {
    try {
      resolveVaultConfig({ VAULT_URL: "http://user:hunter2@vault.example.invalid", VAULT_TOKEN: TOKEN });
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as Error).message).not.toContain("hunter2");
    }
  });
});

describe("VAULT_TOKEN is required — an empty header is never sent", () => {
  it("throws when unset", () => {
    expect(() => resolveVaultConfig({ VAULT_URL: HTTPS_URL })).toThrow(/VAULT_TOKEN is not set/);
  });

  it("throws when blank", () => {
    expect(() => resolveVaultConfig({ VAULT_URL: HTTPS_URL, VAULT_TOKEN: "" })).toThrow(/VAULT_TOKEN/);
  });

  it("throws when whitespace only", () => {
    expect(() => resolveVaultConfig({ VAULT_URL: HTTPS_URL, VAULT_TOKEN: "  \t " })).toThrow(/blank/);
  });

  it("trims surrounding whitespace on an otherwise valid token", () => {
    expect(resolveVaultConfig({ VAULT_URL: HTTPS_URL, VAULT_TOKEN: ` ${TOKEN}\n` }).token).toBe(TOKEN);
  });

  it("throws on embedded control characters", () => {
    expect(() =>
      resolveVaultConfig({ VAULT_URL: HTTPS_URL, VAULT_TOKEN: `${TOKEN}\r\nX-Injected: 1` }),
    ).toThrow(/control characters/);
  });
});

describe("misconfiguration fails closed before any network egress", () => {
  it("does not call fetch at all when the environment is empty", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(vaultGet("secret/data/x", {})).rejects.toThrow(VaultConfigError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not call fetch when only the cleartext default endpoint is configured", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(vaultGet("secret/data/x", { VAULT_URL: "http://vault:8200" })).rejects.toThrow(
      VaultConfigError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Response handling: these fields become credentials and a payout account.
// ---------------------------------------------------------------------------

describe("response handling", () => {
  function stubJson(body: unknown, ok = true, status = 200) {
    vi.stubGlobal("fetch", async () => ({ ok, status, json: async () => body }));
  }

  it("throws on a non-ok status", async () => {
    stubJson({}, false, 403);
    await expect(vaultGet("secret/data/x", CONFIGURED)).rejects.toThrow(/failed: 403/);
  });

  it("rejects a response that is not KV v2 shaped instead of yielding undefined", async () => {
    for (const body of [{}, { data: {} }, { data: { data: null } }, { data: { data: [] } }, null, "nope"]) {
      stubJson(body);
      await expect(vaultGet("secret/data/x", CONFIGURED)).rejects.toThrow(/unexpected response shape/);
    }
  });

  it("rejects non-string secret fields", async () => {
    stubJson({ data: { data: { accountNumber: { toString: "not-a-string" } } } });
    await expect(vaultGet("secret/data/x", CONFIGURED)).rejects.toThrow(/"accountNumber" is not a string/);
  });
});

// ---------------------------------------------------------------------------
// Source guards. These run identically before and after the fix, so they are
// the direct regression test for reintroducing the defaults.
// ---------------------------------------------------------------------------

describe("runner source guards", () => {
  const runners = {
    nuro: read("./nuro/runner.ts"),
    "japanpost-enaiyo": read("./japanpost-enaiyo/runner.ts"),
  };

  for (const [name, src] of Object.entries(runners)) {
    it(`${name}: has no defaulted Vault endpoint`, () => {
      expect(src).not.toMatch(/VAULT_URL\s*\?\?/);
      expect(src).not.toContain("vault:8200");
    });

    it(`${name}: has no defaulted empty Vault token`, () => {
      expect(src).not.toMatch(/VAULT_TOKEN\s*\?\?/);
    });

    it(`${name}: builds no Vault request of its own`, () => {
      expect(src).not.toContain("X-Vault-Token");
      expect(src).not.toContain("/v1/");
    });

    it(`${name}: uses the shared, validated client`, () => {
      expect(src).toMatch(/import \{ vaultGet \} from "\.\.\/vault-client\.js"/);
    });
  }
});

describe("deployment checklist documents the required configuration", () => {
  for (const dir of ["nuro", "japanpost-enaiyo"]) {
    it(`${dir}/README.md names VAULT_URL and VAULT_TOKEN`, () => {
      const md = read(`./${dir}/README.md`);
      expect(md).toContain("VAULT_URL");
      expect(md).toContain("VAULT_TOKEN");
    });
  }
});
