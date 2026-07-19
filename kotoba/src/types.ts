/**
 * yorishiro kotoba — kotoba-E2E split.
 *
 * Yorishiro (依り代) is an Apify-inspired web-service browser-automation platform
 * plus a personification-vessel catalog and a crypto-exchange compliance
 * (fraud/theft freeze) incident surface.
 *
 * Per ADR-2606011400 (Consensys) + ADR-2605172400 (3-axis) + ADR-2605181100
 * (kotoba E2E encrypted-record envelope). Founder directive 2026-06-03: PII /
 * CUI / LE may migrate to etzhayyim when made safe via kotoba E2E.
 *
 * SPLIT:
 *   PUBLIC (plaintext AT records) — the yorishiro anchor catalog: a vessel for
 *   AI-agent personification (displayName / type / voice + avatar URIs / bound
 *   agent DID). Frontable open discovery metadata; no PII, no incident data.
 *
 *   LE / CONFIDENTIAL (kotoba E2E, com.etzhayyim.encrypted.record) — crypto-
 *   exchange freeze-request incident records (subject account ref + exchange +
 *   jurisdiction + reason + status). These are law-enforcement-coordination
 *   records, sealed via sdk.encryptedWrite (read-cap = owner DID + explicit
 *   recipients, e.g. the lawfirm actor). The substrate never sees them in
 *   plaintext.
 *
 *   STAYS etzhayyim (NOT a collection — consumed via consent-capability) — the
 *   Playwright/Chromium browser-automation EXECUTION (yorishiro-provider),
 *   credential/secret custody (HashiCorp Vault), and the enforcement ACTION of
 *   actually submitting a freeze / withdrawal-block to the exchange. Those are
 *   regulated *acts*. Only the resulting incident DATA records migrate (E2E).
 *
 * AT-Lexicon: no float (offset/limit/counts are integers; jurisdiction count
 * is integer; no decimals).
 */

// Plaintext public collection.
export const ANCHOR_COLLECTION = "com.etzhayyim.apps.yorishiro.yorishiroAnchor";
// E2E inner-type NSID (body shape inside the encrypted envelope).
export const FREEZE_INNER_TYPE = "com.etzhayyim.apps.yorishiro.freezeRequest";

export const YORISHIRO_DID_PREFIX = "did:web:yorishiro.etzhayyim.com:" as const;

export const ANCHOR_TYPES = ["fictional", "historical", "licensed"] as const;
export type AnchorType = (typeof ANCHOR_TYPES)[number];

export const FREEZE_STATUSES = [
  "submitted",
  "acknowledged",
  "frozen",
  "rejected",
  "released",
] as const;
export type FreezeStatus = (typeof FREEZE_STATUSES)[number];

// ─── Yorishiro anchor (PLAINTEXT, public catalog) ───────────────────

export interface YorishiroAnchorRecord {
  did: string;
  anchorId: string;
  displayName: string;
  displayNameLocal?: string;
  type: AnchorType;
  voiceProfileUri?: string;
  avatarUri?: string;
  boundAgentDid?: string;
  createdAt: string;
}
export interface YorishiroAnchorView extends YorishiroAnchorRecord {
  anchorUri: string;
}
export interface RegisterAnchorInput {
  anchorId: string;
  displayName: string;
  displayNameLocal?: string;
  type: AnchorType;
  voiceProfileUri?: string;
  avatarUri?: string;
  boundAgentDid?: string;
}
export interface RegisterAnchorOutput {
  status: "registered" | "alreadyExists" | "rejected";
  anchorUri?: string;
  did?: string;
  anchorId?: string;
  error?: string;
}
export interface GetAnchorInput {
  anchorId: string;
}
export interface GetAnchorOutput {
  anchor?: YorishiroAnchorView;
  error?: string;
}
export interface ListAnchorsInput {
  type?: AnchorType;
  boundAgentDid?: string;
  limit?: number;
  cursor?: string;
}
export interface ListAnchorsOutput {
  items: YorishiroAnchorView[];
  cursor?: string;
  total: number;
}

// ─── Freeze request (E2E-ENCRYPTED, LE / confidential) ──────────────

export interface FreezeRequestBody {
  requestId: string;
  /** Anchor (vessel) this incident references, if any. FK -> yorishiroAnchor. */
  anchorId?: string;
  exchange: string;
  jurisdiction: string;
  /** Confidential subject account reference at the exchange. */
  subjectAccountRef: string;
  reason: string;
  status: FreezeStatus;
  requestedAt: string;
}
export interface FreezeRequestView extends FreezeRequestBody {
  uri: string;
  sender: string;
  createdAt: string;
}
export interface RecordFreezeInput {
  requestId: string;
  anchorId?: string;
  exchange: string;
  jurisdiction: string;
  subjectAccountRef: string;
  reason: string;
  status?: FreezeStatus;
  requestedAt?: string;
  /** Extra DIDs to grant read-cap (owner always included), e.g. lawfirm actor. */
  recipients?: string[];
}
export interface RecordFreezeOutput {
  status: "recorded" | "rejected";
  uri?: string;
  keyId?: string;
  requestId?: string;
  error?: string;
}
export interface ListFreezesInput {
  exchange?: string;
  jurisdiction?: string;
  limit?: number;
  cursor?: string;
}
export interface ListFreezesOutput {
  items: FreezeRequestView[];
  cursor?: string;
  total: number;
}
export interface GetFreezeInput {
  requestId: string;
}
export interface GetFreezeOutput {
  request?: FreezeRequestView;
  error?: string;
}

// ─── Coverage rollup ────────────────────────────────────────────────

export interface CoverageInput {
  maxScan?: number;
}
export interface CoverageOutput {
  yorishiroAnchorCount?: number;
  freezeRequestCount?: number;
  anchorsByType?: Record<string, number>;
  freezesByExchange?: Record<string, number>;
  truncated?: boolean;
  error?: string;
}

// ─── Validation + helpers ───────────────────────────────────────────

export function isAnchorType(v: unknown): v is AnchorType {
  return typeof v === "string" && (ANCHOR_TYPES as readonly string[]).includes(v);
}
export function isFreezeStatus(v: unknown): v is FreezeStatus {
  return typeof v === "string" && (FREEZE_STATUSES as readonly string[]).includes(v);
}
export function anchorDidFor(id: string): string {
  return `${YORISHIRO_DID_PREFIX}anchor:${id.toLowerCase()}`;
}
export function anchorRkey(id: string): string {
  return `anchor-${id.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}
export function freezeRkey(id: string): string {
  return `freeze-${id.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}
