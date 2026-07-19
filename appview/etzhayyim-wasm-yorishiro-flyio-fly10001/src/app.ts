// TODO(ADR-2605111200 Phase 2, migration guide: 90-docs/2605111400-phase2-app-actor-dispatcher-migration-guide.md):
// 5 createKyselyDb callsites below throw WorkerDBProhibitedError at runtime.
// Replace each with `sdk.pds.xrpc("com.etzhayyim.apps.yorishiroFlyio.<method>", ...)`:
//   - getDb().selectFrom(tableForLabel(label))            → com.etzhayyim.apps.yorishiroFlyio.listJobs
//   - insertInto("vertex_yorishiroFlyio_cancellationJob") → com.etzhayyim.apps.yorishiroFlyio.putCancellationJob
//   - insertInto("vertex_yorishiroFlyio_appDeleteJob")    → com.etzhayyim.apps.yorishiroFlyio.putAppDeleteJob
//   - insertInto("vertex_yorishiroFlyio_orgDeleteJob")    → com.etzhayyim.apps.yorishiroFlyio.putOrgDeleteJob
//   - second cancellationJob INSERT (status update)       → com.etzhayyim.apps.yorishiroFlyio.updateCancellationStatus
// Each NSID needs a lexicon JSON in 00-contracts/lexicons/com/etzhayyim/apps/yorishiroFlyio/
// + a server-side handler (kotodama primitive or LangGraph node) + a vertex_bpmn_lexicon_binding row.
// Reference migration: etzhayyim-wasm-yorishiro-squarespace-sqddf3sp/src/app.ts (2026-05-11).
import {
  asAgentTool,
  createWorkerExport,
  createKyselyDb,
  decodeJson,
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
// Yorishiro — Fly.io 解約 adapter
//
// Reference: https://fly.io/dashboard
//
// Architecture:
//   handler (this worker)  = write-only: cancellationJob / appDeleteJob / orgDeleteJob records
//   yorishiro-provider     = Playwright Chromium → fly.io login + account closure flow
//   provider-vault         = email / password credentials
//
// Fly.io 解約フロー:
//   1. getAccountInfo    — ログイン + アカウント情報取得 (app 数, org 数, plan)
//   2. listApps          — 削除対象 app 一覧取得
//   3. deleteApp         — 個別 app 削除 (confirm=true 必須)
//   4. deleteOrg         — org 削除 (confirm=true + orgName 必須)
//   5. closeAccount      — アカウント完全閉鎖 (confirm=true + email 必須) [不可逆]
//
// Tier 1 Social: postAs() — 解約完了の公開 notification (opt-in)
// Tier 2 Domain: writeRecord() — cancellationJob / appDeleteJob / orgDeleteJob records
// Tier 3 State:  credentials = provider-vault のみ。public Repo に書かない
//
// Safety:
//   - 全破壊操作: confirm=true 必須
//   - closeAccount: confirm=true + email (二重確認) 必須
//   - RequireApproval(ClassA, 2, high) for closeAccount / deleteOrg
//   - RequireApproval(ClassB, 1, medium) for deleteApp
//   - 全操作: withOCELEvent("governance.audit")
// ---------------------------------------------------------------------------

let appId = "";
let actorDID = "";
type KyselyDb = ReturnType<typeof createKyselyDb>;
type AnyRow = Record<string, unknown>;
let db: KyselyDb | null = null;

const NSID = {
  cancellationJob: "com.etzhayyim.yorishiro.flyio.cancellationJob",
  appDeleteJob: "com.etzhayyim.yorishiro.flyio.appDeleteJob",
  orgDeleteJob: "com.etzhayyim.yorishiro.flyio.orgDeleteJob",
} as const;

const PROVIDER_DID = "did:web:yorishiro.etzhayyim.com";

// Fly.io dashboard URLs (browser automation entry points)
const FLYIO_SIGNIN = "https://fly.io/app/sign-in";
const FLYIO_DASHBOARD = "https://fly.io/dashboard";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FlyApp {
  name: string;
  org: string;
  status: string;
  region?: string;
}

interface FlyOrg {
  slug: string;
  name: string;
  type: "PERSONAL" | "SHARED";
}

interface AccountInfo {
  email: string;
  name: string;
  plan: string;
  orgs: FlyOrg[];
  apps: FlyApp[];
  creditCardLast4?: string;
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
    case "YorishiroFlyioCancellationJob":
      return "vertex_yorishiroFlyio_cancellationJob";
    case "YorishiroFlyioAppDeleteJob":
      return "vertex_yorishiroFlyio_appDeleteJob";
    case "YorishiroFlyioOrgDeleteJob":
      return "vertex_yorishiroFlyio_orgDeleteJob";
    default:
      throw new Error(`unknown yorishiro flyio label: ${label}`);
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

function invideProvider(sdk: HostSDK, method: string, params: object): void {
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

async function cmdGetAccountInfo(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.yorishiro.flyio.getAccountInfo", payload);
  const jobId = genID("flyInfoJob");

  invideProvider(sdk, "runBrowserSession", {
    sessionName: `flyio-info-${jobId}`,
    entryUrl: FLYIO_SIGNIN,
    flow: "flyio-get-account-info",
    jobId,
    vaultRef: req.vaultRef ?? "flyio/default",
  });

  const ownerDid = actorDID || "did:web:fly10001.etzhayyim.com";
  await getDb()
    .insertInto("vertex_yorishiroFlyio_cancellationJob" as any)
    .values({
      vertex_id: `at://${ownerDid}/com.etzhayyim.yorishiro.flyio.cancellationJob/${jobId}`,
      job_id: jobId,
      phase: "getAccountInfo",
      provider: PROVIDER_DID,
      entry_url: FLYIO_DASHBOARD,
      status: "pending",
      created_at: nowISO(),
      org_id: "anon",
      user_id: "anon",
      actor_id: appId,
      sensitivity_ord: 2,
      owner_did: ownerDid,
    })
    .execute();

  return { status: "queued", jobId, phase: "getAccountInfo" };
}

async function cmdListApps(_sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.yorishiro.flyio.listApps", payload);
  const offset = req.offset ?? 0;
  const limit = Math.min(req.limit ?? 50, 100);
  const rows = (await q("YorishiroFlyioAppDeleteJob", (row) => !req.orgSlug || String(row.orgSlug ?? "") === req.orgSlug))
    .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")))
    .slice(offset, offset + limit)
    .map((row) => ({
      appName: row.appName,
      orgSlug: row.orgSlug,
      status: row.status,
      createdAt: row.createdAt,
    }));
  return { apps: rows, offset, limit, total: rows.length };
}

async function cmdGetJobStatus(_sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.yorishiro.flyio.getJobStatus", payload);
  if (!req.jobId) return { error: "jobId is required" };
  const rows = await q("YorishiroFlyioCancellationJob", (row) => String(row.jobId ?? "") === req.jobId);
  if (rows.length === 0) return { status: "notFound" };
  return rows[0];
}

// ---------------------------------------------------------------------------
// Commands — App deletion (medium risk)
// ---------------------------------------------------------------------------

async function cmdDeleteApp(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.yorishiro.flyio.deleteApp", payload);

  if (!req.appName) return { error: "appName is required" };
  if (!req.confirm) {
    return {
      error: "confirm=true is required. App deletion is irreversible — all resources and data will be permanently destroyed.",
      appName: req.appName,
    };
  }

  const jobId = genID("flyAppDel");

  invideProvider(sdk, "runBrowserSession", {
    sessionName: `flyio-app-del-${jobId}`,
    entryUrl: FLYIO_SIGNIN,
    flow: "flyio-delete-app",
    jobId,
    appName: req.appName,
    orgSlug: req.orgSlug ?? "",
    vaultRef: req.vaultRef ?? "flyio/default",
  });

  const ownerDid = actorDID || "did:web:fly10001.etzhayyim.com";
  await getDb()
    .insertInto("vertex_yorishiroFlyio_appDeleteJob" as any)
    .values({
      vertex_id: `at://${ownerDid}/com.etzhayyim.yorishiro.flyio.appDeleteJob/${jobId}`,
      job_id: jobId,
      app_name: req.appName,
      org_slug: req.orgSlug ?? "",
      provider: PROVIDER_DID,
      status: "pending",
      created_at: nowISO(),
      org_id: "anon",
      user_id: "anon",
      actor_id: appId,
      sensitivity_ord: 2,
      owner_did: ownerDid,
    })
    .execute();

  postAs(sdk, actorDID, `Fly.io app 削除ジョブ作成: ${req.appName} → ${jobId}`);
  return { status: "jobQueued", jobId, appName: req.appName };
}

// ---------------------------------------------------------------------------
// Commands — Org deletion (high risk)
// ---------------------------------------------------------------------------

async function cmdDeleteOrg(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.yorishiro.flyio.deleteOrg", payload);

  if (!req.orgSlug) return { error: "orgSlug is required" };
  if (!req.orgName) return { error: "orgName is required (二重確認: org の表示名を入力してください)" };
  if (!req.confirm) {
    return {
      error: "confirm=true is required. Org deletion is irreversible — all apps and resources in the org will be destroyed.",
      orgSlug: req.orgSlug,
    };
  }

  const jobId = genID("flyOrgDel");

  invideProvider(sdk, "runBrowserSession", {
    sessionName: `flyio-org-del-${jobId}`,
    entryUrl: FLYIO_SIGNIN,
    flow: "flyio-delete-org",
    jobId,
    orgSlug: req.orgSlug,
    orgName: req.orgName,
    vaultRef: req.vaultRef ?? "flyio/default",
  });

  const ownerDid = actorDID || "did:web:fly10001.etzhayyim.com";
  await getDb()
    .insertInto("vertex_yorishiroFlyio_orgDeleteJob" as any)
    .values({
      vertex_id: `at://${ownerDid}/com.etzhayyim.yorishiro.flyio.orgDeleteJob/${jobId}`,
      job_id: jobId,
      org_slug: req.orgSlug,
      org_name: req.orgName,
      provider: PROVIDER_DID,
      status: "pending",
      created_at: nowISO(),
      org_id: "anon",
      user_id: "anon",
      actor_id: appId,
      sensitivity_ord: 2,
      owner_did: ownerDid,
    })
    .execute();

  postAs(sdk, actorDID, `Fly.io org 削除ジョブ作成: ${req.orgSlug} → ${jobId}`);
  return { status: "jobQueued", jobId, orgSlug: req.orgSlug };
}

// ---------------------------------------------------------------------------
// Commands — Account closure / 解約 (highest risk, irreversible)
// ---------------------------------------------------------------------------

async function cmdCloseAccount(sdk: HostSDK, payload: Uint8Array): Promise<unknown> {
  const req = parseLexiconInput("com.etzhayyim.yorishiro.flyio.closeAccount", payload);

  if (!req.email) {
    return {
      error: "email is required (二重確認: アカウントに登録したメールアドレスを入力してください)",
    };
  }
  if (!req.confirm) {
    return {
      error: "confirm=true is required. Account closure is permanent and irreversible — all apps, orgs, data, and billing will be permanently destroyed.",
      email: req.email,
    };
  }

  const jobId = genID("flyAccClose");

  invideProvider(sdk, "runBrowserSession", {
    sessionName: `flyio-close-${jobId}`,
    entryUrl: FLYIO_SIGNIN,
    flow: "flyio-close-account",
    jobId,
    email: req.email,
    deleteAllAppsFirst: req.deleteAllAppsFirst ?? false,
    vaultRef: req.vaultRef ?? "flyio/default",
  });

  const ownerDid = actorDID || "did:web:fly10001.etzhayyim.com";
  await getDb()
    .insertInto("vertex_yorishiroFlyio_cancellationJob" as any)
    .values({
      vertex_id: `at://${ownerDid}/com.etzhayyim.yorishiro.flyio.cancellationJob/${jobId}`,
      job_id: jobId,
      phase: "closeAccount",
      email: req.email,
      delete_all_apps_first: req.deleteAllAppsFirst ?? false,
      provider: PROVIDER_DID,
      entry_url: FLYIO_SIGNIN,
      status: "pending",
      created_at: nowISO(),
      org_id: "anon",
      user_id: "anon",
      actor_id: appId,
      sensitivity_ord: 2,
      owner_did: ownerDid,
    })
    .execute();

  postAs(sdk, actorDID, `Fly.io アカウント解約ジョブ作成: ${req.email} → ${jobId}`);
  return {
    status: "jobQueued",
    jobId,
    phase: "closeAccount",
    warning: "This operation is irreversible. The browser session will navigate to fly.io settings and close the account.",
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

function registerYorishiroFlyioApp(sdk: HostSDK): void {
  sdk.app
    // ── Query ──────────────────────────────────────────────────────────────
    .command(nsid("com.etzhayyim.yorishiro.flyio.getAccountInfo"),
      (_ctx, body) => cmdGetAccountInfo(sdk, body),
      asAgentTool("Login to fly.io via browser and retrieve account info (email, plan, orgs, apps, billing). Credentials are fetched from provider-vault."),
      withCapabilityTags("flyio", "account", "query", "browser-automation"),
    )
    .command(nsid("com.etzhayyim.yorishiro.flyio.listApps"),
      (_ctx, body) => cmdListApps(sdk, body),
      asAgentTool("List previously recorded Fly.io app deletion jobs with pagination. Use getAccountInfo first to populate via browser."),
      withCapabilityTags("flyio", "app", "query"),
    )
    .command(nsid("com.etzhayyim.yorishiro.flyio.getJobStatus"),
      (_ctx, body) => cmdGetJobStatus(sdk, body),
      asAgentTool("Get the status of a Fly.io cancellation/deletion job by jobId."),
      withCapabilityTags("flyio", "query", "tracking"),
    )
    // ── Destructive — App ──────────────────────────────────────────────────
    .command(nsid("com.etzhayyim.yorishiro.flyio.deleteApp"),
      (_ctx, body) => cmdDeleteApp(sdk, body),
      asAgentTool("Delete a Fly.io app via browser automation (requires confirm=true). All app resources and data are permanently destroyed."),
      withCapabilityTags("flyio", "app", "delete", "browser-automation"),
      withOCELEvent("governance.audit"),
      requireApproval({ class: "B", count: 1, level: "medium" }),
    )
    // ── Destructive — Org ──────────────────────────────────────────────────
    .command(nsid("com.etzhayyim.yorishiro.flyio.deleteOrg"),
      (_ctx, body) => cmdDeleteOrg(sdk, body),
      asAgentTool("Delete a Fly.io organization via browser automation (requires confirm=true + orgName for double-confirmation). All apps in the org are destroyed."),
      withCapabilityTags("flyio", "org", "delete", "browser-automation"),
      withOCELEvent("governance.audit"),
      requireApproval({ class: "A", count: 2, level: "high" }),
    )
    // ── Destructive — Account closure / 解約 ──────────────────────────────
    .command(nsid("com.etzhayyim.yorishiro.flyio.closeAccount"),
      (_ctx, body) => cmdCloseAccount(sdk, body),
      asAgentTool("Permanently close (解約) a Fly.io account via browser automation (requires confirm=true + registered email for double-confirmation). Irreversible — all apps, orgs, billing, and data are permanently destroyed."),
      withCapabilityTags("flyio", "account", "close", "cancellation", "browser-automation"),
      withOCELEvent("governance.audit"),
      requireApproval({ class: "A", count: 2, level: "high" }),
    );
}

export default createWorkerExport((sdk) => {
  appId = sdk.pds.selfNanoid ?? "";
  actorDID = sdk.pds.selfRepo ?? "";
  registerYorishiroFlyioApp(sdk);
});
