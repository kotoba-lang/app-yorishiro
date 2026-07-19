# yorishiro-nuro provider

Playwright browser-automation flow for NURO 光 (Sony Network Communications) MyPage
cashback receipt procedures. First driving use case: B195 20,000 円キャッシュバック
(NURO 光 2ギガ マンションタイプL, 11 か月後受取, 45 日 window).

**Status**: skeleton. Selectors in `flow.ts` are placeholders. Run
`staging-test.ts` against the live MyPage first, update `SEL.*` constants, and
perform a dry run (stop before the final "申請" click) before enabling the
production invoke handler.

## Files

| File | Purpose |
|---|---|
| `flow.ts` | Playwright flow (login → 特典・キャンペーン → form fill → confirm → receipt) |
| `runner.ts` | Invoke handler: loads creds + bank account from provider-vault, dispatches to flow, calls back via XRPC `recordOffers` / `recordClaim` |
| `staging-test.ts` | Interactive selector pinning script (headed + Playwright Inspector) |

## Credential layout (provider-vault)

### Login (`nuro/login`)

Path:

```
secret/data/orgs/{orgId}/users/{userId}/services/nuro/login
```

| Key | Required | Notes |
|---|---|---|
| `userId` | always | NURO MyPage ログイン ID |
| `password` | always | — |
| `otp` | optional | SMS OTP if 2FA is enforced (usually supplied per-session, not persisted) |

### Bank account (`nuro/bankAccount/<key>`)

Path (one entry per nickname, e.g. `primary`):

```
secret/data/orgs/{orgId}/users/{userId}/services/nuro/bankAccount/primary
```

| Key | Required | Notes |
|---|---|---|
| `bankCode` | always | 4 桁 金融機関コード |
| `branchCode` | always | 3 桁 支店コード |
| `accountType` | always | `ordinary` (普通) / `checking` (当座) |
| `accountNumber` | always | 7 桁 口座番号 |
| `accountHolderKana` | always | 全角カナ (口座名義) |

Register via HashiCorp Vault CLI:

```bash
vault kv put secret/orgs/etzhayyim/users/junkawasaki/services/nuro/login \
  userId=jun@etzhayyim.com \
  password=********

vault kv put secret/orgs/etzhayyim/users/junkawasaki/services/nuro/bankAccount/primary \
  bankCode=0001 \
  branchCode=001 \
  accountType=ordinary \
  accountNumber=1234567 \
  accountHolderKana="カワサキ ジユン"
```

Or via the `provider-vault` XRPC adapter (preferred — scoped by DID session):

```bash
curl -X POST https://yorishiro.etzhayyim.com/xrpc/etzhayyim.providerVault.credentials.put \
  -H "Authorization: Bearer $etzhayyim_TOKEN" \
  -d '{
    "service": "nuro",
    "key": "login",
    "scope": "personal",
    "value": {"userId":"...","password":"..."}
  }'

curl -X POST https://yorishiro.etzhayyim.com/xrpc/etzhayyim.providerVault.credentials.put \
  -H "Authorization: Bearer $etzhayyim_TOKEN" \
  -d '{
    "service": "nuro",
    "key": "bankAccount/primary",
    "scope": "personal",
    "value": {
      "bankCode":"0001","branchCode":"001","accountType":"ordinary",
      "accountNumber":"1234567","accountHolderKana":"カワサキ ジユン"
    }
  }'
```

## Disallowed banks

NURO's cashback form rejects 外国銀行 / 信託銀行 / 第二地方銀行 の一部. The
runner performs a conservative pre-check before driving the browser:

- bankCode `04xx` (zengin foreign-bank range) → reject
- 信託銀行 core codes (`0288`, `0289`, `0300`, `0304`, `0307`, `0310`) → reject

Pin the exact allow-list against MyPage during staging.

## Deployment checklist

1. `pnpm install` in this directory
2. `pnpm exec playwright install chromium`
3. Run `staging-test.ts` headed → update `SEL.*` in `flow.ts`
4. Register credentials + bank account via vault (see above)
5. End-to-end dry run: stop before the final "申請" click; verify form values
6. Wire `handleInvoke` into the provider's wRPC invoke dispatcher
7. Add monitoring: failed claims → alert, receipt capture rate < 100% → alert
8. Set up B2 bucket + IAM for screenshot upload (`uploadScreenshotToR2` stub)

## Safety

- **Require `confirm=true`** at the app layer (enforced in `cmdClaimCashback`).
- **Require `RequireApproval(ClassA, 1, medium)`** — 金銭移動を伴うため human
  approval 必須。
- **Never log raw bank account values** — only log `bankCode` + last 2 digits
  of `accountNumber`.
- **Screenshots are PII** — store in B2 with content-addressed keys and
  access-controlled reads.
- **Idempotency**: each `claimCashback` carries an `idempotencyKey`; the app
  layer rejects a second claim for the same `(campaignCode, idempotencyKey)`.
  The 45-day receive window in NURO MyPage also serves as a natural guard.
- **TOS**: NURO 利用規約 may prohibit automation. Confirm with legal before
  enabling production flow. Initial use case is user-directed (the account
  holder operates their own account via their own vault credentials).
