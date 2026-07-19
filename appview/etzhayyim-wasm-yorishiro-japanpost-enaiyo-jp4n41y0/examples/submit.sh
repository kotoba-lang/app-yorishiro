#!/usr/bin/env bash
# MCP/XRPC submission sequence for yorishiro-japanpost-enaiyo.
# Prerequisites:
#   1. `etzhayyim deploy` completed in this component dir (jp4n41y0.etzhayyim.com reachable)
#   2. provider-vault has japanpost-enaiyo credentials at
#      secret/data/orgs/etzhayyim/users/<user>/services/japanpost-enaiyo/primary
#   3. yorishiro-provider is running with the japanpost-enaiyo-single flow

set -euo pipefail
BASE="https://jp4n41y0.etzhayyim.com"
TOKEN="${etzhayyim_TOKEN:?set etzhayyim_TOKEN (AT Protocol session JWT)}"

step() { printf '\n===== %s =====\n' "$*"; }

step "1. createDraft"
DRAFT=$(curl -sS -X POST "$BASE/xrpc/com.etzhayyim.apps.yorishiroEnaiyo.createDraft" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data @draft-matsuoka.json)
echo "$DRAFT"
DRAFT_ID=$(echo "$DRAFT" | jq -r .draftId)

step "2. renderDocx (delegate to yorishiro-provider docx renderer)"
curl -sS -X POST "$BASE/xrpc/com.etzhayyim.apps.yorishiroEnaiyo.renderDocx" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data "{\"draftId\":\"$DRAFT_ID\"}"

step "3. submitNaiyo (BILLABLE + LEGALLY BINDING — confirm=true required)"
echo "Review $DRAFT_ID, then press ENTER to continue or Ctrl+C to abort"
read -r
curl -sS -X POST "$BASE/xrpc/com.etzhayyim.apps.yorishiroEnaiyo.submitNaiyo" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data "{\"draftId\":\"$DRAFT_ID\",\"confirm\":true}"

step "4. getStatus (poll until receiptNumber appears)"
for i in 1 2 3 4 5 6; do
  sleep 30
  curl -sS -X POST "$BASE/xrpc/com.etzhayyim.apps.yorishiroEnaiyo.getStatus" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    --data "{\"draftId\":\"$DRAFT_ID\"}"
done
