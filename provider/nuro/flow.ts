/**
 * Yorishiro provider flow: NURO 光 (Sony Network Communications) MyPage
 * cashback receipt automation.
 *
 * Source page: https://www.nuro.jp/app/mypage
 *   - Login → 特典・キャンペーン section
 *   - Pick campaign row by campaignCode (e.g. "B195")
 *   - Fill bank account form (金融機関 / 支店 / 預金種別 / 口座番号 / 口座名義カナ)
 *   - Confirm → 受付完了画面 → screenshot
 *
 * SKELETON — selectors are best-effort guesses and MUST be pinned against the
 * live site in a staging run before production use. NURO MyPage uses Japanese
 * labels and may insert interstitial pages (2FA SMS, terms agreement, session
 * expiry) that this skeleton does not yet handle.
 *
 * Responsibilities:
 *   1. login (userId + password; SMS OTP if prompted)
 *   2. navigate to 特典・キャンペーン
 *   3. enumerate available offers (listOffers path)
 *   4. pick campaign by campaignCode (claim path)
 *   5. fill bank account form
 *   6. confirm + submit
 *   7. capture 受付番号 + 完了画面 screenshot (PDF if available)
 *   8. callback com.etzhayyim.apps.yorishiroNuro.recordClaim via XRPC
 */

import type { Browser, BrowserContext, Page } from "playwright";
import { chromium } from "playwright";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NuroCredentials {
  userId: string;
  password: string;
  /** SMS OTP, provided out-of-band if the login flow triggers 2FA. */
  otp?: string;
}

export interface BankAccount {
  /** 金融機関コード (4 桁). */
  bankCode: string;
  /** 支店コード (3 桁). */
  branchCode: string;
  /** 預金種別: "ordinary" (普通) | "checking" (当座). */
  accountType: "ordinary" | "checking";
  /** 口座番号 (7 桁). */
  accountNumber: string;
  /** 口座名義カナ (全角カナ). */
  accountHolderKana: string;
}

export interface CashbackOffer {
  campaignCode: string;   // "B195"
  title: string;          // "【B195】<特典>「NURO 光 2ギガ(マンション)」20,000円キャッシュバック 11か月後受取"
  amountJpy: number;      // 20000
  windowOpen: string;     // "2026-03-26"
  windowClose: string;    // "2026-05-10"
  claimPath: string;      // 受取手続き href (relative or absolute)
}

export interface ListOffersInput {
  sessionName: string;
  jobId: string;
  credentials: NuroCredentials;
}

export interface ListOffersResult {
  ok: boolean;
  offers?: CashbackOffer[];
  error?: string;
}

export interface ClaimInput {
  sessionName: string;
  jobId: string;
  campaignCode: string;
  bank: BankAccount;
  credentials: NuroCredentials;
  /** Idempotency guard — provider rejects duplicate claim within 45d window. */
  idempotencyKey: string;
}

export interface ClaimResult {
  ok: boolean;
  receiptNumber?: string;
  submittedAt?: string;
  screenshotPath?: string;
  amountJpy?: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Selectors (placeholder — pin against live site)
// ---------------------------------------------------------------------------

const SEL = {
  landing: "https://www.nuro.jp/app/mypage",
  login: {
    userId: 'input[name="loginId"], input[name="userId"]',
    password: 'input[name="password"]',
    submit: 'button[type="submit"], button:has-text("ログイン")',
    otp: 'input[name="otp"], input[name="smsCode"]',
    otpSubmit: 'button:has-text("認証")',
  },
  campaigns: {
    navLink: 'a:has-text("特典・キャンペーン")',
    offerRow: '[data-campaign-code], tr.campaign-row',
    offerCode: '[data-campaign-code]',
    offerTitle: '.campaign-title',
    offerAmount: '.campaign-amount',
    offerOpen: '.campaign-window-open',
    offerClose: '.campaign-window-close',
    offerClaim: 'a:has-text("受取手続き"), button:has-text("受取手続き")',
  },
  bank: {
    bankCode: 'input[name="bankCode"]',
    branchCode: 'input[name="branchCode"]',
    accountTypeOrdinary: 'input[name="accountType"][value="ordinary"], label:has-text("普通")',
    accountTypeChecking: 'input[name="accountType"][value="checking"], label:has-text("当座")',
    accountNumber: 'input[name="accountNumber"]',
    accountHolderKana: 'input[name="accountHolderKana"]',
  },
  confirm: {
    reviewSubmit: 'button:has-text("確認")',
    finalSubmit: 'button:has-text("この内容で申請する"), button:has-text("申請")',
  },
  receipt: {
    number: '[data-testid="receipt-number"], .receipt-number',
    completedBanner: ':has-text("受付完了")',
  },
} as const;

// ---------------------------------------------------------------------------
// Flow — login
// ---------------------------------------------------------------------------

async function login(page: Page, creds: NuroCredentials): Promise<void> {
  await page.goto(SEL.landing, { waitUntil: "domcontentloaded" });
  await page.fill(SEL.login.userId, creds.userId);
  await page.fill(SEL.login.password, creds.password);
  await page.click(SEL.login.submit);
  await page.waitForLoadState("networkidle");

  if (await page.$(SEL.login.otp)) {
    if (!creds.otp) throw new Error("NURO MyPage requested SMS OTP but no otp was supplied");
    await page.fill(SEL.login.otp, creds.otp);
    await page.click(SEL.login.otpSubmit);
    await page.waitForLoadState("networkidle");
  }
}

// ---------------------------------------------------------------------------
// Flow — enumerate offers
// ---------------------------------------------------------------------------

async function enumerateOffers(page: Page): Promise<CashbackOffer[]> {
  await page.click(SEL.campaigns.navLink);
  await page.waitForLoadState("networkidle");

  const rows = await page.$$(SEL.campaigns.offerRow);
  const offers: CashbackOffer[] = [];
  for (const row of rows) {
    const code = ((await row.getAttribute("data-campaign-code")) ??
      (await row.$eval(SEL.campaigns.offerCode, (el) => el.textContent ?? "").catch(() => "")))?.trim() ?? "";
    const title = ((await row.$eval(SEL.campaigns.offerTitle, (el) => el.textContent ?? "").catch(() => "")) ?? "").trim();
    const amountText = ((await row.$eval(SEL.campaigns.offerAmount, (el) => el.textContent ?? "").catch(() => "")) ?? "").trim();
    const windowOpen = ((await row.$eval(SEL.campaigns.offerOpen, (el) => el.textContent ?? "").catch(() => "")) ?? "").trim();
    const windowClose = ((await row.$eval(SEL.campaigns.offerClose, (el) => el.textContent ?? "").catch(() => "")) ?? "").trim();
    const claim = await row.$(SEL.campaigns.offerClaim);
    const claimPath = claim ? ((await claim.getAttribute("href")) ?? "") : "";
    if (!code) continue;
    offers.push({
      campaignCode: code,
      title,
      amountJpy: parseInt(amountText.replace(/\D/g, ""), 10) || 0,
      windowOpen: normalizeDate(windowOpen),
      windowClose: normalizeDate(windowClose),
      claimPath,
    });
  }
  return offers;
}

function normalizeDate(s: string): string {
  // NURO pages use YYYY/MM/DD; normalize to ISO YYYY-MM-DD, empty on parse failure.
  const m = s.match(/(\d{4})[./-](\d{1,2})[./-](\d{1,2})/);
  if (!m) return "";
  const [_, y, mo, d] = m;
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Flow — claim
// ---------------------------------------------------------------------------

async function openClaimForm(page: Page, campaignCode: string): Promise<void> {
  await page.click(SEL.campaigns.navLink);
  await page.waitForLoadState("networkidle");
  const row = await page.$(`[data-campaign-code="${campaignCode}"]`);
  if (!row) throw new Error(`NURO: campaign ${campaignCode} not found on MyPage`);
  const claimLink = await row.$(SEL.campaigns.offerClaim);
  if (!claimLink) throw new Error(`NURO: claim link missing for ${campaignCode} (window may be closed)`);
  await claimLink.click();
  await page.waitForLoadState("networkidle");
}

async function fillBank(page: Page, bank: BankAccount): Promise<void> {
  await page.fill(SEL.bank.bankCode, bank.bankCode);
  await page.fill(SEL.bank.branchCode, bank.branchCode);
  if (bank.accountType === "ordinary") {
    await page.click(SEL.bank.accountTypeOrdinary);
  } else {
    await page.click(SEL.bank.accountTypeChecking);
  }
  await page.fill(SEL.bank.accountNumber, bank.accountNumber);
  await page.fill(SEL.bank.accountHolderKana, bank.accountHolderKana);
}

async function confirmAndSubmit(page: Page): Promise<void> {
  await page.click(SEL.confirm.reviewSubmit);
  await page.waitForLoadState("networkidle");
  await page.click(SEL.confirm.finalSubmit);
  await page.waitForLoadState("networkidle");
}

async function captureReceipt(
  page: Page,
  outDir: string,
  jobId: string,
): Promise<{ receiptNumber: string; screenshotPath: string }> {
  const receiptNumber = ((await page.textContent(SEL.receipt.number).catch(() => "")) ?? "").trim();
  const screenshotPath = `${outDir}/${jobId}-${receiptNumber || "noref"}.png`;
  await page.screenshot({ path: screenshotPath, fullPage: true });
  return { receiptNumber, screenshotPath };
}

// ---------------------------------------------------------------------------
// Public entrypoints
// ---------------------------------------------------------------------------

export async function runNuroListOffers(input: ListOffersInput): Promise<ListOffersResult> {
  let browser: Browser | null = null;
  let ctx: BrowserContext | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    ctx = await browser.newContext({ locale: "ja-JP", viewport: { width: 1366, height: 900 } });
    const page = await ctx.newPage();
    await login(page, input.credentials);
    const offers = await enumerateOffers(page);
    return { ok: true, offers };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally {
    await ctx?.close();
    await browser?.close();
  }
}

export async function runNuroClaimCashback(input: ClaimInput): Promise<ClaimResult> {
  let browser: Browser | null = null;
  let ctx: BrowserContext | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    ctx = await browser.newContext({ locale: "ja-JP", viewport: { width: 1366, height: 900 } });
    const page = await ctx.newPage();
    await login(page, input.credentials);
    await openClaimForm(page, input.campaignCode);
    await fillBank(page, input.bank);
    await confirmAndSubmit(page);
    const { receiptNumber, screenshotPath } = await captureReceipt(
      page,
      "/tmp/nuro-receipts",
      input.jobId,
    );
    return {
      ok: true,
      receiptNumber,
      submittedAt: new Date().toISOString(),
      screenshotPath,
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally {
    await ctx?.close();
    await browser?.close();
  }
}
