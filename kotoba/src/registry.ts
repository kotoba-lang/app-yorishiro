/**
 * yorishiro kotoba — kotoba-E2E registry.
 *
 * Plaintext path (yorishiroAnchor): sdk.write / sdk.read — public personification
 * vessel catalog.
 * E2E path (freezeRequest): sdk.encryptedWrite / sdk.encryptedRead — LE /
 * confidential crypto-exchange freeze incident body sealed in the kotoba
 * envelope (ADR-2605181100), read-cap = owner DID + explicit recipients. The
 * substrate never sees the subject account ref in plaintext.
 *
 * Browser-automation EXECUTION + Vault credential custody + the actual freeze /
 * withdrawal-block ACTION stay etzhayyim (consent-capability); only the data records
 * live here.
 */

import type { Etzhayyim } from "@etzhayyim/sdk";
import {
  ANCHOR_COLLECTION,
  FREEZE_INNER_TYPE,
  anchorDidFor,
  anchorRkey,
  freezeRkey,
  isAnchorType,
  isFreezeStatus,
  type CoverageInput,
  type CoverageOutput,
  type FreezeRequestBody,
  type FreezeRequestView,
  type GetAnchorInput,
  type GetAnchorOutput,
  type GetFreezeInput,
  type GetFreezeOutput,
  type ListAnchorsInput,
  type ListAnchorsOutput,
  type ListFreezesInput,
  type ListFreezesOutput,
  type RecordFreezeInput,
  type RecordFreezeOutput,
  type RegisterAnchorInput,
  type RegisterAnchorOutput,
  type YorishiroAnchorRecord,
  type YorishiroAnchorView,
} from "./types.js";

const PAGE_LIMIT = 100;
const DEFAULT_MAX_SCAN = 10_000;

// ─── Yorishiro anchor (PLAINTEXT) ───────────────────────────────────

export async function registerAnchor(e: Etzhayyim, input: RegisterAnchorInput): Promise<RegisterAnchorOutput> {
  if (!input.anchorId || !input.displayName) return { status: "rejected", error: "missingRequiredFields" };
  if (!isAnchorType(input.type)) return { status: "rejected", error: "invalidType" };
  const rkey = anchorRkey(input.anchorId);
  const existing = await e.read<YorishiroAnchorRecord>({ collection: ANCHOR_COLLECTION, rkey }).catch(() => ({ records: [] }));
  if (existing.records[0]?.value) {
    return { status: "alreadyExists", anchorUri: existing.records[0].uri, did: existing.records[0].value.did, anchorId: input.anchorId };
  }
  const now = new Date().toISOString();
  const did = anchorDidFor(input.anchorId);
  const record: YorishiroAnchorRecord = {
    did,
    anchorId: input.anchorId,
    displayName: input.displayName,
    displayNameLocal: input.displayNameLocal,
    type: input.type,
    voiceProfileUri: input.voiceProfileUri,
    avatarUri: input.avatarUri,
    boundAgentDid: input.boundAgentDid,
    createdAt: now,
  };
  const receipt = await e.write({ collection: ANCHOR_COLLECTION, record: record as unknown as Record<string, unknown>, rkey });
  return { status: "registered", anchorUri: receipt.uri, did, anchorId: input.anchorId };
}

export async function getAnchor(e: Etzhayyim, input: GetAnchorInput): Promise<GetAnchorOutput> {
  if (!input.anchorId) return { error: "invalidAnchorId" };
  const resp = await e.read<YorishiroAnchorRecord>({ collection: ANCHOR_COLLECTION, rkey: anchorRkey(input.anchorId) }).catch(() => ({ records: [] }));
  const r = resp.records[0];
  if (!r?.value) return { error: "notFound" };
  return { anchor: { ...r.value, anchorUri: r.uri } };
}

export async function listAnchors(e: Etzhayyim, input: ListAnchorsInput = {}): Promise<ListAnchorsOutput> {
  const limit = Math.min(input.limit ?? 50, 200);
  const resp = await e.read<YorishiroAnchorRecord>({ collection: ANCHOR_COLLECTION, cursor: input.cursor, limit });
  const items: YorishiroAnchorView[] = resp.records
    .filter((r) => !input.type || r.value.type === input.type)
    .filter((r) => !input.boundAgentDid || r.value.boundAgentDid === input.boundAgentDid)
    .map((r) => ({ ...r.value, anchorUri: r.uri }));
  return { items, cursor: resp.cursor, total: items.length };
}

// ─── Freeze request (E2E-ENCRYPTED, LE / confidential) ──────────────

export async function recordFreeze(e: Etzhayyim, input: RecordFreezeInput): Promise<RecordFreezeOutput> {
  if (!input.requestId || !input.exchange || !input.jurisdiction || !input.subjectAccountRef || !input.reason) {
    return { status: "rejected", error: "missingRequiredFields" };
  }
  const status = input.status ?? "submitted";
  if (!isFreezeStatus(status)) return { status: "rejected", error: "invalidStatus" };
  const body: FreezeRequestBody = {
    requestId: input.requestId,
    anchorId: input.anchorId,
    exchange: input.exchange,
    jurisdiction: input.jurisdiction,
    subjectAccountRef: input.subjectAccountRef,
    reason: input.reason,
    status,
    requestedAt: input.requestedAt ?? new Date().toISOString(),
  };
  // Read-cap = owner DID (sender, auto-wrapped) + any explicit recipients.
  const receipt = await e.encryptedWrite<Record<string, unknown>>({
    innerType: FREEZE_INNER_TYPE,
    record: body as unknown as Record<string, unknown>,
    recipients: input.recipients ?? [],
    rkey: freezeRkey(input.requestId),
  });
  return { status: "recorded", uri: receipt.uri, keyId: receipt.keyId, requestId: input.requestId };
}

async function scanFreezes(e: Etzhayyim, maxScan: number): Promise<FreezeRequestView[]> {
  const out: FreezeRequestView[] = [];
  let cursor: string | undefined;
  while (out.length < maxScan) {
    const page = await e.encryptedRead<FreezeRequestBody>({ innerType: FREEZE_INNER_TYPE, cursor, limit: PAGE_LIMIT });
    for (const r of page.records) {
      out.push({ ...r.value, uri: r.uri, sender: r.sender, createdAt: r.createdAt });
    }
    if (!page.cursor || page.records.length === 0) break;
    cursor = page.cursor;
  }
  return out;
}

export async function listFreezes(e: Etzhayyim, input: ListFreezesInput = {}): Promise<ListFreezesOutput> {
  const limit = Math.min(input.limit ?? 50, 200);
  const all = await scanFreezes(e, DEFAULT_MAX_SCAN);
  const filtered = all
    .filter((f) => !input.exchange || f.exchange === input.exchange)
    .filter((f) => !input.jurisdiction || f.jurisdiction === input.jurisdiction);
  return { items: filtered.slice(0, limit), total: filtered.length };
}

export async function getFreeze(e: Etzhayyim, input: GetFreezeInput): Promise<GetFreezeOutput> {
  if (!input.requestId) return { error: "invalidRequestId" };
  const all = await scanFreezes(e, DEFAULT_MAX_SCAN);
  const found = all.find((f) => f.requestId === input.requestId);
  if (!found) return { error: "notFound" };
  return { request: found };
}

// ─── Coverage rollup ────────────────────────────────────────────────

export async function coverage(e: Etzhayyim, input: CoverageInput = {}): Promise<CoverageOutput> {
  const maxScan = Math.min(input.maxScan ?? DEFAULT_MAX_SCAN, DEFAULT_MAX_SCAN);
  const anchorsByType: Record<string, number> = {};
  let yorishiroAnchorCount = 0;
  let cursor: string | undefined;
  while (yorishiroAnchorCount < maxScan) {
    const page = await e.read<YorishiroAnchorRecord>({ collection: ANCHOR_COLLECTION, cursor, limit: PAGE_LIMIT });
    for (const r of page.records) {
      anchorsByType[r.value.type] = (anchorsByType[r.value.type] ?? 0) + 1;
      yorishiroAnchorCount += 1;
    }
    if (!page.cursor || page.records.length < PAGE_LIMIT) break;
    cursor = page.cursor;
  }
  const freezes = await scanFreezes(e, maxScan);
  const freezesByExchange: Record<string, number> = {};
  for (const f of freezes) {
    freezesByExchange[f.exchange] = (freezesByExchange[f.exchange] ?? 0) + 1;
  }
  return {
    yorishiroAnchorCount,
    freezeRequestCount: freezes.length,
    anchorsByType,
    freezesByExchange,
    truncated: yorishiroAnchorCount >= maxScan || freezes.length >= maxScan,
  };
}
