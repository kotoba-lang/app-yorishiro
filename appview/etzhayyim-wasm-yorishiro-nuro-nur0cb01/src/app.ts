// TODO(ADR-2605111200 Phase 2, migration guide: 90-docs/2605111400-phase2-app-actor-dispatcher-migration-guide.md):
// 4 createKyselyDb callsites below throw WorkerDBProhibitedError at runtime.
// Replace each with `sdk.pds.xrpc("com.etzhayyim.apps.yorishiroNuro.<method>", ...)`:
//   - getDb().selectFrom(tableForLabel(label))         → com.etzhayyim.apps.yorishiroNuro.listOffersOrJobs
//   - insertInto("vertex_yorishiroNuro_offer")         → com.etzhayyim.apps.yorishiroNuro.putOffer
//   - insertInto("vertex_yorishiroNuro_claimReceipt")  → com.etzhayyim.apps.yorishiroNuro.putClaimReceipt
//   - insertInto("vertex_yorishiroNuro_claimJob")      → com.etzhayyim.apps.yorishiroNuro.putClaimJob
// Each NSID needs a lexicon JSON in 00-contracts/lexicons/com/etzhayyim/apps/yorishiroNuro/
// + a server-side handler + a vertex_bpmn_lexicon_binding row.
// Reference migration: etzhayyim-wasm-yorishiro-squarespace-sqddf3sp/src/app.ts (2026-05-11).
import {
  asAgentTool,
  createWorkerExport,
  createKyselyDb,
  genID,
  nowISO,
  requireApproval,
  withCapabilityTags,
  withOCELEvent,
  type HostSDK,
  nsid,
  parseLexiconInput,
} from "@etzhayyim/kotodama-host-sdk";

// ---------------------------------------------------------------------------
// Yorishiro — NURO 光 (Sony Network Communications) MyPage cashback adapter
//
// Reference: https://www.nuro.jp/app/mypage
//
// First-driving use case: B195 20,000 円キャッシュバック (NURO 光 2ギガ
// マンション タイプL, 11 か月後受取, window 2026-03-26..2026-05-10).
//
// Architecture:
//   handler (this worker)  = write-only: offer / claimJob / claimReceipt records
//   yorishiro-provider     = Playwright Chromium → www.nuro.jp/app/mypage login +
//                            特典・キャンペーン enumerate + bank form fill
//   provider-vault         = nuro/login (userId + password) +
//                            nuro/bankAccount/<key> (金融機関 / 支店 / 口座種別 /
//                            口座番号 / 口座名義カナ)
//
// Data placement (ADR-0018 PII Tier3 + faithful AT Protocol public/private):
//   Tier 1 Social   : postAs() — 受取完了の公開 notification (opt-in)
//   Tier 2 Domain   : writeRecord() — offer / claimJob / claimReceipt (metadata,
//                     camp code / amount / receipt number / submittedAt).
//                     Bank account number/name are NEVER written to the Repo.
//   Tier 3 State    : bank account + login creds = provider-vault.
//                     Screenshot blobs = R2 (content-addressed), accessed via
//                     blobKey reference only.
//
// Safety:
//   - claimCashback: confirm=true 必須 + RequireApproval(ClassA, 1, medium)
//   - listOffers / getClaimStatus: read-only (approval 不要)
//   - idempotencyKey: 45d window 中の二重申請防止
//   - 禁止銀行 (外国銀行 / 信託銀行 / 第二地方銀行 の一部) は provider runner で
//     事前 reject (MyPage 側バリデーションより早く)
// ---------------------------------------------------------------------------

let appId = "";
let actorDID = "";
type KyselyDb = ReturnType<typeof createKyselyDb>;
type AnyRow = Record<string, unknown>;
let db: KyselyDb | null = null;

const NSID = {
  offer: "com.etzhayyim.apps.yorishiroNuro.offer",
  claimJob: "com.etzhayyim.apps.yorishiroNuro.claimJob",
  claimReceipt: "com.etzhayyim.apps.yorishiroNuro.claimReceipt",
} as const;

const PROVIDER_DID = "did:web:yorishiro.etzhayyim.com";
const NURO_MYPAGE = "https://www.nuro.jp/app/mypage";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OfferRecord {
  campaignCode: string;
  title: string;
  amountJpy: number;
  windowOpen: string;
  windowClose: string;
  jobId: string;
  discoveredAt: string;
  createdAt: string;
  orgId: string;
  userId: string;
  actorId: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDb(): KyselyDb {
  if (!db) db = createKyselyDb();
  return db;
}

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
}

function typedRow(row: AnyRow): AnyRow {
  const out: AnyRow = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === "vertex_id" || key === "sensitivity_ord" || key === "owner_did") continue;
    out[snakeToCamel(key)] = value;
  }
  return out;
}

function tableForLabel(label: string): string {
  switch (label) {
    case "YorishiroNuroOffer":
      return "vertex_yorishiroNuro_offer";
    case "YorishiroNuroClaimJob":
      return "vertex_yorishiroNuro_claimJob";
    case "YorishiroNuroClaimReceipt":
      return "vertex_yorishiroNuro_claimReceipt";
    default:
      throw new Error(`unknown yorishiro nuro label: ${label}`);
  }
}

async function q(label: string, filter?: (row: AnyRow) => boolean): Promise<AnyRow[]> {
  const rows = await getDb()
    .selectFrom(tableForLabel(label) as any)
    .selectAll()
    .execute();
  return rows.map((row) => typedRow(row as AnyRow)).filter((row) => (filter ? filter(row) : true));
}

// ADR-0036: domain writes go directly to Hyperdrive, not via PDS createRecord

function postAs(sdk: HostSDK, did: string, text: string): void {
  sdk.pds.dispatch({ type: "app.bsky.feed.post", payload: { did, text } });
}

function invokeProvider(sdk: HostSDK, method: string, params: object): void {
  sdk.pds.dispatch({
    type: "invoke",
    payload: {
      did: PROVIDER_DID,
      method,
      params: JSON.stringify(params),
    },
  });
}

// ---------------------------------------------------------------------------
// Commands — Query (read-only, no confirm required)
// ---------------------------------------------------------------------------

function cmdListOffers(sdk: HostSDK, _payload: Uint8Array): unknown {
  const jobId = genID("nuroOfferJob");
  invokeProvider(sdk, "runBrowserSession", {
    sessionName: `nuro-offers-${jobId}`,
    entryUrl: NURO_MYPAGE,
    flow: "nuro-list-offers",
    jobId,
  });
  return { status: "queued", jobId, phase: "listOffers" };
}

async function cmdGetOffers(_sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.yorishiroNuro.getOffers", payload);
  const offset = req.offset ?? 0;
  const limit = Math.min(req.limit ?? 50, 100);
  const rows = (await q("YorishiroNuroOffer", (row) =>
    (!req.campaignCode || String(row.campaignCode ?? "") === req.campaignCode) &&
    (!req.jobId || String(row.jobId ?? "") === req.jobId),
  ))
    .sort((a, b) => String(b.discoveredAt ?? "").localeCompare(String(a.discoveredAt ?? "")))
    .slice(offset, offset + limit)
    .map((row) => ({
      campaignCode: row.campaignCode,
      title: row.title,
      amountJpy: row.amountJpy,
      windowOpen: row.windowOpen,
      windowClose: row.windowClose,
      jobId: row.jobId,
      discoveredAt: row.discoveredAt,
    }));
  return { offers: rows, offset, limit, total: rows.length };
}

async function cmdGetClaimStatus(_sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.yorishiroNuro.getClaimStatus", payload);
  if (!req.jobId && !req.campaignCode) return { error: "jobId or campaignCode is required" };
  const jobs = await q("YorishiroNuroClaimJob", (row) =>
    (!req.jobId || String(row.jobId ?? "") === req.jobId) &&
    (!req.campaignCode || String(row.campaignCode ?? "") === req.campaignCode),
  );
  const receipts = await q("YorishiroNuroClaimReceipt");
  const rows = jobs
    .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")))
    .slice(0, 1)
    .map((job) => {
      const receipt = receipts.find((r) => String(r.jobId ?? "") === String(job.jobId ?? ""));
      return {
        jobId: job.jobId,
        campaignCode: job.campaignCode,
        status: job.status,
        receiptNumber: receipt?.receiptNumber,
        submittedAt: receipt?.submittedAt,
        screenshotBlobKey: receipt?.screenshotBlobKey,
      };
    });
  if (rows.length === 0) return { status: "notFound" };
  return rows[0];
}

// ---------------------------------------------------------------------------
// Commands — Callback (from provider, after browser run)
// ---------------------------------------------------------------------------

async function cmdRecordOffers(_sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.yorishiroNuro.recordOffers", payload);
  if (!req.jobId) return { error: "jobId is required" };
  const offers = Array.isArray(req.offers) ? req.offers : [];
  const discoveredAt = nowISO();
  for (const o of offers) {
    if (!o || typeof o !== "object") continue;
    const code = String(o.campaignCode ?? "");
    if (!code) continue;
    const rkey = genID("nuroOffer");
    const ownerDid = actorDID || "did:web:nur0cb01.etzhayyim.com";
    await getDb()
      .insertInto("vertex_yorishiroNuro_offer" as any)
      .values({
        vertex_id: `at://${ownerDid}/com.etzhayyim.apps.yorishiroNuro.offer/${rkey}`,
        campaign_code: code,
        title: String(o.title ?? ""),
        amount_jpy: Number(o.amountJpy ?? 0) || 0,
        window_open: String(o.windowOpen ?? ""),
        window_close: String(o.windowClose ?? ""),
        job_id: req.jobId,
        discovered_at: discoveredAt,
        created_at: discoveredAt,
        org_id: "anon",
        user_id: "anon",
        actor_id: appId,
        sensitivity_ord: 2,
        owner_did: ownerDid,
      })
      .execute();
  }
  return { status: "offersRecorded", count: offers.length, jobId: req.jobId };
}

async function cmdRecordClaim(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.yorishiroNuro.recordClaim", payload);
  if (!req.jobId || !req.campaignCode || !req.receiptNumber) {
    return { error: "jobId, campaignCode, receiptNumber are required" };
  }
  const receiptId = genID("nuroRcpt");
  const ownerDid = actorDID || "did:web:nur0cb01.etzhayyim.com";
  await getDb()
    .insertInto("vertex_yorishiroNuro_claimReceipt" as any)
    .values({
      vertex_id: `at://${ownerDid}/com.etzhayyim.apps.yorishiroNuro.claimReceipt/${receiptId}`,
      receipt_id: receiptId,
      job_id: req.jobId,
      campaign_code: req.campaignCode,
      receipt_number: req.receiptNumber,
      screenshot_blob_key: req.screenshotBlobKey ?? "",
      amount_jpy: Number(req.amountJpy ?? 0) || 0,
      submitted_at: req.submittedAt ?? nowISO(),
      created_at: nowISO(),
      org_id: "anon",
      user_id: "anon",
      actor_id: appId,
      sensitivity_ord: 2,
      owner_did: ownerDid,
    })
    .execute();
  postAs(sdk, actorDID, `NURO キャッシュバック受取完了: ${req.campaignCode} / 受付番号 ${req.receiptNumber}`);
  return { status: "claimRecorded", receiptId };
}

// ---------------------------------------------------------------------------
// Commands — Destructive (financial movement, requires approval + confirm)
// ---------------------------------------------------------------------------

async function cmdClaimCashback(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.yorishiroNuro.claimCashback", payload);

  if (!req.campaignCode) return { error: "campaignCode is required (e.g. 'B195')" };
  if (!req.bankVaultKey) {
    return {
      error: "bankVaultKey is required (path-suffix into provider-vault nuro/bankAccount/<key>, e.g. 'primary')",
    };
  }
  if (!req.idempotencyKey) {
    return { error: "idempotencyKey is required (stable per (user, campaignCode) to guard against double-claim)" };
  }
  if (!req.confirm) {
    return {
      error: "confirm=true is required. Cashback claim submits a bank-account form and triggers money movement. Verify the bank account + campaign window before confirming.",
      campaignCode: req.campaignCode,
    };
  }

  // Dedup: reject if a completed receipt for this (campaignCode, idempotencyKey) already exists.
  const existing = await q("YorishiroNuroClaimJob", (row) =>
    String(row.campaignCode ?? "") === req.campaignCode &&
    String(row.idempotencyKey ?? "") === req.idempotencyKey,
  );
  if (existing.length > 0) {
    return {
      error: "duplicate claim",
      existingJobId: existing[0].jobId,
      status: existing[0].status,
    };
  }

  const jobId = genID("nuroClaim");
  invokeProvider(sdk, "runBrowserSession", {
    sessionName: `nuro-claim-${jobId}`,
    entryUrl: NURO_MYPAGE,
    flow: "nuro-claim-cashback",
    jobId,
    campaignCode: req.campaignCode,
    bankVaultKey: req.bankVaultKey,
    idempotencyKey: req.idempotencyKey,
  });

  const ownerDid = actorDID || "did:web:nur0cb01.etzhayyim.com";
  await getDb()
    .insertInto("vertex_yorishiroNuro_claimJob" as any)
    .values({
      vertex_id: `at://${ownerDid}/com.etzhayyim.apps.yorishiroNuro.claimJob/${jobId}`,
      job_id: jobId,
      campaign_code: req.campaignCode,
      bank_vault_key: req.bankVaultKey,
      idempotency_key: req.idempotencyKey,
      provider: PROVIDER_DID,
      entry_url: NURO_MYPAGE,
      status: "pending",
      created_at: nowISO(),
      org_id: "anon",
      user_id: "anon",
      actor_id: appId,
      sensitivity_ord: 2,
      owner_did: ownerDid,
    })
    .execute();

  postAs(sdk, actorDID, `NURO キャッシュバック受取ジョブ作成: ${req.campaignCode} → ${jobId}`);
  return { status: "jobQueued", jobId, campaignCode: req.campaignCode };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

function registerYorishiroNuroApp(sdk: HostSDK): void {
  sdk.app
    // ── Query ──────────────────────────────────────────────────────────────
    .command(nsid("com.etzhayyim.apps.yorishiroNuro.listOffers"),
      (_ctx, body) => cmdListOffers(sdk, body),
      asAgentTool("Login to NURO MyPage via browser and enumerate available cashback offers (特典・キャンペーン). Provider callbacks recordOffers with results."),
      withCapabilityTags("nuro", "offer", "query", "browser-automation"),
    )
    .command(nsid("com.etzhayyim.apps.yorishiroNuro.getOffers"),
      (_ctx, body) => cmdGetOffers(sdk, body),
      asAgentTool("Get previously enumerated NURO offers. Filter by campaignCode or jobId with pagination."),
      withCapabilityTags("nuro", "offer", "query"),
    )
    .command(nsid("com.etzhayyim.apps.yorishiroNuro.getClaimStatus"),
      (_ctx, body) => cmdGetClaimStatus(sdk, body),
      asAgentTool("Get the status of a NURO cashback claim job by jobId or campaignCode (includes receiptNumber + screenshot blobKey once completed)."),
      withCapabilityTags("nuro", "claim", "query", "tracking"),
    )
    // ── Callback (provider → app) ──────────────────────────────────────────
    .command(nsid("com.etzhayyim.apps.yorishiroNuro.recordOffers"),
      (_ctx, body) => cmdRecordOffers(sdk, body),
      asAgentTool("Record offers (callback from yorishiro-provider after MyPage enumeration)."),
      withCapabilityTags("nuro", "offer", "callback"),
    )
    .command(nsid("com.etzhayyim.apps.yorishiroNuro.recordClaim"),
      (_ctx, body) => cmdRecordClaim(sdk, body),
      asAgentTool("Record a claim receipt (callback from yorishiro-provider after form submission)."),
      withCapabilityTags("nuro", "claim", "receipt", "callback"),
    )
    // ── Destructive — Cashback claim (financial, requires approval) ───────
    .command(nsid("com.etzhayyim.apps.yorishiroNuro.claimCashback"),
      (_ctx, body) => cmdClaimCashback(sdk, body),
      asAgentTool("Submit a NURO cashback receipt form via browser automation (requires confirm=true + bankVaultKey + idempotencyKey). Bank account is loaded from provider-vault nuro/bankAccount/<bankVaultKey>; it is never passed as a parameter."),
      withCapabilityTags("nuro", "claim", "cashback", "browser-automation"),
      withOCELEvent("governance.audit"),
      requireApproval({ class: "A", count: 1, level: "medium" }),
    );
}

export default createWorkerExport((sdk) => {
  appId = sdk.pds.selfNanoid ?? "";
  actorDID = sdk.pds.selfRepo ?? "";
  registerYorishiroNuroApp(sdk);
});
