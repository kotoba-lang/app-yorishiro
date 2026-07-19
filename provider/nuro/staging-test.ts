/**
 * Staging test: pin selectors against the live NURO MyPage flow.
 *
 * Run manually BEFORE wiring to the provider invoke loop:
 *   VAULT_URL=... VAULT_TOKEN=... npx tsx staging-test.ts
 *
 * The first run should be --headed with slowMo so you can eyeball every step
 * and update SEL.* in flow.ts against the actual DOM. DO NOT complete the
 * final "申請" click until you have confirmed bank account + campaignCode
 * with the account holder AND have explicit authorization.
 */

import { chromium } from "playwright";

async function main() {
  const browser = await chromium.launch({ headless: false, slowMo: 300 });
  const ctx = await browser.newContext({ locale: "ja-JP", viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();

  console.log("→ loading MyPage");
  await page.goto("https://www.nuro.jp/app/mypage");
  await page.waitForLoadState("networkidle");
  console.log("landing title:", await page.title());

  // Print candidate login inputs so we can update selectors in flow.ts
  const inputs = await page.$$eval("input", (els) =>
    els.map((el) => ({
      name: (el as HTMLInputElement).name,
      type: (el as HTMLInputElement).type,
      id: el.id,
      placeholder: (el as HTMLInputElement).placeholder,
    })),
  );
  console.log("login inputs:", inputs);

  const links = await page.$$eval("a", (as) =>
    as.map((a) => ({ text: (a.textContent ?? "").trim(), href: (a as HTMLAnchorElement).href })),
  );
  const candidates = links.filter(
    (l) => l.text.includes("特典") || l.text.includes("キャンペーン") || l.text.includes("ログイン"),
  );
  console.log("navigation candidates:", candidates);

  await page.pause(); // hand off to interactive Inspector
  await ctx.close();
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
