/**
 * XRPC invoke handler: routes yorishiro-provider invoke events to the
 * NURO MyPage flow. Listens on a simple HTTP endpoint; wire-up to
 * w-protocol invoke stream is left to the provider main loop.
 *
 * Reads credentials + bank account from provider-vault at:
 *   secret/data/orgs/{orgId}/users/{userId}/services/nuro/login
 *   secret/data/orgs/{orgId}/users/{userId}/services/nuro/bankAccount
 *
 * Calls back via XRPC:
 *   POST https://nur0cb01.etzhayyim.com/xrpc/com.etzhayyim.apps.yorishiroNuro.recordOffers
 *   POST https://nur0cb01.etzhayyim.com/xrpc/com.etzhayyim.apps.yorishiroNuro.recordClaim
 */

import {
  runNuroListOffers,
  runNuroClaimCashback,
  type NuroCredentials,
  type BankAccount,
  type CashbackOffer,
} from "./flow.js";

const NURO_APP_BASE = "https://nur0cb01.etzhayyim.com";
const VAULT_URL = process.env.VAULT_URL ?? "http://vault:8200";
const VAULT_TOKEN = process.env.VAULT_TOKEN ?? "";

async function vaultGet(path: string): Promise<Record<string, string>> {
  const r = await fetch(`${VAULT_URL}/v1/${path}`, {
    headers: { "X-Vault-Token": VAULT_TOKEN },
  });
  if (!r.ok) throw new Error(`vault get ${path} failed: ${r.status}`);
  const j = (await r.json()) as { data: { data: Record<string, string> } };
  return j.data.data;
}

async function loadCredentials(orgId: string, userId: string): Promise<NuroCredentials> {
  const path = `secret/data/orgs/${orgId}/users/${userId}/services/nuro/login`;
  const raw = await vaultGet(path);
  if (!raw.userId || !raw.password) {
    throw new Error("nuro: vault entry must contain userId + password");
  }
  return { userId: raw.userId, password: raw.password, otp: raw.otp };
}

async function loadBankAccount(orgId: string, userId: string, vaultKey: string): Promise<BankAccount> {
  // vaultKey allows multiple bank accounts per user (e.g. "primary", "backup").
  const path = `secret/data/orgs/${orgId}/users/${userId}/services/nuro/bankAccount/${vaultKey}`;
  const raw = await vaultGet(path);
  const accountType = raw.accountType === "checking" ? "checking" : "ordinary";
  for (const k of ["bankCode", "branchCode", "accountNumber", "accountHolderKana"] as const) {
    if (!raw[k]) throw new Error(`nuro bankAccount: ${k} is required`);
  }
  return {
    bankCode: raw.bankCode,
    branchCode: raw.branchCode,
    accountType,
    accountNumber: raw.accountNumber,
    accountHolderKana: raw.accountHolderKana,
  };
}

async function recordOffers(params: {
  jobId: string;
  offers: CashbackOffer[];
  sessionToken: string;
}): Promise<void> {
  const r = await fetch(`${NURO_APP_BASE}/xrpc/com.etzhayyim.apps.yorishiroNuro.recordOffers`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.sessionToken}`,
    },
    body: JSON.stringify({ jobId: params.jobId, offers: params.offers }),
  });
  if (!r.ok) throw new Error(`recordOffers failed: ${r.status} ${await r.text()}`);
}

async function recordClaim(params: {
  jobId: string;
  campaignCode: string;
  receiptNumber: string;
  submittedAt: string;
  screenshotBlobKey: string;
  amountJpy?: number;
  sessionToken: string;
}): Promise<void> {
  const r = await fetch(`${NURO_APP_BASE}/xrpc/com.etzhayyim.apps.yorishiroNuro.recordClaim`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.sessionToken}`,
    },
    body: JSON.stringify({
      jobId: params.jobId,
      campaignCode: params.campaignCode,
      receiptNumber: params.receiptNumber,
      submittedAt: params.submittedAt,
      screenshotBlobKey: params.screenshotBlobKey,
      amountJpy: params.amountJpy,
    }),
  });
  if (!r.ok) throw new Error(`recordClaim failed: ${r.status} ${await r.text()}`);
}

export interface InvokeEvent {
  method: "runBrowserSession";
  params: {
    flow: "nuro-list-offers" | "nuro-claim-cashback";
    sessionName: string;
    jobId: string;
    campaignCode?: string;
    bankVaultKey?: string;
    idempotencyKey?: string;
  };
  authority: { orgId: string; userId: string; sessionToken: string };
}

export async function handleInvoke(evt: InvokeEvent): Promise<void> {
  if (evt.method !== "runBrowserSession") {
    throw new Error(`unsupported method ${evt.method}`);
  }
  const creds = await loadCredentials(evt.authority.orgId, evt.authority.userId);

  if (evt.params.flow === "nuro-list-offers") {
    const result = await runNuroListOffers({
      sessionName: evt.params.sessionName,
      jobId: evt.params.jobId,
      credentials: creds,
    });
    if (!result.ok) throw new Error(`listOffers failed: ${result.error}`);
    await recordOffers({
      jobId: evt.params.jobId,
      offers: result.offers ?? [],
      sessionToken: evt.authority.sessionToken,
    });
    return;
  }

  if (evt.params.flow === "nuro-claim-cashback") {
    if (!evt.params.campaignCode) throw new Error("nuro-claim-cashback requires campaignCode");
    if (!evt.params.bankVaultKey) throw new Error("nuro-claim-cashback requires bankVaultKey");
    if (!evt.params.idempotencyKey) throw new Error("nuro-claim-cashback requires idempotencyKey");
    const bank = await loadBankAccount(
      evt.authority.orgId,
      evt.authority.userId,
      evt.params.bankVaultKey,
    );
    assertSupportedBank(bank);
    const result = await runNuroClaimCashback({
      sessionName: evt.params.sessionName,
      jobId: evt.params.jobId,
      campaignCode: evt.params.campaignCode,
      bank,
      credentials: creds,
      idempotencyKey: evt.params.idempotencyKey,
    });
    if (!result.ok) throw new Error(`claim failed: ${result.error}`);
    const blobKey = await uploadScreenshotToR2(result.screenshotPath!);
    await recordClaim({
      jobId: evt.params.jobId,
      campaignCode: evt.params.campaignCode,
      receiptNumber: result.receiptNumber ?? "",
      submittedAt: result.submittedAt ?? new Date().toISOString(),
      screenshotBlobKey: blobKey,
      amountJpy: result.amountJpy,
      sessionToken: evt.authority.sessionToken,
    });
    return;
  }

  throw new Error(`unknown flow ${evt.params.flow}`);
}

/**
 * NURO documents that 外国銀行 / 信託銀行 / 第二地方銀行 の一部 are not
 * supported. We refuse before driving a browser session so the user sees a
 * clear error instead of a MyPage-side validation failure at the last step.
 * The exact allow-list should be pinned against the live MyPage bank picker
 * during staging; until then we only hard-block the three disallowed classes
 * by bankCode range heuristics (conservative — may allow some ineligible
 * codes that MyPage will reject server-side).
 */
function assertSupportedBank(bank: BankAccount): void {
  const code = bank.bankCode;
  if (!/^\d{4}$/.test(code)) throw new Error("nuro: bankCode must be 4 digits");
  // 外国銀行: 0400-0499 (zengin foreign-bank range)
  if (code.startsWith("04")) throw new Error("nuro: 外国銀行は一部指定不可。MyPage の案内を確認してください");
  // 信託銀行 core codes (partial — pin during staging)
  if (["0288", "0289", "0300", "0304", "0307", "0310"].includes(code)) {
    throw new Error("nuro: 信託銀行は一部指定不可。MyPage の案内を確認してください");
  }
}

// ---- stubs (provider framework-dependent) ----

async function uploadScreenshotToR2(_path: string): Promise<string> {
  throw new Error("uploadScreenshotToR2 not implemented — use cdn package SigV4 to etzhayyim-cdn bucket");
}
