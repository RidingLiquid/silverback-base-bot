# Silverbackbot

A Telegram bot for automated volume trading on the Base blockchain using Uniswap V3.

## Setup
1. Install dependencies: `yarn install`
2. Set `.env` with `TELEGRAM_TOKEN` and `RPC_ENDPOINT` (e.g., `https://mainnet.base.org`).
3. Run: `node bot.js`

## Features
- Wallet management (generate, import/export).
- Set ERC20 token, amount, cycles, timing.
- Buy/sell cycles on Uniswap V3.
- Fee system with whitelisting.
- Message auto-deletion for security.

## Dependencies
- ethers@6.13.2
- @uniswap/v3-sdk@3.9.2
- @uniswap/sdk-core@4.0.3
- grammy@1.30.0
- bs58@6.0.0
- dotenv@16.4.5

## Notes
- Use test wallet with minimal funds.
- Replace `DEV_WALLET_ADDRESS` in `bot.js`.
- For production, use a paid RPC (QuickNode/Alchemy).