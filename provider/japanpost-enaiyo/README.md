# yorishiro-japanpost-enaiyo provider

Playwright browser-automation flow for 日本郵便 Webゆうびん 電子内容証明 (e-naiyo).

**Status**: skeleton. Selectors in `flow.ts` are placeholders. Run
`staging-test.ts` against the live site first, update `SEL.*` constants, and
perform a throwaway end-to-end submission to a test address before enabling
the production invoke handler.

## Files

| File | Purpose |
|---|---|
| `flow.ts` | Playwright flow (login → form fill → docx upload → preview → submit → receipt) |
| `runner.ts` | Invoke handler: loads credentials from provider-vault, dispatches to flow, calls back via XRPC `recordReceipt` |
| `staging-test.ts` | Interactive selector pinning script (headed + Playwright Inspector) |

## Credential layout (provider-vault)

Path:

```
secret/data/orgs/{orgId}/users/{userId}/services/japanpost-enaiyo/primary
```

Keys:

| Key | Required | When | Notes |
|---|---|---|---|
| `method` | always | — | `"kouno"` (料金後納) or `"creditCard"` |
| `customerNumber` | kouno | login | 32 桁お客さま番号 |
| `password` | kouno | login | — |
| `cardNumber` | creditCard | login | AMEX / Diners / JCB / VISA / Master |
| `cardExpMonth` | creditCard | login | `MM` |
| `cardExpYear` | creditCard | login | `YYYY` |
| `cardCvv` | creditCard | login | — |
| `cardHolderName` | creditCard (optional) | login | ローマ字 |

Register via HashiCorp Vault CLI:

```bash
vault kv put secret/orgs/etzhayyim/users/junkawasaki/services/japanpost-enaiyo/primary \
  method=creditCard \
  cardNumber=4111111111111111 \
  cardExpMonth=12 \
  cardExpYear=2028 \
  cardCvv=123 \
  cardHolderName="JUN KAWASAKI"
```

Or via the `provider-vault` XRPC adapter (preferred — scoped by DID session):

```bash
curl -X POST https://yorishiro.etzhayyim.com/xrpc/etzhayyim.providerVault.credentials.put \
  -H "Authorization: Bearer $etzhayyim_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "service": "japanpost-enaiyo",
    "key": "primary",
    "scope": "personal",
    "value": {
      "method": "creditCard",
      "cardNumber": "4111111111111111",
      "cardExpMonth": "12",
      "cardExpYear": "2028",
      "cardCvv": "123",
      "cardHolderName": "JUN KAWASAKI"
    }
  }'
```

Check configured credentials (no value returned):

```bash
curl -X POST https://yorishiro.etzhayyim.com/xrpc/etzhayyim.providerVault.credentials.check \
  -H "Authorization: Bearer $etzhayyim_TOKEN" \
  -d '{"service":"japanpost-enaiyo","key":"primary"}'
```

## Deployment checklist

1. `pnpm install` in this directory
2. `pnpm exec playwright install chromium`
3. Run `staging-test.ts` headed → update `SEL.*` in `flow.ts`
4. Register credentials via vault (see above)
5. End-to-end test with a non-production recipient (e.g. your own address)
6. Wire `handleInvoke` into the provider's wRPC invoke dispatcher
7. Add monitoring: failed submissions → alert, receipt capture rate < 100% → alert
8. Set up B2 bucket + IAM for receipt PDF upload (`uploadPdfToR2` stub)

## Safety

- **Require `confirm=true`** at the app layer (enforced in `cmdSubmitNaiyo`).
- **Never log raw credential values** — only log `method` + last 4 digits of card.
- **Receipt PDFs are PII** — store in B2 with content-addressed keys and
  access-controlled reads.
- **Electronic signature**: e-naiyo requires a submitter-side electronic
  signature certificate. The current skeleton does NOT handle certificate
  selection — this must be added during staging pinning.
- **法務確認 required**: JP Post TOS may prohibit automation. Confirm with
  legal before enabling production flow.
