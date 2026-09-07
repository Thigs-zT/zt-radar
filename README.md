# zT Radar ❖ Serverless Gaming Intelligence Engine

[![Runtime: Node.js 22.x](https://img.shields.io/badge/Runtime-Node.js_22.x-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Compute: AWS Lambda Graviton](https://img.shields.io/badge/Compute-AWS_Lambda_Graviton_(arm64)-FF9900?style=flat-square&logo=awslambda&logoColor=white)](https://aws.amazon.com/lambda/)
[![Database: DynamoDB Single-Table](https://img.shields.io/badge/Database-Amazon_DynamoDB_(On--Demand)-4053D6?style=flat-square&logo=amazondynamodb&logoColor=white)](https://aws.amazon.com/dynamodb/)
[![IaC: AWS SAM](https://img.shields.io/badge/IaC-AWS_SAM_CloudFormation-E7157B?style=flat-square&logo=amazonwebservices&logoColor=white)](https://aws.amazon.com/serverless/sam/)
[![Integration: Discord Interactions v10](https://img.shields.io/badge/API-Discord_Interactions_v10-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.com/developers/docs/interactions/overview)
[![Security: Zero Vulnerabilities](https://img.shields.io/badge/Security-0_Vulnerabilities_(npm_audit)-brightgreen?style=flat-square&logo=securityscorecard&logoColor=white)](https://github.com/Thigs-zT/zt-radar)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue?style=flat-square)](LICENSE)

> A high-precision, serverless Discord intelligence bot engineered to deliver real-time multi-storefront video game price comparisons, historical all-time low tracking, PC hardware specifications, playtime analytics, and automated Steam ecosystem synchronization.

---

## ❖ Overview

**zT Radar** eliminates the overhead, latency, and vulnerabilities of monolithic Discord bots by operating entirely on an event-driven, webhook-based serverless architecture. Built on **AWS Lambda (Graviton arm64)**, **Amazon API Gateway HTTP APIs**, and **Amazon DynamoDB**, zT Radar incurs **$0 idle compute costs** while delivering sub-second interaction responses with millisecond cryptographic verification.

### Core Capabilities
* **Multi-Storefront Deal Intelligence**: Real-time cross-store price comparisons across a verified store whitelist: **Steam**, **Epic Games Store**, **GOG**, and **Nuuvem**.
* **Historical All-Time Low Tracking**: Flags genuine all-time low prices powered by IsThereAnyDeal and CheapShark historical datasets.
* **Steam Ecosystem Integration**: Resolve vanity URLs, inspect profile telemetry, audit VAC/community ban status, and synchronize monitored wishlists directly from Steam's official `IWishlistService`.
* **Playtime & Value Analysis**: Native Node.js protocol emulation for HowLongToBeat playtime statistics cross-referenced with live prices to calculate dynamic **Cost-per-Hour ($/hr and R$/hr)** metrics.
* **Dual-Currency Regional Awareness**: Native support for **US Dollars ($)** and official **Brazilian Reais (R$)** regional store pricing with zero synthetic currency conversion.
* **Autonomous Deal Radar**: Hourly EventBridge scanner that curates top-tier promotions, respects quality heuristic filters (minimum review score and discount cut), and delivers server broadcasts and user direct messages.

---

## ❖ Architecture & Engineering Decisions

```
                           [ Discord Interactions Webhook ]
                                          │
                                          ▼  HTTPS POST (Ed25519 Signed)
                       ┌─────────────────────────────────────┐
                       │   AWS API Gateway (HTTP API v2)     │
                       │   • Burst: 20 req/s | Rate: 10 req/s│
                       └──────────────────┬──────────────────┘
                                          │
                                          ▼  Raw Payload + Signature
                       ┌─────────────────────────────────────┐
                       │   AWS Lambda (Node.js 22.x, arm64)  │
                       │   • 512 MB Graviton Memory / vCPU   │
                       │   • Ed25519 verifyKey Validation    │
                       └──────────┬──────────────────┬───────┘
                                  │                  │
               Direct Read/Write  │                  │  Hourly Cron (EventBridge)
                                  ▼                  ▼
     ┌────────────────────────────────────┐   ┌────────────────────────────────────┐
     │      Amazon DynamoDB Table         │   │       dealScanner Function         │
     │      • Single-Table Design         │   │   • Evaluates Whitelist Deals      │
     │      • PAY_PER_REQUEST (On-Demand) │   │   • Dispatches Guild Broadcasts    │
     └────────────────────────────────────┘   └──────────────────┬─────────────────┘
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

### Key Technical Design Decisions

#### 1. Webhook-First Serverless Model
Traditional Discord bots rely on continuous WebSocket gateway connections (`discord.js`), requiring dedicated EC2 instances, containers, or VPS nodes that consume memory and compute 24/7. zT Radar uses Discord's native **HTTP Interactions Webhook** protocol. Cold starts are minimized under 900ms via 512 MB AWS Graviton allocation, while warm executions process in < 60ms.

#### 2. DynamoDB Single-Table Design
All application entities (user preferences, wishlist items, guild announcement configurations, and deal deduplication history) reside within a single Amazon DynamoDB table using Composite Primary Keys (`PK` and `SK`):

| Entity | `PK` (Partition Key) | `SK` (Sort Key) | Key Attributes |
| :--- | :--- | :--- | :--- |
| **User Configuration** | `USER#<discord_user_id>` | `CONFIG` | `preferred_currency`, `steam_id`, `steam_persona_name`, `updated_at` |
| **Monitored Wishlist Item** | `USER#<discord_user_id>` | `GAME#<slug>` | `game_title`, `target_price`, `min_discount`, `min_rating`, `steam_appid` |
| **Guild Broadcast Config** | `GUILD#<guild_id>` | `CONFIG` | `channel_id`, `currency`, `include_third_party`, `free_only`, `min_discount`, `min_rating` |
| **Deal Deduplication Cache**| `GUILD#<guild_id>` | `DEAL#<game_slug>`| `last_deal_price`, `broadcast_at`, `ttl` |

#### 3. Strict 4-Storefront Whitelist
To protect users from unverified key resellers, stolen credit card grey-market listings, and unauthorized regional key brokers, zT Radar enforces a strict whitelist of 4 legitimate digital retailers:
* **Valve Steam** (Official Storefront)
* **Epic Games Store** (Official Storefront)
* **GOG.com** (CD PROJEKT DRM-Free Storefront)
* **Nuuvem** (Authorized Digital Retailer)

#### 4. Zero-Dependency HowLongToBeat Protocol Emulation
Instead of relying on outdated, bloated, or vulnerable third-party npm libraries that pull in heavy HTTP clients, zT Radar implements a standalone native Node.js fetch utility (`src/utils/hltbNative.js`). It extracts dynamic frontend search tokens directly from HowLongToBeat's bundle, caches the token with a 1-hour sliding TTL, and queries completion durations with defensive 2500ms timeouts.

#### 5. Paginated Interactive Navigation (Type 3 / Type 7 Components)
Discord interaction responses impose a strict 4096-character limit on embed descriptions and a 3-second acknowledgement window. The `/wishlist list` command implements an in-memory 10-item pagination mechanism using Discord Message Component Buttons (`Type 3`) and direct message update responses (`Type 7`), guaranteeing payloads stay under 1500 characters and update within < 150ms.

---

## ❖ Slash Command Directory

### 1. Instant Market Intelligence

| Command | Arguments | Description |
| :--- | :--- | :--- |
| `/compare` | `<game>` | Compare current prices, active sales, and historical lows across Steam, Epic, GOG, and Nuuvem. |
| `/can-it-run` | `<game>` | Inspect official minimum and recommended PC hardware requirements (CPU, GPU, RAM, OS). |
| `/game-news` | `<game>` | Display the latest official developer patch notes, release updates, and announcements. |
| `/how-long-to-beat` | `<game>` | View average completion times (Main Story, Extras, Completionist) with live Cost-per-Hour calculation. |
| `/steam-trending` | *None* | Display the top 10 trending and surging titles on the Steam Storefront. |
| `/steam-most-played`| *None* | Display the official top 10 most played games on Steam by live concurrent player count. |
| `/platform-status` | *None* | Audit operational health and latency for Steam, Epic Games, PlayStation Network, and Xbox Live. |

### 2. Personal Wishlist & Radar

| Command | Arguments | Description |
| :--- | :--- | :--- |
| `/wishlist add` | `<game> [target_price]` | Add a game to personal tracking with an optional target price notification threshold. |
| `/wishlist remove` | `<game>` | Remove a monitored title from your active tracking list. |
| `/wishlist list` | *None* | View your monitored wishlist with interactive pagination buttons (10 items/page). |
| `/wishlist clear` | *None* | Instantly remove all monitored games from your wishlist via parallelized DynamoDB batch writes. |
| `/wishlist sync-steam`| `[target] [min_discount] [min_rating]` | Bulk-import your public Steam wishlist using Valve's `IWishlistService` with quality thresholds. |

### 3. Steam Ecosystem Identity

| Command | Arguments | Description |
| :--- | :--- | :--- |
| `/steam-link` | `<target>` | Link your Steam account via SteamID64, profile link, or custom vanity URL. |
| `/steam-profile` | `[user] [target]` | Display comprehensive profile metrics, live game activity, VAC/community ban status, and library metrics. |

### 4. Server Deal Radar & Administration

| Command | Arguments | Description |
| :--- | :--- | :--- |
| `/config-channel` | `<channel> [currency] [third_party] [free_only]` | Set the announcement channel for curated deal broadcasts (*Requires `Manage Server` permission*). |
| `/config-channel-experimental` | `[min_discount] [min_rating]` | Override standard heuristic broadcast filters (default: 70% cut, 80 review score). |
| `/config-channel-remove` | *None* | Decommission server deal broadcasts and remove configuration (*Requires `Manage Server`*). |
| `/radar-status` | *None* | View active server alert configuration, currency format, and operational status. |
| `/radar-help` | *None* | Display an interactive visual overview and guide to using zT Radar. |

### 5. Localization

| Command | Options | Description |
| :--- | :--- | :--- |
| `/currency` | `USD` / `BRL` | Set your preferred regional currency format for direct notifications and pricing calculations. |

---

## ❖ Visual Aesthetics & Typography

All Discord Rich Embeds generated by zT Radar adhere to clean, enterprise-grade typography with zero generic mobile emojis. Visual hierarchy is established using geometric Unicode indicators:

```diff
❖ Steam Storefront ❖ Current Promotions
▸ Cyberpunk 2077: Ultimate Edition
  └─ Current Best: $ 29.99 (Epic Games Store)
  └─ Historical Low: $ 29.99 (Matched All-Time Low!)
- Regular Price: $ 59.99
+ Promotional Price: $ 29.99 (-50%)
```

---

## ❖ Deployment & Reproduction Guide

### Prerequisites
* **Node.js**: `22.x LTS` or higher
* **AWS CLI**: Installed and configured with appropriate IAM permissions
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

### 2. Register Slash Commands
Synchronize the official consolidated command suite with the Discord API:
```bash
node scripts/registerCommands.js
```

### 3. Local Verification & Diagnostic Test Suite
Run the built-in diagnostic suites to verify upstream API connectivity, token resolution, and schema compliance:
```bash
# Verify Steam Web API, vanity URL resolution, and wishlist retrieval
node scripts/testSteamWeb.js

# Verify HowLongToBeat native protocol emulation and dynamic token caching
node scripts/testHowLongToBeatIntegration.js

# Run full end-to-end diagnostics across all endpoints
node scripts/verifyDiagnostics.js
```

### 4. AWS Cloud Deployment
Build and deploy the application using AWS SAM:
```bash
# Build the application bundle for AWS Graviton (arm64)
sam build

# Deploy via interactive guided setup
sam deploy --guided
```

When prompted by SAM:
* **Stack Name**: `zt-radar-stack`
* **AWS Region**: `us-east-2` (or your preferred region)
* **Parameters**: Enter your Discord, Steam, and ITAD keys (sensitive parameters are masked via `NoEcho: true`).
* Confirm IAM role creation and deploy.

### 5. Discord Developer Portal Setup
Once deployment completes, AWS SAM outputs the `InteractionsEndpoint`:
```
Outputs:
InteractionsEndpoint = https://<api-id>.execute-api.us-east-2.amazonaws.com/prod/interactions
```

1. Navigate to the **Discord Developer Portal** > **Your Application** > **General Information**.
2. In the **Interactions Endpoint URL** field, paste the `InteractionsEndpoint` URL.
3. Discord will perform an immediate cryptographic handshake verification (`PING` / `PONG`).
4. In the **Bot** tab:
   * Ensure **Privileged Gateway Intents** (*Presence Intent*, *Server Members Intent*, *Message Content Intent*) remain **DISABLED**.
5. In **OAuth2** > **URL Generator**:
   * Scopes: Select `applications.commands` (and optionally `bot`).
   * Bot Permissions: `View Channels`, `Send Messages`, `Embed Links`, `Attach Files`, `Use External Emojis`.
   * Use the generated URL to authorize the bot into your server.

---

## ❖ Repository Structure

```
zt-radar/
├── .agents/                    # Agent workflows and coding standards (gitignored)
├── scripts/                    # Command registration and diagnostic test scripts
│   ├── debugWishlist.js        # Valve Steam storefront vs Web API diagnostic tool
│   ├── registerCommands.js     # Discord REST API command registration script
│   ├── resetGuildHistory.js    # Guild deal broadcast cache reset utility
│   ├── testHltbNative.js       # Playtime engine parser unit tests
│   ├── testHowLongToBeatIntegration.js # HLTB + Market pricing cross-reference suite
│   ├── testMarketDeals.js      # ITAD deal curation and quality filter test suite
│   ├── testSteamWeb.js         # Steam vanity resolution and profile test suite
│   └── verifyDiagnostics.js    # End-to-end integration and API verification suite
├── src/
│   ├── handlers/
│   │   ├── dealScanner.js      # Scheduled EventBridge market scanner handler
│   │   └── discordBot.js       # Core Discord interaction webhook handler & router
│   └── utils/
│       ├── hltbNative.js       # Native Node.js HowLongToBeat protocol emulation
│       ├── itadApi.js          # IsThereAnyDeal API v1-v3 client & normalization
│       ├── platformStatus.js   # Live gaming platform status & latency probes
│       ├── steamIntel.js       # Steam Storefront trending & hardware specs client
│       └── steamWeb.js         # Valve Steam Web API, ban status & wishlist engine
├── .env.example                # Runtime environment variable template
├── .gitignore                  # Git exclusion rules for secrets, build artifacts, and directives
├── AGENTS.md                   # Core architecture guidelines (gitignored)
├── LICENSE                     # ISC License
├── package.json                # Project manifest and minimal dependencies
├── PRIVACY.md                  # Discord Developer Portal compliant Privacy Policy
├── README.md                   # Enterprise documentation and reproduction manual
├── template.yaml               # AWS SAM CloudFormation serverless infrastructure specification
└── TERMS.md                    # Discord Developer Portal compliant Terms of Service
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
