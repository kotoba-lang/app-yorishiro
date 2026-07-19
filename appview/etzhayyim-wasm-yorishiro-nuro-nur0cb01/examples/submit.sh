#!/usr/bin/env bash
# MCP/XRPC cashback claim sequence for yorishiro-nuro.
# Prerequisites:
#   1. `etzhayyim deploy` completed in this component dir (nur0cb01.etzhayyim.com reachable)
#   2. provider-vault has NURO credentials + bank account at:
#        secret/data/orgs/<org>/users/<user>/services/nuro/login
#        secret/data/orgs/<org>/users/<user>/services/nuro/bankAccount/primary
#   3. yorishiro-provider is running with the nuro-* flows

set -euo pipefail
BASE="https://nur0cb01.etzhayyim.com"
TOKEN="${etzhayyim_TOKEN:?set etzhayyim_TOKEN (AT Protocol session JWT)}"

step() { printf '\n===== %s =====\n' "$*"; }

step "1. listOffers (browser enumerate of 特典・キャンペーン)"
LIST=$(curl -sS -X POST "$BASE/xrpc/com.etzhayyim.apps.yorishiroNuro.listOffers" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data '{}')
echo "$LIST"
LIST_JOB=$(echo "$LIST" | jq -r .jobId)

step "2. poll getOffers until B195 appears"
for i in 1 2 3 4 5 6; do
  sleep 15
  OFFERS=$(curl -sS -X POST "$BASE/xrpc/com.etzhayyim.apps.yorishiroNuro.getOffers" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    --data "{\"campaignCode\":\"B195\"}")
  echo "$OFFERS"
  COUNT=$(echo "$OFFERS" | jq -r .total)
  if [ "$COUNT" -ge 1 ]; then break; fi
done

step "3. claimCashback (BILLABLE + FINANCIAL — confirm=true + approval required)"
echo "Review B195 details + bankVaultKey=primary, then press ENTER to continue or Ctrl+C to abort"
read -r
curl -sS -X POST "$BASE/xrpc/com.etzhayyim.apps.yorishiroNuro.claimCashback" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data @claim-b195.json

step "4. getClaimStatus (poll until receiptNumber appears)"
for i in 1 2 3 4 5 6; do
  sleep 30
  curl -sS -X POST "$BASE/xrpc/com.etzhayyim.apps.yorishiroNuro.getClaimStatus" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    --data '{"campaignCode":"B195"}'
done
