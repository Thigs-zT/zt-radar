# Privacy Policy for zT Radar

*Last Updated: September 2026*

**zT Radar** ("the Application", "the Bot") is a serverless Discord application engineered to deliver curated video game deal intelligence, historical price comparisons, PC hardware specifications, and gaming platform availability status.

### 1. Data Collected
zT Radar collects and stores only the minimum operational data necessary to perform its advertised features:
* **Discord User ID**: To associate game wishlist items, threshold preferences, and notification routing with your account.
* **Discord Guild (Server) ID & Channel ID**: Stored only when a server administrator explicitly configures an announcement channel via `/config-channel`.
* **Tracked Games & Thresholds**: Game titles, optional target prices, minimum discount percentages, and minimum review scores configured for notifications.
* **Linked Steam ID**: Optional 64-bit Steam ID (`SteamID64`) stored strictly when a user links their Steam profile via `/steam-link` or bulk-imports public wishlist items via `/wishlist sync-steam`.
* **Preferred Currency**: Stored preference between USD ($) and BRL (R$).

### 2. Data Not Collected
* The Bot does **not** request or utilize the Privileged Message Content Intent.
* The Bot does **not** read, monitor, record, or store user chat messages, server conversations, attachments, voice audio, or friend lists.
* The Bot operates strictly through Discord Slash Commands and HTTP Interactions Webhooks with Ed25519 signature verification.

### 3. Data Storage & Security
* All persistent data is stored in Amazon DynamoDB located in AWS `us-east-2`, utilizing encrypted storage at rest (AWS KMS / default encryption).
* Database access is strictly constrained by AWS Identity and Access Management (IAM) execution policies adhering to the Principle of Least Privilege.
* No personal data, telemetry, or server configurations are ever sold, rented, monetized, or shared with third parties.

### 4. Third-Party API Integrations
zT Radar interacts exclusively with authorized public APIs to fetch real-time game information:
* **Valve Steam Web & Store APIs**: For public game news, hardware specifications, and public user profile summaries.
* **IsThereAnyDeal (ITAD) & CheapShark APIs**: For authorized multi-storefront pricing and historical low discounts.
* **HowLongToBeat**: For public game completion duration statistics.
No Discord user tokens, bot authentication secrets, or private server metadata are ever transmitted to third-party services.

### 5. Data Deletion & User Rights
* Users may delete any tracked game from their wishlist at any time using `/wishlist remove <game>`.
* Users may purge their entire monitored library and alert preferences instantly using `/wishlist clear`.
* Server administrators may decommission server deal broadcasting and delete guild configurations at any time using `/config-channel-remove`.
* To request a complete manual erasure of all records associated with a Discord User ID or Guild ID, contact the repository maintainers via GitHub Issues.