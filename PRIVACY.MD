# Privacy Policy for zT Radar

*Last Updated: 2026*

**zT Radar** ("the Bot") is a serverless Discord application designed to track video game discounts and alert users when monitored games reach target prices or major promotions.

### 1. Data Collected
zT Radar collects and stores only the minimum data necessary to operate its core features:
* **Discord User ID**: To associate game wishlist items with your private notifications.
* **Discord Guild (Server) ID & Channel ID**: To deliver public server deal announcements when configured by an administrator.
* **Tracked Games & Target Prices**: Game titles and custom price limits chosen by users.

### 2. Data Not Collected
* The Bot does **not** read, log, or store chat messages, user conversations, personal files, or private profile information.
* The Bot operates strictly via Discord Slash Commands and HTTP Interactions Webhooks.

### 3. Data Storage & Security
* Data is stored securely using Amazon DynamoDB (AWS us-east-2) with encrypted storage at rest.
* No personal data is sold, transferred, or shared with third parties.

### 4. Data Deletion
* Users can instantly remove their data at any time using `/wishlist remove <game>` or `/wishlist clear`.
* Server administrators can remove all server-associated configuration using `/config-channel-remove`.