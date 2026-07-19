import {
  createWorkerExport,
  nowISO,
  type HostSDK,
} from "@etzhayyim/kotodama-host-sdk";

// ADR-2605111200 Phase 2 migration (2026-05-11): CF Worker は edge-only。
// Domain writes/reads は bpmn-dispatcher → LangGraph/LangGraph/pod 経由で dispatch する。
// 旧 createKyselyDb / env.HYPERDRIVE 直書きは禁止 (WorkerDBProhibitedError throw)。

const NSID = {
  // Reactive input — sqExporter follows cfRegistrar の transferRequest commits.
  transferRequest: "com.etzhayyim.dns.transferRequest",
  // ADR-2605111200 procedure NSIDs (server-side handlers in kotodama).
  putTransferStep: "com.etzhayyim.dns.putTransferStep",
  getTransferRequest: "com.etzhayyim.dns.getTransferRequest",
  putTransferOutcome: "com.etzhayyim.dns.putTransferOutcome",
} as const;

const SQ_EXPORTER_PATH = "actor:sqExporter";
const SQ_EXPORTER_DID = "did:web:sqddf3sp.etzhayyim.com:actor:sqExporter";
const CF_REGISTRAR_DID = "did:web:scndu0rf.etzhayyim.com:actor:cfRegistrar";

const TRANSFER_STEPS = ["disableAutoRenew", "unlock", "authCode", "dnsExport", "cfTransfer"] as const;
type StepName = (typeof TRANSFER_STEPS)[number];

let bootstrapped = false;

async function ensureActor(sdk: HostSDK): Promise<void> {
  if (bootstrapped) return;
  const existing = await sdk.did.list();
  if (!existing.some((d) => d.did === SQ_EXPORTER_DID)) {
    await sdk.did.create(SQ_EXPORTER_PATH, {
      displayName: "Squarespace Exporter",
      description: "Browser-automation agent releasing domains from Squarespace for transfer.",
      isBot: true,
      agentType: "semi-autonomous",
    });
  }
  await sdk.pds.dispatch({
    type: "app.bsky.graph.follow",
    did: SQ_EXPORTER_DID,
    subject: CF_REGISTRAR_DID,
  }).catch(() => { /* idempotent: already following */ });
  bootstrapped = true;
}

async function emitStep(
  sdk: HostSDK,
  transferRequestUri: string,
  step: StepName,
  status: "started" | "succeeded" | "failed",
  extra: { errorMessage?: string; bindZoneFileUri?: string; cfTransferId?: string } = {},
): Promise<void> {
  const rkey = `${step}-${Date.now().toString(36)}`;
  await sdk.pds.xrpc(NSID.putTransferStep, {
    rkey,
    transferRequestUri,
    step,
    status,
    actorDid: SQ_EXPORTER_DID,
    occurredAt: nowISO(),
    errorMessage: extra.errorMessage,
    bindZoneFileUri: extra.bindZoneFileUri,
    cfTransferId: extra.cfTransferId,
  });
}

export default createWorkerExport(async (sdk) => {
  await ensureActor(sdk);

  sdk.app.onCommit(async (commit) => {
    if (commit.action !== "create") return;
    if (commit.collection !== NSID.transferRequest) return;

    const result = await sdk.pds.xrpc(NSID.getTransferRequest, { rkey: commit.rkey }) as { request?: { domain?: string; status?: string } } | null;
    const reqRow = result?.request;
    if (!reqRow) return;
    const domain = reqRow.domain;
    const status = reqRow.status;
    if (!domain || status !== "approved") return;
    const transferRequestUri = `at://${commit.repo}/${commit.collection}/${commit.rkey}`;

    // 5-step release workflow. Each step runs browser automation via HEADLESS_BROWSER binding,
    // except cfTransfer which is an outbound API call to Cloudflare.
    let authCodePlaintext = "";
    for (const step of TRANSFER_STEPS) {
      if (step === "cfTransfer") break;
      await emitStep(sdk, transferRequestUri, step, "started");
      try {
        const extra: { bindZoneFileUri?: string } = {};
        if (step === "authCode") {
          authCodePlaintext = await getAuthCodeFromSquarespace(domain);
        }
        if (step === "dnsExport") {
          extra.bindZoneFileUri = await exportBindZoneFile(sdk, domain);
        }
        await emitStep(sdk, transferRequestUri, step, "succeeded", extra);
      } catch (err) {
        await emitStep(sdk, transferRequestUri, step, "failed", {
          errorMessage: (err as Error).message,
        });
        await emitOutcome(sdk, transferRequestUri, domain, "failure", `${step} failed: ${(err as Error).message}`);
        return;
      }
    }

    // Step 5: Cloudflare Registrar API transfer-in.
    await emitStep(sdk, transferRequestUri, "cfTransfer", "started");
    const outcome = await runCloudflareTransferIn(sdk, domain, authCodePlaintext);
    if (outcome.ok) {
      await emitStep(sdk, transferRequestUri, "cfTransfer", "succeeded", { cfTransferId: outcome.transferId ?? "" });
      await emitOutcome(sdk, transferRequestUri, domain, "success", "", outcome.zoneId);
    } else {
      await emitStep(sdk, transferRequestUri, "cfTransfer", "failed", { errorMessage: outcome.error });
      await emitOutcome(sdk, transferRequestUri, domain, "failure", `Cloudflare API: ${outcome.error}`);
    }
  });
});

async function emitOutcome(
  sdk: HostSDK,
  transferRequestUri: string,
  domain: string,
  result: "success" | "failure" | "aborted",
  failureReason = "",
  cloudflareZoneId = "",
): Promise<void> {
  const slug = domain.replace(/\./g, "_");
  const zoneDid = result === "success" ? `did:web:dns.etzhayyim.com:zone:${slug}` : undefined;
  const outcomeRkey = `outcome-${Date.now().toString(36)}`;
  await sdk.pds.xrpc(NSID.putTransferOutcome, {
    rkey: outcomeRkey,
    transferRequestUri,
    domain,
    result,
    zoneDid,
    cloudflareZoneId: cloudflareZoneId || undefined,
    failureReason: failureReason || undefined,
    completedAt: nowISO(),
  });
}

interface CfTransferResult {
  ok: boolean;
  zoneId?: string;
  transferId?: string;
  error?: string;
}

async function runCloudflareTransferIn(sdk: HostSDK, domain: string, authCode: string): Promise<CfTransferResult> {
  if (!authCode) return { ok: false, error: "empty authCode" };
  const tokenBinding = sdk.env?.SS_CLOUDFLARE_REGISTRAR_API_TOKEN as { get?: () => Promise<string> } | string | undefined;
  const accountId = typeof sdk.env?.CLOUDFLARE_ACCOUNT_ID === "string" ? (sdk.env.CLOUDFLARE_ACCOUNT_ID as string) : "";
  let token = "";
  if (typeof tokenBinding === "string") token = tokenBinding;
  else if (tokenBinding?.get) token = await tokenBinding.get();
  if (!token || !accountId) return { ok: false, error: "SS_CLOUDFLARE_REGISTRAR_API_TOKEN or CLOUDFLARE_ACCOUNT_ID binding missing" };

  try {
    const resp = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/registrar/domains/${domain}/transfer`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ auth_code: authCode }),
      },
    );
    const body = (await resp.json().catch(() => ({}))) as {
      success?: boolean;
      result?: { zone_id?: string; id?: string };
      errors?: Array<{ message?: string }>;
    };
    if (!resp.ok || !body.success) {
      return { ok: false, error: body.errors?.[0]?.message ?? `HTTP ${resp.status}` };
    }
    return { ok: true, zoneId: body.result?.zone_id, transferId: body.result?.id };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

async function getAuthCodeFromSquarespace(_domain: string): Promise<string> {
  // TODO: browser automation — navigate to domains.squarespace.com, request EPP code.
  throw new Error("not implemented");
}

async function exportBindZoneFile(_sdk: HostSDK, _domain: string): Promise<string> {
  // TODO: browser automation — read DNS records, serialize to BIND zone file, upload to R2, return URI.
  throw new Error("not implemented");
}
