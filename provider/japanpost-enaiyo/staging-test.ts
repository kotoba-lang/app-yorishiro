/**
 * Staging test: pin selectors against the live JP Post e-naiyo flow.
 *
 * Run manually BEFORE wiring to the provider invoke loop:
 *   VAULT_URL=... VAULT_TOKEN=... npx tsx staging-test.ts
 *
 * The first run should be --headed with slowMo so you can eyeball every step
 * and update SEL.* in flow.ts against the actual DOM. DO NOT complete the
 * final "差出し" click until you have a throwaway test recipient address
 * AND payment instrument AND explicit authorization.
 */

import { chromium } from "playwright";

async function main() {
  const browser = await chromium.launch({ headless: false, slowMo: 300 });
  const ctx = await browser.newContext({ locale: "ja-JP", viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();

  console.log("→ loading landing");
  await page.goto("https://www.post.japanpost.jp/service/enaiyo/pay.html");
  await page.waitForLoadState("networkidle");
  console.log("landing title:", await page.title());

  // Print candidate login entry links so we can update selectors in flow.ts
  const links = await page.$$eval("a", (as) =>
    as.map((a) => ({ text: (a.textContent ?? "").trim(), href: (a as HTMLAnchorElement).href })),
  );
  const candidates = links.filter(
    (l) => l.text.includes("後納") || l.text.includes("クレジット") || l.text.includes("ログイン"),
  );
  console.log("login candidates:", candidates);

  await page.pause(); // hand off to interactive Inspector
  await ctx.close();
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
