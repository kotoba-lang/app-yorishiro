# etzhayyim-project-yorishiro

Apify-inspired web service browser automation platform.
**Yorishiro (依り代)** — a vessel/medium that channels external web services into the etzhayyim.com platform via Playwright.

## Architecture

```
Browser / AI Agent
  └─ MCP/XRPC → {nanoid}.etzhayyim.com/xrpc
       └─ App: yorishiro-{service} (TS Native)
                 │
                 ├─ exports etzhayyim:yorishiro-{service}/* (typed service interface)
                 │
                 ├─ [Browser adapters] XRPC → yorishiro-provider (native Go, Playwright)
                 │         └─ Chromium browser pool
                 │              └─ google.com / microsoft.com / aws / x.com / linkedin.com
                 │
                 └─ [API adapters] imports etzhayyim:provider-vault/credentials + wasi:http
                      ├─ provider-vault-provider (native Go, HashiCorp Vault)
                      │    └─ secret/data/orgs/{org}/users/{user}/services/{service}/{key}
                      └─ TrafficStars REST API (https://api.trafficstars.com)
```

## Components

| Component | nanoid | Type | WIT World | Description |
|---|---|---|---|---|
| yorishiro-provider | — | native Go provider | `etzhayyim-yorishiro-provider` | Playwright Chromium pool, session persistence, auth helpers |
| yorishiro-google | `g00gl3ws` | TS Native | `etzhayyim-yorishiro-google-provider` | Google Search, Gmail, Drive, Calendar |
| yorishiro-microsoft | `m5ftws0t` | TS Native | `etzhayyim-yorishiro-microsoft-provider` | Outlook, OneDrive, Teams |
| yorishiro-aws | `4w5c0n5l` | TS Native | `etzhayyim-yorishiro-aws-provider` | AWS Console, EC2, S3, CloudWatch, IAM |
| yorishiro-x | `x7w1tt3r` | TS Native | `etzhayyim-yorishiro-x-provider` | Timeline, Compose, Profile, DM, Notifications |
| yorishiro-linkedin | `l1nk3d1n` | TS Native | `etzhayyim-yorishiro-linkedin-provider` | Feed, Profile, Messaging, Jobs |
| yorishiro-mufg-card | `mufgcrd1` | TS Native | `etzhayyim-yorishiro-mufg-card-provider` | MUFG Card public site, notices, member portal |
| yorishiro-trafficstars | `tr4f1c5t` | TS Native | `etzhayyim-yorishiro-trafficstars-provider` | Ad delivery: Sites, Spots, Statistics, Ad Tags |
| yorishiro-humeai-voice | `humev01c` | TS Native | `etzhayyim-yorishiro-humeai-voice-provider` | HumeAI TTS voice generation for read-aloud |
| yorishiro-mturk | `m7turk01` | TS Native | `etzhayyim-yorishiro-mturk-provider` | Amazon Mechanical Turk Requester API (HIT + assignment lifecycle) |
| yorishiro-marqeta | `m4rq3t4` | TS Native | `etzhayyim-yorishiro-marqeta-provider` | Marqeta card issuing API (users/cards/GPA/transactions) |
| yorishiro-1password | `1p4ssw0d` | TS Native | `etzhayyim-yorishiro-1password-provider` | 1Password Connect Server API (vaults/items/files CRUD) |
| yorishiro-squarespace | `sqddf3sp` | TS Native | `etzhayyim-yorishiro-squarespace-provider` | Squarespace domain management, transfer, DNS export (browser automation). Exposes sub-actor DID `did:web:sqddf3sp.etzhayyim.com:actor:sqExporter` that follows `did:web:scndu0rf.etzhayyim.com:actor:cfRegistrar` and drives the 5-step transfer-to-Cloudflare workflow. See `60-apps/etzhayyim-project-dns/CLAUDE.md` §Project Actor Composition |
| yorishiro-japanpost-enaiyo | `jp4n41y0` | TS Native | `etzhayyim-yorishiro-japanpost-enaiyo-provider` | 日本郵便 Webゆうびん 電子内容証明 (e-naiyo) — draft/submit/receipt/tracking via post.japanpost.jp |
| yorishiro-flyio | `fly10001` | TS Native | `etzhayyim-yorishiro-flyio-provider` | Fly.io アカウント管理・解約 — getAccountInfo / deleteApp / deleteOrg / closeAccount via fly.io dashboard |
| yorishiro-nuro | `nur0cb01` | TS Native | `etzhayyim-yorishiro-nuro-provider` | NURO 光 (Sony Network Communications) MyPage キャッシュバック受取 — listOffers / claimCashback / getClaimStatus via www.nuro.jp/app/mypage |
| provider-vault-provider | — | native Go provider | `etzhayyim-provider-vault-provider` | HashiCorp Vault KV v2, credential storage per user/org |

### Crypto Exchange Compliance Agents (API-based, W Protocol cross-actor)

Fraud/theft incident response agents — freeze requests, account inquiry, tx tracing, law enforcement coordination.
Integrated with `crypto-asset-freeze` (APQC 11.3) + `lawfirm.etzhayyim.com` via cross-actor.

| Component | nanoid | Jurisdiction | Exchange |
|---|---|---|---|
| yorishiro-binance | `b1n4nc3x` | global | Binance |
| yorishiro-coinbase | `c01nb4s3` | US | Coinbase |
| yorishiro-kraken | `kr4k3n01` | US | Kraken |
| yorishiro-bybit | `byb1t001` | UAE | Bybit |
| yorishiro-okx | `0kx3xch1` | global | OKX |
| yorishiro-kucoin | `kuc01n01` | Seychelles | KuCoin |
| yorishiro-gemini | `g3m1n101` | US | Gemini |
| yorishiro-cryptocom | `crypt0cm` | Singapore | Crypto.com |
| yorishiro-gateio | `g4t310x1` | Cayman | Gate.io |
| yorishiro-bitget | `b1tg3t01` | Seychelles | Bitget |
| yorishiro-bitflyer | `b1tfly3r` | JP | bitFlyer |
| yorishiro-coincheck | `c01nch3k` | JP | Coincheck |
| yorishiro-bitbank | `b1tb4nk1` | JP | bitbank |
| yorishiro-zaif | `z41f0001` | JP | Zaif |
| yorishiro-gmocoin | `gm0c01n1` | JP | GMO Coin |
| yorishiro-sbivc | `sb1vct01` | JP | SBI VC Trade |
| yorishiro-rakutenwallet | `r4kut3nw` | JP | Rakuten Wallet |
| yorishiro-upbit | `upb1t001` | KR | Upbit |
| yorishiro-bithumb | `b1thum8x` | KR | Bithumb |

**Each agent provides**: `submit_freeze_request`, `check_freeze_status`, `request_account_inquiry`, `request_tx_history`, `get_compliance_contact`, `request_withdrawal_block`, `list_requests`
**Governance**: `RequireApproval(ClassA, 3, high)` for freeze/withdrawal block, `RequireApproval(ClassB, 2, medium)` for inquiries
**Graph nodes**: `ExchangeFreezeRequest`, `ExchangeAccountInquiry`, `ExchangeTxHistoryRequest`, `ExchangeWithdrawalBlock`

## WIT Interface Map

### Core (etzhayyim:yorishiro@0.1.0)
| Interface | Description |
|---|---|
| `browser` | Low-level page automation: navigate, click, type, wait, extract, screenshot, cookies, JS eval |
| `session-store` | Session state persistence: save/restore authenticated sessions (KV-backed, user-scoped) |
| `auth` | Auth flow helpers: OAuth 2.0 login, form-based login, auth check |

### Per-Service
| Package | Interfaces |
|---|---|
| `etzhayyim:yorishiro-google@0.1.0` | `search`, `gmail`, `drive`, `calendar` |
| `etzhayyim:yorishiro-microsoft@0.1.0` | `outlook`, `onedrive`, `teams` |
| `etzhayyim:yorishiro-aws@0.1.0` | `console`, `ec2`, `s3`, `cloudwatch`, `iam` |
| `etzhayyim:yorishiro-x@0.1.0` | `timeline`, `compose`, `profile`, `dm`, `notifications` |
| `etzhayyim:yorishiro-linkedin@0.1.0` | `feed`, `profile`, `messaging`, `jobs` |
| `etzhayyim:yorishiro-mufg-card@0.1.0` | `public-site`, `notices`, `member-portal` |
| `etzhayyim:yorishiro-trafficstars@0.1.0` | `sites`, `spots`, `statistics`, `account` |
| `etzhayyim:yorishiro-humeai-voice@0.1.0` | `voice` |
| `etzhayyim:yorishiro-mturk@0.1.0` | `hit-command`, `hit-query`, `assignment-command`, `assignment-query`, `account` |
| `etzhayyim:yorishiro-marqeta@0.1.0` | `user-command`, `user-query`, `card-command`, `card-query`, `gpa`, `transaction-query` |
| `etzhayyim:yorishiro-1password@0.1.0` | `vault-query`, `item-query`, `item-command`, `file-query` |
| `etzhayyim:yorishiro-squarespace@0.1.0` | `domains`, `transfer`, `dns-export` |
| `etzhayyim:yorishiro-japanpost-enaiyo@0.1.0` | `draft`, `submit`, `receipt`, `tracking` |
| `etzhayyim:yorishiro-flyio@0.1.0` | `account`, `app`, `org`, `cancellation` |
| `etzhayyim:yorishiro-nuro@0.1.0` | `offers`, `cashback` (claim + tracking) |
| `etzhayyim:provider-vault@0.1.0` | `credentials` (put/get/delete/list, per-service, user/org scoped) |

## Service Topology

```
yorishiro-provider (native Go, Playwright)
  ← XRPC from:
  ├── yorishiro-google App
  ├── yorishiro-microsoft App
  ├── yorishiro-aws App
  ├── yorishiro-x App
  ├── yorishiro-linkedin App
  ├── yorishiro-mufg-card App
  ├── yorishiro-humeai-voice App
  ├── yorishiro-mturk App
  ├── yorishiro-marqeta App
  ├── yorishiro-flyio App
  └── yorishiro-nuro App

yorishiro-1password App (API-based, no Playwright)
  └─ calls 1Password Connect Server API (wasi:http/outgoing-handler)

provider-vault-provider (native Go, HashiCorp Vault)
  ← XRPC from:
  └── yorishiro-trafficstars App
       ├─ calls provider-vault (API token storage)
       ├─ calls TrafficStars REST API (wasi:http/outgoing-handler)
```

## Provider Design (Native Go)

The `yorishiro-provider` is a native Go binary (not TS Native) because:
1. Playwright requires OS-level Chromium binary + CDP protocol
2. Browser pool management needs concurrent goroutines
3. Session serialization uses `regexp` + `crypto` (TS Native では制約なし)

Key design decisions:
- **Browser pool**: Fixed pool size (configurable, default 5 contexts)
- **Session isolation**: Each `create-session` creates a separate BrowserContext
- **Session persistence**: Cookies + localStorage serialized to NATS KV, encrypted with user key-bundle
- **Anti-bot**: Stealth mode (navigator.webdriver=false, realistic user-agent rotation)
- **Timeout**: Default 30s per operation, configurable per-request
- **Cleanup**: Idle session GC (5 min inactivity → auto-close)

## KV Key Layout

```
pf.yorishiro.sessions.{user-id}.{session-name}     # Serialized session state
pf.yorishiro.sessions.{user-id}._list               # Session name list
pf.{nanoid}.s.{key}                                 # Per-component global state
pf.{nanoid}.u.{user-id}.s.{key}                     # Per-user state
```

## Adding a New Web Service

1. Create WIT: `60-apps/etzhayyim-project-yorishiro/wit/yorishiro-{service}/package.wit`
2. Add world: Append `etzhayyim-yorishiro-{service}-provider` to `etzhayyim-component.wit`
3. Add imports to `etzhayyim-component` world
4. Create component dir: `60-apps/etzhayyim-project-yorishiro/wasm/etzhayyim-wasm-yorishiro-{service}-{nanoid}/`
5. Create `wit/world.wit`, `kotodama.jsonld`, `deploy config`
6. Implement service-specific navigation logic in `src/app.ts`
7. Configure K8s Service → yorishiro-provider connectivity

## TrafficStars Adapter (API-based, not Playwright)

Unlike other yorishiro adapters that use Playwright browser automation, the TrafficStars adapter
uses the TrafficStars REST API directly. This is because:
1. TrafficStars has a well-defined REST API (no need for browser automation)
2. Publisher operations (site/spot CRUD, statistics) are all API-accessible
3. API token auth is simpler and more reliable than browser-based auth

### Credential Storage (Provider Vault)

The TrafficStars adapter stores API tokens via `etzhayyim:provider-vault/credentials`:

| Service | Key | Scope | Description |
|---|---|---|---|
| `trafficstars` | `api_token` | personal/shared | TrafficStars API Bearer token |
| `trafficstars` | `account_id` | personal/shared | TrafficStars account identifier |

Vault path: `secret/data/orgs/{org_id}/users/{user_id}/services/trafficstars/api_token`

### MCP Tools

| Tool | Description |
|---|---|
| `trafficstars.site.create` | Create a publisher site |
| `trafficstars.site.list` | List publisher sites |
| `trafficstars.site.get` | Get a single site by ID |
| `trafficstars.site.update` | Update a publisher site |
| `trafficstars.site.delete` | Delete sites by IDs |
| `trafficstars.spot.create` | Create an ad spot on a site |
| `trafficstars.spot.list` | List ad spots (filterable by site) |
| `trafficstars.spot.get` | Get a single spot by ID |
| `trafficstars.spot.update` | Update an ad spot |
| `trafficstars.spot.delete` | Delete spots by IDs |
| `trafficstars.spot.get_tag` | Get ad tag snippets (display JS, VAST, direct URL) |
| `trafficstars.spot.create_master` | Create a master spot (auto-format) |
| `trafficstars.stats.query` | Query publisher statistics |
| `trafficstars.account.health` | Health check (API connectivity) |
| `trafficstars.account.balance` | Get publisher balance / payout status |
| `trafficstars.credential.set` | Store TrafficStars API token in vault |
| `trafficstars.credential.check` | Check if API token is configured |

### Ad Tag Integration

```html
<!-- Direct ad tag -->
<script src="https://tsyndicate.com/api/v1/direct/{spot_id}"></script>

<!-- With subid and categories -->
<script src="https://tsyndicate.com/api/v1/direct/{spot_id}?subid=foo&categories=keyword1,keyword2"></script>
```

## Provider Vault Design (Native Go)

The `provider-vault-provider` is a native Go binary wrapping HashiCorp Vault KV v2.
It enables any wasm component to securely store and retrieve external service credentials.

### Why Native Go Provider

1. HashiCorp Vault SDK requires `crypto/tls` + `net/http` (TS Native では制約なし)
2. Vault token management needs background renewal goroutines
3. AppRole authentication uses `regexp` for path validation

### Vault Path Design

```
secret/data/orgs/{org_id}/users/{user_id}/services/{service}/{key}   # Personal
secret/data/orgs/{org_id}/shared/services/{service}/{key}             # Shared
```

### Security Model

- Provider holds Vault AppRole credentials (not passed to components)
- AT Protocol session claims (user_id, org_id) validated before every read/write
- Path-based authorization: personal items require matching user_id
- Shared items require matching org_id membership
- Components never see raw Vault tokens

## Safety Constraints

- **AWS adapter**: Read-only by default. No EC2 start/stop/terminate, no S3 delete, no IAM create/delete exposed.
- **All adapters**: Operations scoped by AT Protocol session user_id/org_id claims. No cross-user session access.
- **Rate limiting**: Browser automation is naturally rate-limited by page load times (~1-5s per operation).
- **Credential storage**: Service credentials stored via provider-vault (HashiCorp Vault), never in KV.
- **TrafficStars**: API operations rate-limited by TrafficStars server-side limits.
