/**
 * XRPC invoke handler: routes yorishiro-provider invoke events to the
 * japanpost-enaiyo flow. Listens on a simple HTTP endpoint; wire-up to
 * w-protocol invoke stream is left to the provider main loop.
 *
 * Reads credentials from provider-vault at:
 *   secret/data/orgs/{orgId}/users/{userId}/services/japanpost-enaiyo/primary
 *
 * Calls back via XRPC:
 *   POST https://jp4n41y0.etzhayyim.com/xrpc/com.etzhayyim.apps.yorishiroEnaiyo.recordReceipt
 */

import { runJapanpostEnaiyoSingle, runJapanpostEnaiyoBatch, type EnaiyoCredentials } from "./flow.js";

const ENAIYO_APP_BASE = "https://jp4n41y0.etzhayyim.com";
const VAULT_URL = process.env.VAULT_URL ?? "http://vault:8200";
const VAULT_TOKEN = process.env.VAULT_TOKEN ?? "";

async function vaultGet(path: string): Promise<Record<string, string>> {
  const r = await fetch(`${VAULT_URL}/v1/${path}`, {
    headers: { "X-Vault-Token": VAULT_TOKEN },
  });
  if (!r.ok) throw new Error(`vault get ${path} failed: ${r.status}`);
  const j = (await r.json()) as { data: { data: Record<string, string> } };
  return j.data.data;
}

async function loadCredentials(orgId: string, userId: string): Promise<EnaiyoCredentials> {
  const path = `secret/data/orgs/${orgId}/users/${userId}/services/japanpost-enaiyo/primary`;
  const raw = await vaultGet(path);
  if (raw.method !== "kouno" && raw.method !== "creditCard") {
    throw new Error(`japanpost-enaiyo: method must be 'kouno' or 'creditCard'`);
  }
  return raw as unknown as EnaiyoCredentials;
}

async function recordReceipt(params: {
  jobId: string;
  draftId: string;
  receiptNumber: string;
  receiptPdfBlobKey: string;
  sessionToken: string;
}): Promise<void> {
  const r = await fetch(`${ENAIYO_APP_BASE}/xrpc/com.etzhayyim.apps.yorishiroEnaiyo.recordReceipt`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.sessionToken}`,
    },
    body: JSON.stringify({
      jobId: params.jobId,
      draftId: params.draftId,
      receiptNumber: params.receiptNumber,
      receiptPdfBlobKey: params.receiptPdfBlobKey,
      submittedAt: new Date().toISOString(),
    }),
  });
  if (!r.ok) throw new Error(`recordReceipt failed: ${r.status} ${await r.text()}`);
}

export interface InvokeEvent {
  method:
    | "runBrowserSession"
    | "renderEnaiyoDocx";
  params: {
    flow?: "japanpost-enaiyo-single" | "japanpost-enaiyo-batch";
    sessionName: string;
    jobId?: string;
    batchId?: string;
    draftId?: string;
    docxPath?: string;
    csvBlobKey?: string;
    templateBlobKey?: string;
  };
  authority: { orgId: string; userId: string; sessionToken: string };
}

export async function handleInvoke(evt: InvokeEvent): Promise<void> {
  if (evt.method !== "runBrowserSession") {
    throw new Error(`unsupported method ${evt.method}`);
  }
  const creds = await loadCredentials(evt.authority.orgId, evt.authority.userId);

  if (evt.params.flow === "japanpost-enaiyo-single") {
    if (!evt.params.jobId || !evt.params.draftId || !evt.params.docxPath) {
      throw new Error("japanpost-enaiyo-single requires jobId, draftId, docxPath");
    }
    // sender/recipient/docx resolved from draft record via graph query (stub)
    const draft = await resolveDraft(evt.params.draftId);
    const result = await runJapanpostEnaiyoSingle({
      sessionName: evt.params.sessionName,
      jobId: evt.params.jobId,
      draftId: evt.params.draftId,
      sender: draft.sender,
      recipient: draft.recipient,
      docxPath: evt.params.docxPath,
      credentials: creds,
    });
    if (!result.ok) throw new Error(`submit failed: ${result.error}`);
    const blobKey = await uploadPdfToR2(result.receiptPdfPath!);
    await recordReceipt({
      jobId: evt.params.jobId,
      draftId: evt.params.draftId,
      receiptNumber: result.receiptNumber!,
      receiptPdfBlobKey: blobKey,
      sessionToken: evt.authority.sessionToken,
    });
    return;
  }

  if (evt.params.flow === "japanpost-enaiyo-batch") {
    if (!evt.params.batchId || !evt.params.csvBlobKey || !evt.params.templateBlobKey) {
      throw new Error("japanpost-enaiyo-batch requires batchId, csvBlobKey, templateBlobKey");
    }
    const csvPath = await downloadFromR2(evt.params.csvBlobKey);
    const templatePath = await downloadFromR2(evt.params.templateBlobKey);
    const result = await runJapanpostEnaiyoBatch({
      sessionName: evt.params.sessionName,
      batchId: evt.params.batchId,
      csvPath,
      templateDocxPath: templatePath,
      credentials: creds,
    });
    if (!result.ok) throw new Error(`batch submit failed: ${result.error}`);
    return;
  }

  throw new Error(`unknown flow ${evt.params.flow}`);
}

// ---- stubs (provider framework-dependent) ----

async function resolveDraft(_draftId: string): Promise<{ sender: any; recipient: any }> {
  throw new Error("resolveDraft not implemented — query com.etzhayyim.apps.yorishiroEnaiyo.draftNaiyo by draftId");
}
async function uploadPdfToR2(_path: string): Promise<string> {
  throw new Error("uploadPdfToR2 not implemented — use cdn package SigV4 to etzhayyim-cdn bucket");
}
async function downloadFromR2(_blobKey: string): Promise<string> {
  throw new Error("downloadFromR2 not implemented — fetch from etzhayyim-cdn bucket to /tmp");
}
