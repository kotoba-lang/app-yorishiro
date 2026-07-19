// TODO(ADR-2605111200 Phase 2, migration guide: 90-docs/2605111400-phase2-app-actor-dispatcher-migration-guide.md):
// 6 createKyselyDb callsites below throw WorkerDBProhibitedError at runtime.
// Replace each with `sdk.pds.xrpc("com.etzhayyim.apps.yorishiroEnaiyo.<method>", ...)`:
//   - getDb().selectFrom(tableForLabel(label))            → com.etzhayyim.apps.yorishiroEnaiyo.listJobs
//   - insertInto("vertex_yorishiroEnaiyo_draftNaiyo")     → com.etzhayyim.apps.yorishiroEnaiyo.putDraftNaiyo
//   - insertInto("vertex_yorishiroEnaiyo_docxBlob")       → com.etzhayyim.apps.yorishiroEnaiyo.putDocxBlob
//   - insertInto("vertex_yorishiroEnaiyo_submitJob")      → com.etzhayyim.apps.yorishiroEnaiyo.putSubmitJob
//   - insertInto("vertex_yorishiroEnaiyo_batchJob")       → com.etzhayyim.apps.yorishiroEnaiyo.putBatchJob
//   - insertInto("vertex_yorishiroEnaiyo_receipt")        → com.etzhayyim.apps.yorishiroEnaiyo.putReceipt
// Each NSID needs a lexicon JSON in 00-contracts/lexicons/com/etzhayyim/apps/yorishiroEnaiyo/
// + a server-side handler + a vertex_bpmn_lexicon_binding row.
// Reference migration: etzhayyim-wasm-yorishiro-squarespace-sqddf3sp/src/app.ts (2026-05-11).
import {
  asAgentTool,
  createWorkerExport,
  createKyselyDb,
  decodeJson,
  genID,
  nowISO,
  withCapabilityTags,
  withOCELEvent,
  type HostSDK,
  nsid,
  parseLexiconInput,
} from "@etzhayyim/kotodama-host-sdk";

// ---------------------------------------------------------------------------
// Yorishiro — 日本郵便 電子内容証明 (e-naiyo) adapter
//
// Reference: https://www.post.japanpost.jp/service/enaiyo/pay.html
//
// Architecture:
//   handler (this worker)  = write-only: draftNaiyo / docxBlob / submitJob / receipt records
//   yorishiro-provider     = Playwright Chromium → post.japanpost.jp login + .docx upload
//   docx-renderer          = structured draft → Word (.docx) per JP official template
//                            - a4PortraitHorizontal (横書き, 26 行 × 20 字)
//                            - a4LandscapeVertical  (縦書き, 20 行 × 26 字)
//   provider-vault         = customer_number / password / card credentials
//
// Submission modes (from post.japanpost.jp/service/enaiyo/download.html):
//   1. single     — 1 docx per submission
//   2. batch-csv  — CSV + docx template → many naiyo at once (差込差出し)
//
// Tier 1 Social: postAs() — 提出完了の公開 notification (optional, opt-in)
// Tier 2 Domain: writeRecord() — draft / docxBlob / submitJob / receipt records
// Tier 3 State:  PII / body text / card details = Signal-encrypted private records
// ---------------------------------------------------------------------------

let appId = "";
let actorDID = "";
type KyselyDb = ReturnType<typeof createKyselyDb>;
type AnyRow = Record<string, unknown>;
let db: KyselyDb | null = null;

const NSID = {
  draftNaiyo: "com.etzhayyim.apps.yorishiroEnaiyo.draftNaiyo",
  docxBlob: "com.etzhayyim.apps.yorishiroEnaiyo.docxBlob",
  batchJob: "com.etzhayyim.apps.yorishiroEnaiyo.batchJob",
  submitJob: "com.etzhayyim.apps.yorishiroEnaiyo.submitJob",
  receipt: "com.etzhayyim.apps.yorishiroEnaiyo.receipt",
  tracking: "com.etzhayyim.apps.yorishiroEnaiyo.tracking",
} as const;

const PROVIDER_DID = "did:web:yorishiro.etzhayyim.com";
const ENAIYO_LANDING = "https://www.post.japanpost.jp/service/enaiyo/pay.html";
const ENAIYO_DOWNLOAD = "https://www.post.japanpost.jp/service/enaiyo/download.html";

/** Official e-naiyo templates — see post.japanpost.jp/service/enaiyo/download.html */
type TemplateType = "a4PortraitHorizontal" | "a4LandscapeVertical";
const TEMPLATE_LIMITS: Record<TemplateType, { lines: number; charsPerLine: number }> = {
  a4PortraitHorizontal: { lines: 26, charsPerLine: 20 },
  a4LandscapeVertical: { lines: 20, charsPerLine: 26 },
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Party {
  name: string;
  postalCode: string;
  address: string;
  phone?: string;
}

interface DraftInput {
  sender: Party;
  recipient: Party;
  bodyText: string;
  templateType: TemplateType;
  paymentMethod: "kouno" | "creditCard";
  vaultRef?: string;
}

interface DraftRecord extends DraftInput {
  draftId: string;
  docxBlobKey?: string;
  status: "draft" | "rendered" | "queued" | "submitted" | "failed";
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

function parseDbValue(value: unknown): unknown {
  if (typeof value !== "string" || !/^[\[{]/.test(value.trim())) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function typedRow(row: AnyRow): AnyRow {
  const out: AnyRow = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === "vertex_id" || key === "sensitivity_ord" || key === "owner_did") continue;
    out[snakeToCamel(key)] = parseDbValue(value);
  }
  return out;
}

function tableForLabel(label: string): string {
  switch (label) {
    case "YorishiroEnaiyoDraftNaiyo":
      return "vertex_yorishiroEnaiyo_draftNaiyo";
    case "YorishiroEnaiyoDocxBlob":
      return "vertex_yorishiroEnaiyo_docxBlob";
    case "YorishiroEnaiyoBatchJob":
      return "vertex_yorishiroEnaiyo_batchJob";
    case "YorishiroEnaiyoSubmitJob":
      return "vertex_yorishiroEnaiyo_submitJob";
    case "YorishiroEnaiyoReceipt":
      return "vertex_yorishiroEnaiyo_receipt";
    default:
      throw new Error(`unknown yorishiro enaiyo label: ${label}`);
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

function validateParty(p: Party | undefined, label: string): string | null {
  if (!p) return `${label} is required`;
  if (!p.name) return `${label}.name is required`;
  if (!p.postalCode || !/^\d{3}-?\d{4}$/.test(p.postalCode)) return `${label}.postalCode must be 〒NNN-NNNN`;
  if (!p.address) return `${label}.address is required`;
  return null;
}

function validateBody(text: string, template: TemplateType): string | null {
  if (!text) return "bodyText is required";
  const limits = TEMPLATE_LIMITS[template];
  if (!limits) return `unknown templateType: ${template}`;
  const lines = text.split(/\r?\n/);
  if (lines.length > limits.lines) {
    return `bodyText exceeds ${limits.lines} lines for template ${template}`;
  }
  for (const line of lines) {
    if ([...line].length > limits.charsPerLine) {
      return `bodyText line exceeds ${limits.charsPerLine} characters (${template}): ${line.slice(0, 10)}…`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Commands — Draft
// ---------------------------------------------------------------------------

async function cmdCreateDraft(_sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.yorishiroEnaiyo.createDraft", payload);
  const template: TemplateType = req.templateType ?? "a4PortraitHorizontal";
  if (!(template in TEMPLATE_LIMITS)) {
    return { error: "templateType must be 'a4PortraitHorizontal' or 'a4LandscapeVertical'" };
  }
  const err =
    validateParty(req.sender, "sender") ||
    validateParty(req.recipient, "recipient") ||
    validateBody(req.bodyText, template);
  if (err) return { error: err };
  if (req.paymentMethod !== "kouno" && req.paymentMethod !== "creditCard") {
    return { error: "paymentMethod must be 'kouno' (後納) or 'creditCard'" };
  }

  const draftId = genID("naiyo");
  const ownerDid = actorDID || "did:web:jp4n41y0.etzhayyim.com";
  await getDb()
    .insertInto("vertex_yorishiroEnaiyo_draftNaiyo" as any)
    .values({
      vertex_id: `at://${ownerDid}/com.etzhayyim.apps.yorishiroEnaiyo.draftNaiyo/${draftId}`,
      draft_id: draftId,
      template_type: template,
      payment_method: req.paymentMethod,
      vault_ref: req.vaultRef ?? "",
      docx_blob_key: "",
      status: "draft",
      created_at: nowISO(),
      org_id: "anon",
      user_id: "anon",
      actor_id: appId,
      sensitivity_ord: 2,
      owner_did: ownerDid,
    })
    .execute();
  return { status: "draftCreated", draftId };
}

async function cmdListDrafts(_sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.yorishiroEnaiyo.listDrafts", payload);
  const offset = req.offset ?? 0;
  const limit = Math.min(req.limit ?? 50, 100);
  const rows = (await q("YorishiroEnaiyoDraftNaiyo", (row) => !req.status || row.status === req.status))
    .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")))
    .slice(offset, offset + limit)
    .map((row) => ({
      draftId: String(row.draftId ?? ""),
      status: String(row.status ?? ""),
      createdAt: String(row.createdAt ?? ""),
      sender: row.sender,
      recipient: row.recipient,
    }));
  return { drafts: rows, offset, limit, total: rows.length };
}

async function cmdGetDraft(_sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.yorishiroEnaiyo.getDraft", payload);
  if (!req.draftId) return { error: "draftId is required" };
  const rows = await q("YorishiroEnaiyoDraftNaiyo", (row) => String(row.draftId ?? "") === req.draftId);
  if (rows.length === 0) return { error: "not found" };
  return { draft: rows[0] };
}

// ---------------------------------------------------------------------------
// Commands — Render .docx (delegated to docx-renderer actor)
// ---------------------------------------------------------------------------

async function cmdRenderDocx(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.yorishiroEnaiyo.renderDocx", payload);
  if (!req.draftId) return { error: "draftId is required" };
  const jobId = genID("docxRender");
  sdk.pds.dispatch({
    type: "invoke",
    payload: {
      did: PROVIDER_DID,
      method: "renderEnaiyoDocx",
      params: JSON.stringify({ draftId: req.draftId, jobId, templateSource: ENAIYO_DOWNLOAD }),
    },
  });
  const ownerDid = actorDID || "did:web:jp4n41y0.etzhayyim.com";
  await getDb()
    .insertInto("vertex_yorishiroEnaiyo_docxBlob" as any)
    .values({
      vertex_id: `at://${ownerDid}/com.etzhayyim.apps.yorishiroEnaiyo.docxBlob/${jobId}`,
      job_id: jobId,
      draft_id: req.draftId,
      blob_key: "",
      status: "pending",
      created_at: nowISO(),
      org_id: "anon",
      user_id: "anon",
      actor_id: appId,
      sensitivity_ord: 2,
      owner_did: ownerDid,
    })
    .execute();
  return { status: "renderQueued", jobId, draftId: req.draftId };
}

// ---------------------------------------------------------------------------
// Commands — Submit (single / batch) via yorishiro-provider
// ---------------------------------------------------------------------------

async function cmdSubmitNaiyo(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.yorishiroEnaiyo.submitNaiyo", payload);
  if (!req.draftId) return { error: "draftId is required" };
  if (!req.confirm) return { error: "confirm=true is required (submission is billable and legally binding)" };

  const jobId = genID("enaiyoJob");
  sdk.pds.dispatch({
    type: "invoke",
    payload: {
      did: PROVIDER_DID,
      method: "runBrowserSession",
      params: JSON.stringify({
        sessionName: `enaiyo-${jobId}`,
        entryUrl: ENAIYO_LANDING,
        flow: "japanpost-enaiyo-single",
        draftId: req.draftId,
        jobId,
      }),
    },
  });

  const ownerDid = actorDID || "did:web:jp4n41y0.etzhayyim.com";
  await getDb()
    .insertInto("vertex_yorishiroEnaiyo_submitJob" as any)
    .values({
      vertex_id: `at://${ownerDid}/com.etzhayyim.apps.yorishiroEnaiyo.submitJob/${jobId}`,
      job_id: jobId,
      draft_id: req.draftId,
      mode: "single",
      provider: PROVIDER_DID,
      entry_url: ENAIYO_LANDING,
      format: "browser_automation",
      status: "pending",
      created_at: nowISO(),
      org_id: "anon",
      user_id: "anon",
      actor_id: appId,
      sensitivity_ord: 2,
      owner_did: ownerDid,
    })
    .execute();

  postAs(sdk, actorDID, `内容証明 提出ジョブ作成: ${req.draftId} → ${jobId}`);
  return { status: "jobQueued", jobId, draftId: req.draftId };
}

async function cmdSubmitBatch(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.yorishiroEnaiyo.submitBatch", payload);
  const draftIds = req.draftIds ?? [];
  if (draftIds.length === 0 && !req.csvBlobKey) {
    return { error: "draftIds[] or csvBlobKey is required (差込差出し: CSV + template)" };
  }
  if (!req.confirm) return { error: "confirm=true is required (batch submission is billable)" };

  const batchId = genID("enaiyoBatch");
  sdk.pds.dispatch({
    type: "invoke",
    payload: {
      did: PROVIDER_DID,
      method: "runBrowserSession",
      params: JSON.stringify({
        sessionName: `enaiyo-batch-${batchId}`,
        entryUrl: ENAIYO_LANDING,
        flow: "japanpost-enaiyo-batch",
        batchId,
        draftIds,
        csvBlobKey: req.csvBlobKey ?? "",
        templateBlobKey: req.templateBlobKey ?? "",
      }),
    },
  });

  const ownerDid = actorDID || "did:web:jp4n41y0.etzhayyim.com";
  await getDb()
    .insertInto("vertex_yorishiroEnaiyo_batchJob" as any)
    .values({
      vertex_id: `at://${ownerDid}/com.etzhayyim.apps.yorishiroEnaiyo.batchJob/${batchId}`,
      batch_id: batchId,
      draft_ids: JSON.stringify(draftIds),
      csv_blob_key: req.csvBlobKey ?? "",
      template_blob_key: req.templateBlobKey ?? "",
      mode: "batch",
      provider: PROVIDER_DID,
      entry_url: ENAIYO_LANDING,
      format: "browser_automation",
      status: "pending",
      count: draftIds.length,
      created_at: nowISO(),
      org_id: "anon",
      user_id: "anon",
      actor_id: appId,
      sensitivity_ord: 2,
      owner_did: ownerDid,
    })
    .execute();

  postAs(sdk, actorDID, `内容証明 差込差出しバッチ作成: ${batchId} (${draftIds.length} 件)`);
  return { status: "batchQueued", batchId, count: draftIds.length };
}

// ---------------------------------------------------------------------------
// Commands — Receipt / Tracking
// ---------------------------------------------------------------------------

async function cmdRecordReceipt(_sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.yorishiroEnaiyo.recordReceipt", payload);
  if (!req.jobId || !req.draftId || !req.receiptNumber) {
    return { error: "jobId, draftId, receiptNumber are required" };
  }
  const receiptId = genID("rcpt");
  const ownerDid = actorDID || "did:web:jp4n41y0.etzhayyim.com";
  await getDb()
    .insertInto("vertex_yorishiroEnaiyo_receipt" as any)
    .values({
      vertex_id: `at://${ownerDid}/com.etzhayyim.apps.yorishiroEnaiyo.receipt/${receiptId}`,
      receipt_id: receiptId,
      job_id: req.jobId,
      draft_id: req.draftId,
      receipt_number: req.receiptNumber,
      receipt_pdf_blob_key: req.receiptPdfBlobKey ?? "",
      submitted_at: req.submittedAt ?? nowISO(),
      created_at: nowISO(),
      org_id: "anon",
      user_id: "anon",
      actor_id: appId,
      sensitivity_ord: 2,
      owner_did: ownerDid,
    })
    .execute();
  return { status: "receiptRecorded", receiptId };
}

async function cmdGetStatus(_sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.apps.yorishiroEnaiyo.getStatus", payload);
  if (!req.draftId && !req.jobId) return { error: "draftId or jobId is required" };
  const jobs = await q("YorishiroEnaiyoSubmitJob", (row) =>
    (!req.jobId || String(row.jobId ?? "") === req.jobId) &&
    (!req.draftId || String(row.draftId ?? "") === req.draftId),
  );
  const receipts = await q("YorishiroEnaiyoReceipt");
  const rows = jobs
    .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")))
    .slice(0, 1)
    .map((job) => {
      const receipt = receipts.find((r) => String(r.jobId ?? "") === String(job.jobId ?? ""));
      return {
        jobId: job.jobId,
        draftId: job.draftId,
        status: job.status,
        receiptNumber: receipt?.receiptNumber,
        pdfBlobKey: receipt?.receiptPdfBlobKey,
      };
    });
  if (rows.length === 0) return { status: "notFound" };
  return rows[0];
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

function registerYorishiroEnaiyoApp(sdk: HostSDK): void {
  sdk.app
    .command(nsid("com.etzhayyim.apps.yorishiroEnaiyo.createDraft"),
      (_ctx, body) => cmdCreateDraft(sdk, body),
      asAgentTool("Create an e-naiyo draft (sender/recipient/body). Validates 26 lines × 20 chars."),
      withCapabilityTags("enaiyo", "draft", "japanpost"),
    )
    .command(nsid("com.etzhayyim.apps.yorishiroEnaiyo.listDrafts"),
      (_ctx, body) => cmdListDrafts(sdk, body),
      asAgentTool("List e-naiyo drafts with pagination."),
      withCapabilityTags("enaiyo", "query"),
    )
    .command(nsid("com.etzhayyim.apps.yorishiroEnaiyo.getDraft"),
      (_ctx, body) => cmdGetDraft(sdk, body),
      asAgentTool("Get an e-naiyo draft by draftId."),
      withCapabilityTags("enaiyo", "query"),
    )
    .command(nsid("com.etzhayyim.apps.yorishiroEnaiyo.renderDocx"),
      (_ctx, body) => cmdRenderDocx(sdk, body),
      asAgentTool("Render a draft to a .docx using the official JP Post e-naiyo template (portrait-horizontal or landscape-vertical)."),
      withCapabilityTags("enaiyo", "docx", "render"),
    )
    .command(nsid("com.etzhayyim.apps.yorishiroEnaiyo.submitNaiyo"),
      (_ctx, body) => cmdSubmitNaiyo(sdk, body),
      asAgentTool("Submit a single e-naiyo draft to post.japanpost.jp via yorishiro-provider (requires confirm=true). Billable + legally binding."),
      withCapabilityTags("enaiyo", "submit", "browser-automation"),
      withOCELEvent("governance.audit"),
    )
    .command(nsid("com.etzhayyim.apps.yorishiroEnaiyo.submitBatch"),
      (_ctx, body) => cmdSubmitBatch(sdk, body),
      asAgentTool("Submit a batch of e-naiyo drafts (差込差出し mode). Accepts draftIds[] or CSV + template blobKeys. Requires confirm=true."),
      withCapabilityTags("enaiyo", "submit", "batch", "browser-automation"),
      withOCELEvent("governance.audit"),
    )
    .command(nsid("com.etzhayyim.apps.yorishiroEnaiyo.recordReceipt"),
      (_ctx, body) => cmdRecordReceipt(sdk, body),
      asAgentTool("Record a receipt (callback from yorishiro-provider after submission)."),
      withCapabilityTags("enaiyo", "receipt"),
    )
    .command(nsid("com.etzhayyim.apps.yorishiroEnaiyo.getStatus"),
      (_ctx, body) => cmdGetStatus(sdk, body),
      asAgentTool("Get submission status + receipt number for a draft or job."),
      withCapabilityTags("enaiyo", "query", "tracking"),
    );
}

export default createWorkerExport((sdk) => {
  appId = sdk.pds.selfNanoid ?? "";
  actorDID = sdk.pds.selfRepo ?? "";
  registerYorishiroEnaiyoApp(sdk);
});
