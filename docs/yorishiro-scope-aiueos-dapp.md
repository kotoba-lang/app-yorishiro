# app-yorishiro（資格情報 scope）— itonami（dapp）上の分散型設計

状態: 第 1 スライス実装（2026-10-20）。正本はこの文書。
追跡: Linear JUN-128（親 JUN-116）。

## 位置づけ

app-yorishiro は**依り代** —— 外部 web サービスを Playwright で etzhayyim
プラットフォームへ導く器（Apify 型）。サービスごとに yorishiro-{service} が
立ち、API adapters は **provider-vault の資格情報**を使う。

## このスライス: scope 判定コア

| 層 | 実体 | 状態 |
|---|---|---|
| 判定コア guest | `aiueos/yorishiro_scope.cljk` — scope-judgment（**org / user / service / key の一致を独立ビットで判定**）/ confined（**3 つすべて一致のときだけ scope 内**）/ job-queued（pending → queued、必須欠落は拒否） | **実装済み・実測** |
| 記述子 | `aiueos/yorishiro-scope.edn` | **実装済み** |
| parity | `appview/.../test/yorishiro/scope_parity_test.cljk` — 正本（AGENTS.md の vault パス + app.ts のジョブ発行）と一致 | **実装済み・実測** |

実測: `amu test aiueos/yorishiro_scope.cljk` → **21/21**（jvm-kir / js / wasm）。
parity → 2 tests / 8 assertions / 0 failures。

## 正本の正確な規則（guest はこれに追従）

- **資格情報の scope**: `secret/data/orgs/{org}/users/{user}/services/{service}/{key}`
  —— org・user・service の **3 つすべて**が呼び出し元と一致するときだけ
  取れる（files の confinement と同じ「閉じた grant」原則）。
- ジョブは **pending → queued（jobId + phase）**。必須が無いと発行しない。
- browser adapters は Chromium プール（Playwright、Go provider）。
  API adapters は `etzhayyim:provider-vault/credentials` を imports する。

## 未実装境界

- Playwright ブラウザ面（session persistence / auth helpers）の判定。
- サービスごとの操作判定（yorishiro-google / x / aws 等の typed interface）。
- vault 実体（HashiCorp Vault = host）。
- mon（DNA）化、aiueos session 載せ（fleet 共通）。
