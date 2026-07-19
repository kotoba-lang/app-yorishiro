/**
 * Yorishiro provider flow: 日本郵便 Webゆうびん 電子内容証明 (e-naiyo)
 *
 * Source page: https://www.post.japanpost.jp/service/enaiyo/pay.html
 * Templates:   https://www.post.japanpost.jp/service/enaiyo/download.html
 *
 * SKELETON — selectors are best-effort guesses and MUST be pinned against the
 * live site in a staging run before production use. The real site uses
 * Japanese labels and may insert interstitial pages (terms agreement, OTP,
 * card 3-D Secure) that this skeleton does not yet handle.
 *
 * Responsibilities:
 *   1. login (kouno: customer_number + password  | creditCard: registration + card)
 *   2. navigate to 差出受付
 *   3. fill 差出人 + 受取人 form
 *   4. upload .docx (single) or .zip (batch: csv + template)
 *   5. preview + confirm + pay
 *   6. capture 受領番号 + 受領 PDF
 *   7. callback com.etzhayyim.apps.yorishiroEnaiyo.recordReceipt via XRPC
 */

import type { Browser, BrowserContext, Page } from "playwright";
import { chromium } from "playwright";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EnaiyoCredentials {
  method: "kouno" | "creditCard";
  customerNumber?: string;
  password?: string;
  cardNumber?: string;
  cardExpMonth?: string;
  cardExpYear?: string;
  cardCvv?: string;
  cardHolderName?: string;
}

export interface Party {
  name: string;
  postalCode: string;
  address: string;
  phone?: string;
}

export interface SingleSubmitInput {
  sessionName: string;
  jobId: string;
  draftId: string;
  sender: Party;
  recipient: Party;
  docxPath: string;
  credentials: EnaiyoCredentials;
}

export interface BatchSubmitInput {
  sessionName: string;
  batchId: string;
  csvPath: string;
  templateDocxPath: string;
  credentials: EnaiyoCredentials;
}

export interface SubmitResult {
  ok: boolean;
  receiptNumber?: string;
  receiptPdfPath?: string;
  pageCount?: number;
  amount?: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Selectors (placeholder — pin against live site)
// ---------------------------------------------------------------------------

const SEL = {
  landing: "https://www.post.japanpost.jp/service/enaiyo/pay.html",
  loginKouno: {
    entry: 'a:has-text("料金後納でご利用のお客さま")',
    customerNumber: 'input[name="customerNumber"]',
    password: 'input[name="password"]',
    submit: 'button:has-text("ログイン")',
  },
  loginCard: {
    entry: 'a:has-text("クレジットカードでご利用のお客さま")',
    cardNumber: 'input[name="cardNumber"]',
    expMonth: 'select[name="expMonth"]',
    expYear: 'select[name="expYear"]',
    cvv: 'input[name="securityCode"]',
    holder: 'input[name="cardHolder"]',
    submit: 'button:has-text("次へ")',
  },
  newSubmission: 'a:has-text("新規差出し")',
  sender: {
    postalCode: 'input[name="senderPostalCode"]',
    address: 'input[name="senderAddress"]',
    name: 'input[name="senderName"]',
    phone: 'input[name="senderPhone"]',
  },
  recipient: {
    postalCode: 'input[name="recipientPostalCode"]',
    address: 'input[name="recipientAddress"]',
    name: 'input[name="recipientName"]',
  },
  upload: {
    fileInput: 'input[type="file"][accept*="docx"]',
    batchZipInput: 'input[type="file"][accept*="zip"]',
    uploadButton: 'button:has-text("アップロード")',
  },
  preview: {
    pageCount: '[data-testid="page-count"], .page-count',
    amount: '[data-testid="amount"], .amount',
    confirm: 'button:has-text("確認")',
    submit: 'button:has-text("差出し")',
  },
  receipt: {
    number: '[data-testid="receipt-number"], .receipt-number',
    pdfDownload: 'a:has-text("受領票PDF")',
  },
} as const;

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

async function login(page: Page, creds: EnaiyoCredentials): Promise<void> {
  await page.goto(SEL.landing, { waitUntil: "domcontentloaded" });
  if (creds.method === "kouno") {
    if (!creds.customerNumber || !creds.password) {
      throw new Error("kouno requires customerNumber + password");
    }
    await page.click(SEL.loginKouno.entry);
    await page.fill(SEL.loginKouno.customerNumber, creds.customerNumber);
    await page.fill(SEL.loginKouno.password, creds.password);
    await page.click(SEL.loginKouno.submit);
  } else {
    if (!creds.cardNumber || !creds.cardExpMonth || !creds.cardExpYear || !creds.cardCvv) {
      throw new Error("creditCard requires cardNumber, expMonth, expYear, cvv");
    }
    await page.click(SEL.loginCard.entry);
    await page.fill(SEL.loginCard.cardNumber, creds.cardNumber);
    await page.selectOption(SEL.loginCard.expMonth, creds.cardExpMonth);
    await page.selectOption(SEL.loginCard.expYear, creds.cardExpYear);
    await page.fill(SEL.loginCard.cvv, creds.cardCvv);
    if (creds.cardHolderName) await page.fill(SEL.loginCard.holder, creds.cardHolderName);
    await page.click(SEL.loginCard.submit);
  }
  await page.waitForLoadState("networkidle");
}

async function fillParties(page: Page, sender: Party, recipient: Party): Promise<void> {
  await page.click(SEL.newSubmission);
  await page.fill(SEL.sender.postalCode, sender.postalCode.replace("-", ""));
  await page.fill(SEL.sender.address, sender.address);
  await page.fill(SEL.sender.name, sender.name);
  if (sender.phone) await page.fill(SEL.sender.phone, sender.phone);
  await page.fill(SEL.recipient.postalCode, recipient.postalCode.replace("-", ""));
  await page.fill(SEL.recipient.address, recipient.address);
  await page.fill(SEL.recipient.name, recipient.name);
}

async function uploadDocx(page: Page, docxPath: string): Promise<void> {
  const input = await page.waitForSelector(SEL.upload.fileInput);
  await input.setInputFiles(docxPath);
  await page.click(SEL.upload.uploadButton);
  await page.waitForLoadState("networkidle");
}

async function uploadBatchZip(page: Page, zipPath: string): Promise<void> {
  const input = await page.waitForSelector(SEL.upload.batchZipInput);
  await input.setInputFiles(zipPath);
  await page.click(SEL.upload.uploadButton);
  await page.waitForLoadState("networkidle");
}

async function confirmAndSubmit(page: Page): Promise<{ pageCount: number; amount: number }> {
  const pageCountText = (await page.textContent(SEL.preview.pageCount)) ?? "0";
  const amountText = (await page.textContent(SEL.preview.amount)) ?? "0";
  const pageCount = parseInt(pageCountText.replace(/\D/g, ""), 10) || 0;
  const amount = parseInt(amountText.replace(/\D/g, ""), 10) || 0;

  await page.click(SEL.preview.confirm);
  await page.click(SEL.preview.submit);
  await page.waitForLoadState("networkidle");
  return { pageCount, amount };
}

async function captureReceipt(
  page: Page,
  receiptDir: string,
  jobId: string,
): Promise<{ receiptNumber: string; receiptPdfPath: string }> {
  const receiptNumber = (await page.textContent(SEL.receipt.number))?.trim() ?? "";
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.click(SEL.receipt.pdfDownload),
  ]);
  const receiptPdfPath = `${receiptDir}/${jobId}-${receiptNumber || "noref"}.pdf`;
  await download.saveAs(receiptPdfPath);
  return { receiptNumber, receiptPdfPath };
}

// ---------------------------------------------------------------------------
// Public entrypoints
// ---------------------------------------------------------------------------

export async function runJapanpostEnaiyoSingle(input: SingleSubmitInput): Promise<SubmitResult> {
  let browser: Browser | null = null;
  let ctx: BrowserContext | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    ctx = await browser.newContext({ locale: "ja-JP", viewport: { width: 1366, height: 900 } });
    const page = await ctx.newPage();
    await login(page, input.credentials);
    await fillParties(page, input.sender, input.recipient);
    await uploadDocx(page, input.docxPath);
    const { pageCount, amount } = await confirmAndSubmit(page);
    const { receiptNumber, receiptPdfPath } = await captureReceipt(
      page,
      "/tmp/enaiyo-receipts",
      input.jobId,
    );
    return { ok: true, receiptNumber, receiptPdfPath, pageCount, amount };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally {
    await ctx?.close();
    await browser?.close();
  }
}

export async function runJapanpostEnaiyoBatch(input: BatchSubmitInput): Promise<SubmitResult> {
  let browser: Browser | null = null;
  let ctx: BrowserContext | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    ctx = await browser.newContext({ locale: "ja-JP", viewport: { width: 1366, height: 900 } });
    const page = await ctx.newPage();
    await login(page, input.credentials);
    await page.click('a:has-text("差込差出し")');
    await uploadBatchZip(page, input.csvPath);
    const { pageCount, amount } = await confirmAndSubmit(page);
    const { receiptNumber, receiptPdfPath } = await captureReceipt(
      page,
      "/tmp/enaiyo-receipts",
      input.batchId,
    );
    return { ok: true, receiptNumber, receiptPdfPath, pageCount, amount };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally {
    await ctx?.close();
    await browser?.close();
  }
}
