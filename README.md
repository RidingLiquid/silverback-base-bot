# Silverback Bot

Telegram bot for automated trading on Base and Solana — volume generation, grid trading, and cross-DEX arbitrage.

## Features

- **Volume Mode** — Automated buy/sell cycles to generate token volume
- **Grid Mode** — Spread trading on ETH/USDC or SOL/USDC with configurable grid levels
- **Arb Mode** (Base only) — Cross-DEX arbitrage across Uniswap V2, Aerodrome, BaseSwap & SushiSwap
- **BACK Accumulation** — Price-reactive $BACK token accumulation
- **Dual Chain** — Base (EVM) + Solana (Jupiter)
- **Token Gate** — Grid & Arb modes require 60,000 $BACK holdings (verified via signature)
- **Security** — PIN-encrypted wallets, auto-deleting messages, 2h inactivity wallet wipe

## Setup

1. Install dependencies: `yarn install`
2. Create `.env`:
   ```
   TELEGRAM_TOKEN=your_bot_token
   BASE_RPC=https://mainnet.base.org
   SOL_RPC=https://api.mainnet-beta.solana.com
   ```
3. Run: `node bot.js`

## DEX Routers (Base)

| DEX | Router |
|-----|--------|
| Uniswap V2 (Silverback) | `0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24` |
| Aerodrome | `0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43` |
| BaseSwap | `0x327Df1E6de05895d2ab08513aaDD9313Fe505d86` |
| SushiSwap | `0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891` |

## Dependencies

- ethers 6.x — Base chain interaction
- @solana/web3.js — Solana chain interaction
- grammy — Telegram bot framework
- bs58 — Solana key encoding

## Notes

- Use a test wallet with minimal funds
- For production, use a paid RPC (QuickNode, Alchemy, etc.)
- Volume mode is free; Grid & Arb require BACK token gate verification
