# zT Radar ❖ Serverless Gaming Intelligence Engine

[![CI](https://github.com/Thigs-zT/zt-radar/actions/workflows/ci.yml/badge.svg)](https://github.com/Thigs-zT/zt-radar/actions)
[![TypeScript: 5.x](https://img.shields.io/badge/TypeScript-5.x_(Strict)-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Runtime: Node.js 22.x](https://img.shields.io/badge/Runtime-Node.js_22.x_LTS-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Compute: AWS Lambda Graviton](https://img.shields.io/badge/Compute-AWS_Lambda_Graviton_(arm64)-FF9900?style=flat-square&logo=awslambda&logoColor=white)](https://aws.amazon.com/lambda/)
[![Database: DynamoDB Single-Table](https://img.shields.io/badge/Database-Amazon_DynamoDB_(On--Demand)-4053D6?style=flat-square&logo=amazondynamodb&logoColor=white)](https://aws.amazon.com/dynamodb/)
[![Testing: Vitest](https://img.shields.io/badge/Testing-Vitest_(36_Tests_Passing)-6E9F18?style=flat-square&logo=vitest&logoColor=white)](https://vitest.dev/)
[![IaC: AWS SAM](https://img.shields.io/badge/IaC-AWS_SAM_CloudFormation-E7157B?style=flat-square&logo=amazonwebservices&logoColor=white)](https://aws.amazon.com/serverless/sam/)
[![Integration: Discord Interactions v10](https://img.shields.io/badge/API-Discord_Interactions_v10-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.com/developers/docs/interactions/overview)
[![Security: Zero Vulnerabilities](https://img.shields.io/badge/Security-0_Vulnerabilities_(npm_audit)-brightgreen?style=flat-square&logo=securityscorecard&logoColor=white)](https://github.com/Thigs-zT/zt-radar)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue?style=flat-square)](LICENSE)
[![Discord Invite](https://img.shields.io/badge/Discord-Add_to_Server-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.com/oauth2/authorize?client_id=1537623174211182712&permissions=314368&integration_type=0&scope=applications.commands+bot)

> A high-precision, serverless Discord intelligence bot engineered to deliver real-time multi-storefront video game price comparisons, historical all-time low tracking, PC hardware specifications, playtime metrics, and Steam social ecosystem analytics.

### ❖ Quick Server Authorization

[![Add zT Radar to Discord](https://img.shields.io/badge/Add_zT_Radar_to_Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.com/oauth2/authorize?client_id=1537623174211182712&permissions=314368&integration_type=0&scope=applications.commands+bot)

▸ **One-Click Invite Link**: [Direct OAuth2 Authorization URL](https://discord.com/oauth2/authorize?client_id=1537623174211182712&permissions=314368&integration_type=0&scope=applications.commands+bot)  
▸ **Least-Privilege Scopes**: `applications.commands` + `bot` (`Send Messages`, `Embed Links`, `Attach Files`, `Use External Emojis`).  
▸ **Zero Gateway Overhead**: Operates 100% serverless via webhooks with zero message content access.

---

## ❖ Overview

**zT Radar** eliminates the overhead, latency, and vulnerabilities of monolithic Discord bots by operating entirely on an event-driven, webhook-based serverless architecture. Built on **AWS Lambda (Graviton arm64)**, **Amazon API Gateway HTTP APIs**, and **Amazon DynamoDB**, zT Radar incurs **$0 idle compute costs** while delivering sub-second interaction responses with millisecond cryptographic verification.

### Core Capabilities
* **Multi-Storefront Deal Intelligence**: Real-time cross-store price comparisons across a verified store whitelist: **Steam**, **Epic Games Store**, **GOG**, and **Nuuvem**.
* **Historical All-Time Low Tracking**: Flags genuine all-time low prices powered by IsThereAnyDeal and CheapShark historical datasets.
* **Steam OpenID 2.0 Cryptographic Identity**: Zero-dependency official Valve OpenID authentication with single-click browser linking and 10-minute sliding CSRF state tokens.
* **Multi-Library Co-op Discovery (`/game-match`)**: Cross-references two Steam libraries in memory to instantly pinpoint shared co-op, multiplayer, and split-screen titles for friend sessions.
* **Steam Library Duels (`/steam-duel`)**: Visual head-to-head library comparison showing playtime dominance, achievement progress, and shared game catalog statistics with dual-embed scoreboards and diff playtime blocks.
* **Factual Steam Backlog Valuation (`/steam-backlog`)**: Audits unplayed paid games, calculates real backlog percentages, and computes factual backlog retail MSRP value via batch Storefront API lookups.
* **Playtime & Value Analysis**: Native Node.js protocol emulation for HowLongToBeat playtime statistics cross-referenced with live prices to calculate dynamic **Cost-per-Hour ($/hr and R$/hr)** metrics.
* **Dual-Currency Regional Awareness**: Native support for **US Dollars ($)** and official **Brazilian Reais (R$)** regional store pricing with zero synthetic currency conversion.
* **Autonomous Deal Radar**: Hourly EventBridge scanner that curates top-tier promotions, respects quality heuristic filters (minimum review score and discount cut), and delivers server broadcasts and user direct messages.

---

## ❖ Architecture & Engineering Decisions

```
                                [ Discord Gateway / Users ]
                                             │
                       ┌─────────────────────┴─────────────────────┐
                       │                                           │
                       ▼  HTTPS POST (Ed25519)                     ▼  HTTPS GET (OAuth Redirect / Callback)
             [ /interactions ]                              [ /auth/steam/login & /callback ]
                       │                                           │
                       └─────────────────────┬─────────────────────┘
                                             │
                                             ▼
                        ┌──────────────────────────────────────────┐
                        │       AWS API Gateway (HTTP API v2)      │
                        │       • Burst: 20 req/s | Rate: 10 req/s │
                        └────────────────────┬─────────────────────┘
                                             │
                                             ▼  Raw Payload + Headers
                        ┌──────────────────────────────────────────┐
                        │   AWS Lambda: discordBotFunction         │
                        │   • Runtime: Node.js 22.x LTS (arm64)    │
                        │   • Bundling: AWS SAM Native esbuild     │
                        │   • 100% Strict TypeScript (allowJs: false)
                        │   • Memory: 512 MB Graviton Compute      │
                        │   • Ed25519 verifyKey & OpenID Handshake │
                        └────────────┬─────────────────────────────┘
                                     │
                  Direct Read / Write│
                                     ▼
                        ┌──────────────────────────────────────────┐
                        │        Amazon DynamoDB Table             │
                        │        • Single-Table Architecture       │
                        │        • PAY_PER_REQUEST (On-Demand)     │
                        │        • Composite Keys (PK, SK)         │
                        └────────────────────▲─────────────────────┘
                                             │
                                  Batch Read │ State Verification
                                             │
                        ┌────────────────────┴─────────────────────┐
                        │   AWS Lambda: dealScannerFunction        │
                        │   • Scheduled EventBridge: rate(1 hour)  │
                        │   • Evaluates Whitelist Deals & Alerts   │
                        │   • Dispatches Guild Broadcasts & DMs    │
                        │   • Anti-Amnesia 24h Cooldown Protection │
                        └────────────────────┬─────────────────────┘
                                             │
                                             ▼
       ┌────────────────────────────────────────────────────────────────────────┐
       │                      External Intelligence Providers                   │
       │  ▸ Valve Steam Web & Store APIs (IWishlistService, AppDetails, News)   │
       │  ▸ IsThereAnyDeal (ITAD) API v1-v3 (Multi-Storefront & All-Time Lows) │
       │  ▸ CheapShark API (Instant Search Autocomplete & Fallback Pricing)     │
       │  ▸ HowLongToBeat Native Engine (Zero-Dependency Protocol Emulation)    │
       └────────────────────────────────────────────────────────────────────────┘
```

### Dual-Tier Serverless Event Architecture

zT Radar separates interactive user execution from periodic data scanning into a two-tier decoupled architecture:

#### Tier 1: Synchronous Interaction & Authentication Engine (`src/handlers/discordBot.ts`)
* **Discord Interactions Webhook (`POST /interactions`)**: Receives cryptographically signed Ed25519 interaction payloads from Discord. Requests are verified in under 5ms using `discord-interactions`. All slash commands, button pagination events (Type 3 components), and modal callbacks are handled within Discord's strict 3000ms execution envelope.
* **Steam OpenID 2.0 Webhook Routes (`GET /auth/steam/login`, `GET /auth/steam/callback`)**: Implements browser-based Steam authentication directly on API Gateway HTTP API v2. Generates 256-bit cryptographically secure CSRF state tokens, issues 302 redirects to Valve's OpenID gateway, verifies incoming OpenID assertions via direct `check_authentication` handshake, and stores linked Steam identities in DynamoDB.

#### Tier 2: Asynchronous Scheduled Deal Intelligence Scanner (`src/handlers/dealScanner.ts`)
* **EventBridge Hourly Trigger (`rate(1 hour)`)**: Autonomous background worker that executes without external API Gateway exposure.
* **Wishlist & Server Deal Evaluation**: Scans all monitored items across user wishlists and configured server alert channels, cross-referencing current market prices against target price thresholds, minimum discounts, and review scores.
* **Auto-Healing Steam Titles**: Detects uninitialized Steam app labels and automatically resolves and persists canonical titles from live storefront metadata.
* **Anti-Amnesia 24-Hour Cooldown**: Prevents alert spam by enforcing a 24-hour notification suppression window per user/guild, while immediately bypassing cooldowns whenever a game drops to a deeper discount.

---

## ❖ DynamoDB Single-Table Schema

All application entities reside within a single Amazon DynamoDB table using composite primary keys (`PK` and `SK`), avoiding cross-table join overhead and supporting zero-maintenance On-Demand scaling (`PAY_PER_REQUEST`):

| Entity Type | Partition Key (`PK`) | Sort Key (`SK`) | Key Attributes & Payloads | Purpose |
| :--- | :--- | :--- | :--- | :--- |
| **User Configuration** | `USER#<discord_user_id>` | `CONFIG` | `preferred_currency`, `steam_id`, `steam_persona_name`, `steam_avatar_url`, `steam_verified`, `updated_at` | Stores user regional currency format and linked Steam profile. |
| **Steam OAuth State** | `USER#<discord_user_id>` | `STEAM_OAUTH_STATE` | `state_token`, `expires_at` (10-min TTL), `created_at` | Ephemeral CSRF validation token consumed upon callback assertion. |
| **Monitored Wishlist Item** | `USER#<discord_user_id>` | `GAME#<slug>` | `game_title`, `target_price`, `min_discount`, `min_rating`, `steam_appid`, `created_at` | User game price alert subscription with threshold criteria. |
| **Guild Broadcast Config** | `GUILD#<guild_id>` | `CONFIG` | `channel_id`, `currency`, `include_third_party`, `free_only`, `min_discount`, `min_rating`, `updated_at` | Channel destination and quality filters for automated deal radar. |
| **Guild Deal Broadcast Cache** | `GUILD#<guild_id>` | `DEAL#<game_slug>` | `last_deal_price`, `broadcast_at`, `ttl` (7-day sliding TTL) | Deduplication cache to prevent duplicate guild deal announcements. |
| **Deal Notification Cooldown** | `BROADCAST#COOLDOWN` | `USER#<user_id>#GAME#<game_id>` | `last_alert_price`, `last_alert_timestamp`, `ttl` (24-hour TTL) | Anti-amnesia tracking preventing duplicate user DM alerts within 24h. |

---

## ❖ Key Engineering Principles

#### 1. 100% Pure Strict TypeScript
The entire source tree under `src/` is implemented in strict TypeScript with `allowJs: false` and `strict: true`. Canonical domain interfaces and payloads are centrally defined in `src/types/index.ts`. Packaging is handled by native AWS SAM `esbuild` integration targeting Node.js 22.x on AWS Graviton (`arm64`), generating production sourcemaps for accurate error stack traces.

#### 2. Lean Dependency Philosophy
zT Radar intentionally avoids monolithic frameworks (such as `discord.js` or `axios`). All outbound HTTP requests utilize Node.js native `fetch` with `AbortController` timeouts configured under 2500ms to guarantee sub-3000ms Discord interaction compliance.

#### 3. Strict 4-Storefront Whitelist
To protect users from unverified key resellers, grey-market key scrapers, and fraudulent storefronts, zT Radar enforces a strict whitelist of 4 legitimate digital retailers:
* **Valve Steam** (Official Storefront)
* **Epic Games Store** (Official Storefront)
* **GOG.com** (CD PROJEKT DRM-Free Storefront)
* **Nuuvem** (Authorized Digital Retailer)

#### 4. Interaction Visibility Scoping
* **Ephemeral Scope (`flags: 64`)**: Personal preferences, wishlist additions/removals, Steam account linking, and guild administrative configurations respond ephemerally, visible only to the initiating user.
* **Public Channel Scope**: Social intelligence commands (`/steam-duel`, `/game-match`, `/steam-backlog`), price comparisons (`/compare`), hardware audits (`/can-it-run`), and platform status checks respond publicly to enrich channel discussions.

#### 5. Compact Custom ID Micro-Schema
Discord restricts component `custom_id` strings to 100 characters. For interactive button pagination across multi-page payloads, state is serialized into micro-schemas such as:
* `match_p:<page>:<filter>:<steamIdA>:<steamIdB>` (~49 characters)
* `duel_p:<page>:<steamIdA>:<steamIdB>` (~44 characters)
* `backlog_p:<page>:<steamId>` (~32 characters)

---

## ❖ Slash Command Directory

### 1. Steam Social Suite

| Command | Arguments | Visibility | Description |
| :--- | :--- | :--- | :--- |
| `/steam-duel` | `<target1> <target2>` | Public | Visual head-to-head library comparison showing playtime dominance, achievement progress, and shared game catalog statistics with dual-embed scoreboards and diff playtime blocks. |
| `/game-match` | `<target1> <target2> [filter]` | Public | Multi-user shared library discovery cross-referencing two Steam libraries in memory. Filter by `coop` (Co-op & Multiplayer) or `all` (All Shared Games) with interactive pagination. |
| `/steam-backlog` | `[target]` | Public | Factual unplayed library valuation based on pure base retail MSRP via batch Storefront API lookups. Audits unplayed games (0 min playtime), calculates backlog percentage, and computes total backlog MSRP value in USD ($) or BRL (R$). |
| `/steam-link` | `[target]` | Ephemeral | Link your Steam account via Valve OpenID 2.0 single-click verification, SteamID64, profile link, or vanity URL with 10-minute CSRF state tokens. |
| `/steam-profile` | `[user] [target]` | Public | Display comprehensive profile metrics, live game activity, VAC/community ban status, and library telemetry. |

### 2. Instant Market Intelligence

| Command | Arguments | Visibility | Description |
| :--- | :--- | :--- | :--- |
| `/compare` | `<game>` | Public | Compare current prices, active sales, and historical lows across Steam, Epic, GOG, and Nuuvem. |
| `/can-it-run` | `<game>` | Public | Inspect official minimum and recommended PC hardware requirements (CPU, GPU, RAM, OS). |
| `/game-news` | `<game>` | Public | Display the latest official developer patch notes, release updates, and announcements. |
| `/how-long-to-beat` | `<game>` | Public | View average completion times (Main Story, Extras, Completionist) with live Cost-per-Hour calculation. |
| `/steam-trending` | *None* | Public | Display the top 10 trending and surging titles on the Steam Storefront. |
| `/steam-most-played`| *None* | Public | Display the official top 10 most played games on Steam by live concurrent player count. |
| `/platform-status` | *None* | Public | Audit operational health and latency for Steam, Epic Games, PlayStation Network, and Xbox Live. |
| `/free-play-radar` | *None* | Public | Inspect all active 100% free games to keep (Epic/Steam) and temporary Free Weekend events. |

### 3. Personal Wishlist & Radar

| Command | Arguments | Visibility | Description |
| :--- | :--- | :--- | :--- |
| `/wishlist add` | `<game> [target_price]` | Ephemeral | Add a game to personal tracking with an optional target price notification threshold. |
| `/wishlist remove` | `<game>` | Ephemeral | Remove a monitored title from your active tracking list. |
| `/wishlist list` | *None* | Ephemeral | View your monitored wishlist with interactive pagination buttons (10 items/page). |
| `/wishlist clear` | *None* | Ephemeral | Instantly remove all monitored games from your wishlist via parallelized DynamoDB batch writes. |
| `/wishlist sync-steam`| `[target] [min_discount] [min_rating]` | Ephemeral | Bulk-import your public Steam wishlist using Valve's `IWishlistService` with quality thresholds. |
| `/free-radar-dm` | `<enabled>` | Ephemeral | Toggle automated direct message alerts for all free games and free weekends independent of wishlist. |

### 4. Server Deal Radar & Administration

| Command | Arguments | Permissions | Description |
| :--- | :--- | :--- | :--- |
| `/config-channel` | `<channel> [currency] [third_party] [free_only]` | `Manage Server` | Set the announcement channel for curated deal broadcasts. |
| `/config-channel-experimental` | `[min_discount] [min_rating]` | `Manage Server` | Override standard heuristic broadcast filters (default: 70% cut, 80 review score). |
| `/config-channel-remove` | *None* | `Manage Server` | Decommission server deal broadcasts and remove configuration. |
| `/radar-status` | *None* | Everyone | View active server alert configuration, currency format, and operational status. |
| `/radar-help` | *None* | Everyone | Display an interactive visual overview and guide to using zT Radar. |

### 5. Localization

| Command | Options | Visibility | Description |
| :--- | :--- | :--- | :--- |
| `/currency` | `USD` / `BRL` | Ephemeral | Set your preferred regional currency format for direct notifications and pricing calculations. |

---

## ❖ Visual Aesthetics & Typography

All Discord Rich Embeds generated by zT Radar adhere to clean, enterprise-grade typography with **zero generic mobile emojis**. Visual hierarchy is established using geometric Unicode indicators:

```diff
❖ Steam Storefront ❖ Current Promotions
▸ Cyberpunk 2077: Ultimate Edition
  └─ Current Best: $ 29.99 (Epic Games Store)
  └─ Historical Low: $ 29.99 (Matched All-Time Low!)
- Regular Price: $ 59.99
+ Promotional Price: $ 29.99 (-50%)
```

---

## ❖ Engineering Rigor & Quality Gates

zT Radar enforces enterprise-grade engineering practices through automated testing, strict linting, and a 10-gate continuous integration pipeline.

### Automated Testing Architecture

The test suite is powered by **Vitest 5.x** running natively on Node.js 22.x ES modules. To ensure determinism and eliminate flakiness, all external dependencies are mocked in-memory:

* **In-Memory AWS Service Mocking**: Uses `aws-sdk-client-mock` to intercept and mock the `@aws-sdk/lib-dynamodb` client. No live AWS cloud calls are made during tests. Commands tested include `ScanCommand`, `GetCommand`, `PutCommand`, `UpdateCommand`, and `DeleteCommand`.
* **Zero Network Calls**: External HTTP requests to Valve Steam APIs, IsThereAnyDeal, and Discord REST endpoints are mocked via `vi.fn()` and module interception.
* **Code Coverage Reporting**: Powered by `@vitest/coverage-v8`, tracking branch, function, and statement coverage.

```bash
# Execute test suite
npm test

# Execute test suite with V8 coverage report
npm run test:coverage
```

#### Test Suite Breakdown (36 Tests Passing)

| Test Suite | Path | Tests | Key Focus Areas |
| :--- | :--- | :---: | :--- |
| **Steam Web & Social** | `tests/unit/steamWeb.test.js` | 11 | Vanity URL resolution, SteamID64 parsing, library deduplication, privacy checks, backlog calculation, and duel analytics. |
| **ITAD & Store Whitelist** | `tests/unit/itadApi.test.js` | 10 | ITAD API v1-v3 client normalization, strict 4-storefront whitelisting, dual-currency isolation, and error resilience. |
| **Steam OpenID 2.0** | `tests/unit/steamOpenId.test.js` | 8 | CSRF state token generation, DynamoDB persistence, single-use token consumption, login URL construction, and assertion validation. |
| **Deal Scanner Integration** | `tests/integration/dealScanner.test.js` | 7 | Hourly scan cycles, auto-healing Steam titles, heuristic discount/rating filters, 24-hour notification cooldowns, and progressive price drop triggers. |

---

### 10-Gate Continuous Integration Pipeline

Every push and pull request to the `main` branch is validated against 10 sequential quality gates defined in [`.github/workflows/ci.yml`](.github/workflows/ci.yml):

| Gate | Pipeline Step | Action / Command | Verification Criteria |
| :---: | :--- | :--- | :--- |
| **1** | Repository Checkout | `actions/checkout@v4` | Checks out source repository with full commit history. |
| **2** | Node.js Runtime Setup | `actions/setup-node@v4` | Provisions Node.js 22.x LTS with npm dependency caching. |
| **3** | Dependency Tree Sync | `npm ci` | Installs exact dependency tree defined in `package-lock.json`. |
| **4** | Security Audit | `npm audit` | Verifies zero known vulnerabilities across production and development trees. |
| **5** | Static Syntax Inspection | `node --check <file>` | Validates static syntax across all JavaScript scripts and test suites. |
| **6** | AWS SAM CLI Setup | `aws-actions/setup-sam@v2` | Provisions AWS SAM CLI for CloudFormation infrastructure validation. |
| **7** | SAM Template Validation | `sam validate --lint` | Validates `template.yaml` syntax, parameters, and CloudFormation lint rules. |
| **8** | Strict TypeScript Check | `npm run typecheck` | Compiles codebase via `tsc --noEmit` requiring 0 diagnostic errors. |
| **9** | Vitest Test Suite | `npm test` | Asserts 100% pass rate across all 36 unit and integration tests. |
| **10** | V8 Coverage Report | `npm run test:coverage` | Generates detailed V8 code coverage report for CI evaluation. |

---

## ❖ Deployment & Reproduction Guide

### Prerequisites
* **Node.js**: `22.x LTS` or higher
* **AWS CLI**: Configured with appropriate IAM permissions
* **AWS SAM CLI**: Installed (`sam --version` >= 1.100.0)
* **Discord Application**: Created at the [Discord Developer Portal](https://discord.com/developers/applications)
* **API Credentials**:
  * Discord Bot Token & Public Key
  * IsThereAnyDeal API Key (Free registration at [ITAD](https://isthereanydeal.com/))
  * Valve Steam Web API Key (Registered at [Steam Community](https://steamcommunity.com/dev/apikey))

### 1. Repository Setup & Dependencies
```bash
# Clone the repository
git clone https://github.com/Thigs-zT/zt-radar.git
cd zt-radar

# Install dependencies (zero production vulnerabilities)
npm install

# Configure environment variables
cp .env.example .env
```

Populate `.env` with your development credentials:
```env
DISCORD_APP_ID=your_discord_application_id
DISCORD_PUBLIC_KEY=your_discord_application_public_key
DISCORD_BOT_TOKEN=your_discord_bot_token
ITAD_API_KEY=your_isthereanydeal_api_key
STEAM_API_KEY=your_valve_steam_web_api_key
```

### 2. Pre-Flight Verification Quality Gates
Before initiating a build or deployment, run local verification gates:
```bash
# Verify 0 TypeScript diagnostic errors
npm run typecheck

# Run full Vitest suite (assert 36 tests pass)
npm test

# Validate CloudFormation / SAM template
sam validate --lint
```

### 3. Register Slash Commands
Synchronize the consolidated command suite with the Discord API:
```bash
node scripts/registerCommands.js
```

### 4. Build & Deploy via AWS SAM

zT Radar utilizes a dual-environment staging architecture configured in `samconfig.toml`:

#### Deploy to Development / Staging (`dev`):
```bash
# Build TypeScript bundle via native esbuild
sam build

# Deploy to isolated canary stack (zt-radar-dev-stack)
sam deploy --config-env dev
```

#### Deploy to Production (`default` / `prod`):
```bash
# Build TypeScript bundle via native esbuild
sam build

# Deploy to official production stack (zt-radar-stack)
sam deploy --config-env default
```

For first-time deployment with guided parameter input:
```bash
sam deploy --guided
```

### 5. Discord Developer Portal Configuration
Once deployed, retrieve the `InteractionsEndpoint` from the CloudFormation outputs:
```
Outputs:
InteractionsEndpoint = https://<api-id>.execute-api.us-east-2.amazonaws.com/prod/interactions
```

1. Navigate to **Discord Developer Portal** > **Your Application** > **General Information**.
2. In the **Interactions Endpoint URL** field, paste the `InteractionsEndpoint` URL.
3. Discord will perform an immediate cryptographic handshake verification (`PING` / `PONG`).
4. In the **Bot** tab:
   * Ensure **Privileged Gateway Intents** (*Presence Intent*, *Server Members Intent*, *Message Content Intent*) remain **DISABLED**.
5. In **OAuth2** > **URL Generator**:
   * Scopes: Select `applications.commands` and `bot`.
   * Bot Permissions: `View Channels`, `Send Messages`, `Embed Links`, `Attach Files`, `Use External Emojis`.
   * Use the generated URL to authorize the bot into your target Discord server.

---

## ❖ Repository Structure

```
zt-radar/
├── .agents/                    # Agent workflows and coding standards (gitignored)
├── .github/
│   └── workflows/
│       └── ci.yml              # 10-gate GitHub Actions CI/CD pipeline definition
├── scripts/                    # Command registration and diagnostic scripts
│   ├── debugWishlist.js        # Valve Steam storefront vs Web API diagnostic tool
│   ├── registerCommands.js     # Discord REST API command registration script
│   ├── resetGuildHistory.js    # Guild deal broadcast cache reset utility
│   ├── simulateFreePlayRadar.js# Free play radar simulation script
│   ├── testFreePlayIntegration.js # Free play provider integration test
│   ├── testHltbNative.js       # Playtime engine parser diagnostic
│   ├── testHowLongToBeatIntegration.js # HLTB + Market pricing cross-reference suite
│   ├── testMarketDeals.js      # ITAD deal curation and quality filter test suite
│   ├── testSteamWeb.js         # Steam vanity resolution and profile test suite
│   └── verifyDiagnostics.js    # Comprehensive end-to-end diagnostics suite
├── src/
│   ├── handlers/
│   │   ├── dealScanner.ts      # Scheduled EventBridge market scanner handler (TypeScript)
│   │   └── discordBot.ts       # Core Discord interaction webhook & router (TypeScript)
│   ├── types/
│   │   └── index.ts            # Canonical domain TypeScript interfaces & schemas
│   └── utils/
│       ├── hltbNative.ts       # Native Node.js HowLongToBeat protocol emulation (TypeScript)
│       ├── itadApi.ts          # IsThereAnyDeal API client & store normalization (TypeScript)
│       ├── platformStatus.ts   # Live gaming platform status & latency probes (TypeScript)
│       ├── steamIntel.ts       # Steam Storefront trending & hardware specs (TypeScript)
│       ├── steamOpenId.ts      # Steam OpenID 2.0 auth & CSRF state engine (TypeScript)
│       └── steamWeb.ts         # Valve Steam Web API, backlog & duel engine (TypeScript)
├── tests/
│   ├── integration/
│   │   └── dealScanner.test.js # Deal scanner integration suite with in-memory AWS mocks
│   └── unit/
│       ├── itadApi.test.js     # ITAD API client and store filtering unit tests
│       ├── steamOpenId.test.js # Steam OpenID 2.0 and CSRF state token unit tests
│       └── steamWeb.test.js    # Steam vanity, library, and backlog unit tests
├── .env.example                # Runtime environment variable template
├── .gitignore                  # Git exclusion rules for secrets, build artifacts, and directives
├── AGENTS.md                   # Core architecture and agent guidelines
├── LICENSE                     # ISC License
├── package.json                # Project manifest and minimal dependencies
├── PRIVACY.md                  # Discord Developer Portal compliant Privacy Policy
├── README.md                   # Enterprise documentation and reproduction manual
├── samconfig.toml              # AWS SAM deployment configurations (prod & dev environments)
├── template.yaml               # AWS SAM CloudFormation serverless infrastructure specification
├── TERMS.md                    # Discord Developer Portal compliant Terms of Service
├── tsconfig.json               # TypeScript 5.x compiler configuration (strict mode)
└── vitest.config.js            # Vitest test runner configuration
```

---

## ❖ Legal & Third-Party Attributions

* **Privacy Policy**: Read our full operational data and retention disclosures in [PRIVACY.md](PRIVACY.md).
* **Terms of Service**: Review terms of use and liability disclaimers in [TERMS.md](TERMS.md).
* **Valve Corporation**: This project is not affiliated with or endorsed by Valve Corporation. Steam, the Steam logo, and Steamworks are trademarks or registered trademarks of Valve Corporation.
* **IsThereAnyDeal**: Price comparison data and historical pricing datasets are sourced from [IsThereAnyDeal](https://isthereanydeal.com/).
* **HowLongToBeat**: Video game completion time statistics are provided by [HowLongToBeat.com](https://howlongtobeat.com/).
* **Epic Games, GOG, & Nuuvem**: All storefront trademarks, titles, and promotional assets belong to their respective owners.

---

## ❖ License

This project is licensed under the [ISC License](LICENSE).
