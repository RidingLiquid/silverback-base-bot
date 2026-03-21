require('dotenv').config();
const { ethers } = require('ethers');
const crypto = require('crypto');
const { Connection, Keypair, PublicKey, VersionedTransaction, Transaction, SystemProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { getMint } = require('@solana/spl-token');
const bs58 = require('bs58');
const { Bot, InlineKeyboard } = require('grammy');

// ============================================================
// Configuration
// ============================================================
const DEV_WALLET_BASE = process.env.DEV_WALLET_BASE || '0x402c1246842f2CdbC8E0b98A67d7a59aae22b394';
const DEV_WALLET_SOL = process.env.DEV_WALLET_SOL || '3up48WvL4RRFVtPaSNM78ShoKsXCBNGH2jUWyWTgA511';
const FEE_BASE = '0.001';
const FEE_SOL = 0.01;
const WHITELISTED = ['ridingliquid'];
const MAX_RETRIES = 3;

// Base chain
const BASE_RPC = process.env.BASE_RPC || 'https://mainnet.base.org';
const WETH = '0x4200000000000000000000000000000000000006';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASESCAN = 'https://basescan.org';
const UNISWAP_V2_ROUTER = '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24';

// DEX Routers (Base)
const AERODROME_ROUTER = '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43';
const AERODROME_FACTORY = '0x420DD381b31aEf6683db6B902084cB0FFECe40Da';
const BASESWAP_ROUTER = '0x327Df1E6de05895d2ab08513aaDD9313Fe505d86';
const SUSHISWAP_ROUTER = '0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891';

// BACK Token Gate
const BACK_TOKEN = '0x558881c4959e9cf961a7E1815FCD6586906babd2';
const VIRTUAL_TOKEN = '0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b';
let BACK_GATE_AMOUNT = 60000; // adjustable threshold
const GATE_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24h re-verify
const WALLET_WIPE_MS = 2 * 60 * 60 * 1000; // 2h inactivity wipe

// Solana
const SOL_RPC = process.env.SOL_RPC || 'https://api.mainnet-beta.solana.com';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOLSCAN = 'https://solscan.io';
const JUP_QUOTE = 'https://quote-api.jup.ag/v6/quote';
const JUP_SWAP = 'https://quote-api.jup.ag/v6/swap';

// ABIs
const ROUTER_ABI = [
  'function swapExactETHForTokens(uint amountOutMin, address[] path, address to, uint deadline) payable returns (uint[] amounts)',
  'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline) returns (uint[] amounts)',
  'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline) returns (uint[] amounts)',
  'function getAmountsOut(uint amountIn, address[] path) view returns (uint[] amounts)',
];
const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
];

// Aerodrome uses Route[] structs instead of address[] paths
const AERODROME_ABI = [
  'function getAmountsOut(uint256 amountIn, tuple(address from, address to, bool stable, address factory)[] routes) view returns (uint256[] amounts)',
  'function swapExactETHForTokens(uint256 amountOutMin, tuple(address from, address to, bool stable, address factory)[] routes, address to, uint256 deadline) payable returns (uint256[] amounts)',
  'function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, tuple(address from, address to, bool stable, address factory)[] routes, address to, uint256 deadline) returns (uint256[] amounts)',
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, tuple(address from, address to, bool stable, address factory)[] routes, address to, uint256 deadline) returns (uint256[] amounts)',
];

// ============================================================
// Providers
// ============================================================
const baseProvider = new ethers.JsonRpcProvider(BASE_RPC);
const baseRouter = new ethers.Contract(UNISWAP_V2_ROUTER, ROUTER_ABI, baseProvider);
const aerodromeRouter = new ethers.Contract(AERODROME_ROUTER, AERODROME_ABI, baseProvider);
const baseSwapRouter = new ethers.Contract(BASESWAP_ROUTER, ROUTER_ABI, baseProvider);
const sushiRouter = new ethers.Contract(SUSHISWAP_ROUTER, ROUTER_ABI, baseProvider);
const solConnection = new Connection(SOL_RPC, 'confirmed');

// DEX registry for arb scanning
const DEXES = [
  { name: 'Uniswap', router: baseRouter, address: UNISWAP_V2_ROUTER, type: 'v2' },
  { name: 'Aerodrome', router: aerodromeRouter, address: AERODROME_ROUTER, type: 'aerodrome' },
  { name: 'BaseSwap', router: baseSwapRouter, address: BASESWAP_ROUTER, type: 'v2' },
  { name: 'SushiSwap', router: sushiRouter, address: SUSHISWAP_ROUTER, type: 'v2' },
];

const bs58Encode = bs58.default ? bs58.default.encode : bs58.encode;
const bs58Decode = bs58.default ? bs58.default.decode : bs58.decode;

// ============================================================
// Telegram Bot
// ============================================================
const telegramToken = process.env.TELEGRAM_TOKEN;
if (!telegramToken) throw new Error('TELEGRAM_TOKEN not set in .env');
const bot = new Bot(telegramToken);

bot.catch((err) => {
  console.error('Bot error:', err.message);
  const chatId = err.ctx?.chat?.id;
  if (chatId) bot.api.sendMessage(chatId, 'Something went wrong. Try /start.').catch(() => {});
});

// ============================================================
// Formatting
// ============================================================
const fmt = {
  header: (t) => `\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n  ${t}\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`,
  line: (l, v) => `${l}: ${v}`,
  div: () => '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
  mono: (t) => '`' + t + '`',
  txBase: (h) => `[${h.slice(0, 10)}...](${BASESCAN}/tx/${h})`,
  txSol: (s) => `[${s.slice(0, 10)}...](${SOLSCAN}/tx/${s})`,
  addrBase: (a) => `[${a.slice(0, 6)}...${a.slice(-4)}](${BASESCAN}/address/${a})`,
  addrSol: (a) => `[${a.slice(0, 6)}...${a.slice(-4)}](${SOLSCAN}/account/${a})`,
  eth: (w) => ethers.formatEther(w) + ' ETH',
  sol: (l) => (l / LAMPORTS_PER_SOL).toFixed(4) + ' SOL',
  usd: (n) => '$' + Number(n).toFixed(2),
  pct: (n) => Number(n).toFixed(2) + '%',
};

// ============================================================
// User State
// ============================================================
const userStates = new Map();

function getState(userId) {
  if (!userStates.has(userId)) {
    userStates.set(userId, {
      chain: null,
      mode: null, // 'volume', 'grid', 'arb', or 'accumulate'
      // Token gate verification
      verified: null, // { address, balance, timestamp }
      base: {
        wallet: null,
        token: null, tokenSymbol: null, tokenDecimals: null,
        // Volume settings
        amount: ethers.parseEther('0.001'),
        cycles: 10, slippage: 20, delay: 30,
        isRunning: false, currentCycle: 0, feePaidFor: null,
        // Grid settings
        grid: null, // active grid state
        // Arb settings
        arb: null, // active arb state
        // Accumulate settings
        accum: null, // active accumulate state
      },
      solana: {
        wallet: null,
        token: null, tokenName: null,
        amount: 0.01 * LAMPORTS_PER_SOL,
        cycles: 10, slippage: 2000, delay: 30,
        isRunning: false, currentCycle: 0, feePaidFor: null,
        grid: null,
      },
      waiting_for: null,
      promptMsgId: null,
      lastActivity: Date.now(),
      riskAccepted: false, // must accept risk disclaimer before arb/grid
      pin: null, // optional PIN for session lock
      _wipeTimer: null,
    });
  }
  const s = userStates.get(userId);
  s.lastActivity = Date.now();
  resetWipeTimer(userId);
  return s;
}

function resetWipeTimer(userId) {
  const s = userStates.get(userId);
  if (!s) return;
  if (s._wipeTimer) clearTimeout(s._wipeTimer);
  s._wipeTimer = setTimeout(() => {
    // Only wipe if nothing is actively running
    const base = s.base;
    const sol = s.solana;
    const isActive = base.isRunning || sol.isRunning ||
      (base.grid && base.grid.running) || (sol.grid && sol.grid.running) ||
      (base.arb && base.arb.running);
    if (!isActive) {
      // If PIN is set, lock (encrypt) instead of full wipe
      if (s.pin) {
        if (base.wallet) lockWallet(s, 'base');
        if (sol.wallet) lockWallet(s, 'solana');
        console.log(`Locked keys for user ${userId} (inactivity, PIN-encrypted)`);
      } else {
        // No PIN — full wipe, keys are gone
        if (base.wallet) base.wallet = null;
        if (sol.wallet) sol.wallet = null;
        console.log(`Wiped keys for user ${userId} (inactivity, no PIN)`);
      }
    } else {
      // Reschedule if still active
      resetWipeTimer(userId);
    }
  }, WALLET_WIPE_MS);
}

function chainState(userId) {
  const s = getState(userId);
  return s[s.chain];
}

function isWhitelisted(username) {
  return WHITELISTED.includes((username || '').toLowerCase());
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================================
// Key Encryption (AES-256-GCM with user PIN)
// ============================================================
function deriveKey(pin, salt) {
  return crypto.pbkdf2Sync(pin, salt, 100000, 32, 'sha256');
}

function encryptKey(privateKeyHex, pin) {
  const salt = crypto.randomBytes(16);
  const key = deriveKey(pin, salt);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(privateKeyHex, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Pack: salt(16) + iv(12) + tag(16) + ciphertext
  return Buffer.concat([salt, iv, tag, encrypted]).toString('base64');
}

function decryptKey(blob, pin) {
  const buf = Buffer.from(blob, 'base64');
  const salt = buf.subarray(0, 16);
  const iv = buf.subarray(16, 28);
  const tag = buf.subarray(28, 44);
  const encrypted = buf.subarray(44);
  const key = deriveKey(pin, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

// Encrypt and store wallet, wipe raw key from state
function lockWallet(state, chain) {
  const cs = state[chain];
  if (!cs.wallet || !state.pin) return;
  if (cs._encryptedKey) return; // already locked

  let rawKey;
  if (chain === 'base') {
    rawKey = cs.wallet.privateKey;
  } else {
    rawKey = bs58Encode(cs.wallet.secretKey);
  }
  cs._encryptedKey = encryptKey(rawKey, state.pin);
  cs.wallet = null; // wipe raw key from memory
}

// Decrypt wallet back into state
function unlockWallet(state, chain, pin) {
  const cs = state[chain];
  if (!cs._encryptedKey) return false;
  try {
    const rawKey = decryptKey(cs._encryptedKey, pin);
    if (chain === 'base') {
      cs.wallet = baseImportWallet(rawKey);
    } else {
      cs.wallet = solImportWallet(rawKey);
    }
    return true;
  } catch {
    return false; // wrong PIN
  }
}

// Check if wallet is locked (encrypted but not in memory)
function isLocked(state, chain) {
  const cs = state[chain];
  return !cs.wallet && !!cs._encryptedKey;
}

// Lock wallet when trading stops
function lockOnStop(state) {
  if (state.pin) {
    if (state.base.wallet && !(state.base.isRunning || (state.base.grid && state.base.grid.running) || (state.base.arb && state.base.arb.running))) {
      lockWallet(state, 'base');
    }
    if (state.solana.wallet && !(state.solana.isRunning || (state.solana.grid && state.solana.grid.running))) {
      lockWallet(state, 'solana');
    }
  }
}

// ============================================================
// Token Gate (BACK Verification via Signature)
// ============================================================
function generateVerifyMessage(chatId) {
  const nonce = Math.random().toString(36).slice(2, 10);
  return `Silverback Verify\nChat: ${chatId}\nNonce: ${nonce}`;
}

async function verifySignatureAndCheckBack(message, signature) {
  const recoveredAddress = ethers.verifyMessage(message, signature);
  const back = new ethers.Contract(BACK_TOKEN, ERC20_ABI, baseProvider);
  const [bal, decimals] = await Promise.all([
    back.balanceOf(recoveredAddress),
    back.decimals(),
  ]);
  const required = ethers.parseUnits(BACK_GATE_AMOUNT.toString(), decimals);
  const balHuman = Number(ethers.formatUnits(bal, decimals));
  return {
    address: recoveredAddress,
    balance: balHuman,
    passed: bal >= required,
    required: BACK_GATE_AMOUNT,
  };
}

function isVerified(state) {
  if (!state.verified) return false;
  if (Date.now() - state.verified.timestamp > GATE_EXPIRY_MS) {
    state.verified = null;
    return false;
  }
  return state.verified.passed;
}

// ============================================================
// Risk Disclaimer
// ============================================================
const RISK_DISCLAIMER =
  'RISK DISCLAIMER\n' +
  '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\n' +
  'This bot trades real funds on-chain.\n\n' +
  'RISKS:\n' +
  '- Execution risk: trades may fail or be\n  front-run by MEV bots\n' +
  '- Slippage: price may move between quote\n  and execution\n' +
  '- Stuck inventory: if a sell fails after a buy,\n  you hold tokens at potential loss\n' +
  '- Gas drain: failed txs still cost gas\n' +
  '- Smart contract risk: DEX bugs or exploits\n\n' +
  'WALLET SECURITY:\n' +
  '- Set a PIN to encrypt your key (AES-256)\n' +
  '- Keys are NEVER saved to disk in plaintext\n' +
  '- Keys auto-lock after 2h of inactivity\n' +
  '- Without PIN: keys wiped after 2h idle\n' +
  '- With PIN: keys encrypted, enter PIN to resume\n' +
  '- FORGET YOUR PIN = KEY UNRECOVERABLE\n' +
  '- Use a DEDICATED trading wallet\n' +
  '- Only deposit what you can afford to lose\n\n' +
  'MINIMUM CAPITAL:\n' +
  '- Volume: 0.005 ETH / 0.05 SOL minimum\n' +
  '- Grid: $50+ USDC recommended\n' +
  '- Arb: $50+ ETH recommended\n' +
  '  ($10 or less will be eaten by gas)\n\n' +
  'By continuing you accept all risks.';

function riskKeyboard() {
  return new InlineKeyboard()
    .text('I Understand the Risks', 'accept_risk').row()
    .text('Cancel', 'main_menu');
}

function gateMessage(result) {
  if (result.passed) {
    return `Verified! ${result.balance.toLocaleString()} BACK in ${fmt.addrBase(result.address)}`;
  }
  return `Insufficient BACK tokens.\n` +
    `Required: ${BACK_GATE_AMOUNT.toLocaleString()} BACK\n` +
    `Found: ${result.balance.toLocaleString()} BACK in ${fmt.addrBase(result.address)}\n\n` +
    `Get BACK tokens to unlock premium features.`;
}

// ============================================================
// BASE: Wallet & Swap
// ============================================================
function baseCreateWallet() {
  return ethers.Wallet.createRandom().connect(baseProvider);
}

function baseImportWallet(key) {
  const hex = key.trim().startsWith('0x') ? key.trim() : '0x' + key.trim();
  return new ethers.Wallet(hex, baseProvider);
}

async function baseGetBalances(wallet, tokenAddr) {
  const ethBal = await baseProvider.getBalance(wallet.address);
  let tokenBal = 0n, symbol = '???', decimals = 18;
  if (tokenAddr) {
    try {
      const c = new ethers.Contract(tokenAddr, ERC20_ABI, baseProvider);
      [tokenBal, symbol, decimals] = await Promise.all([
        c.balanceOf(wallet.address), c.symbol().catch(() => '???'), c.decimals().catch(() => 18),
      ]);
    } catch {}
  }
  return { ethBal, tokenBal, symbol, decimals: Number(decimals) };
}

async function baseValidateToken(addr) {
  if (!ethers.isAddress(addr)) throw new Error('Invalid address');
  const c = new ethers.Contract(addr, ERC20_ABI, baseProvider);
  const [decimals, symbol, name] = await Promise.all([
    c.decimals(), c.symbol().catch(() => 'Unknown'), c.name().catch(() => 'Unknown'),
  ]);
  return { decimals: Number(decimals), symbol, name };
}

async function baseBuyETH(wallet, tokenAddr, amountEth, slippage) {
  const signer = wallet.connect(baseProvider);
  const r = baseRouter.connect(signer);
  const path = [WETH, tokenAddr];
  const amounts = await baseRouter.getAmountsOut(amountEth, path);
  const minOut = amounts[1] * BigInt(100 - slippage) / 100n;
  const deadline = Math.floor(Date.now() / 1000) + 1200;
  const tx = await r.swapExactETHForTokens(minOut, path, wallet.address, deadline, { value: amountEth, gasLimit: 300000n });
  const receipt = await tx.wait();
  return { hash: receipt.hash, amountOut: amounts[1] };
}

async function baseSellETH(wallet, tokenAddr, amountIn, slippage) {
  const signer = wallet.connect(baseProvider);
  const token = new ethers.Contract(tokenAddr, ERC20_ABI, signer);
  const allowance = await token.allowance(wallet.address, UNISWAP_V2_ROUTER);
  if (allowance < amountIn) {
    const appTx = await token.approve(UNISWAP_V2_ROUTER, ethers.MaxUint256);
    await appTx.wait();
  }
  const r = baseRouter.connect(signer);
  const path = [tokenAddr, WETH];
  const amounts = await baseRouter.getAmountsOut(amountIn, path);
  const minOut = amounts[1] * BigInt(100 - slippage) / 100n;
  const deadline = Math.floor(Date.now() / 1000) + 1200;
  const tx = await r.swapExactTokensForETH(amountIn, minOut, path, wallet.address, deadline, { gasLimit: 300000n });
  const receipt = await tx.wait();
  return { hash: receipt.hash, amountOut: amounts[1] };
}

// Swap USDC -> WETH (buy ETH with USDC)
async function baseBuyETHWithUSDC(wallet, amountUSDC, slippage) {
  const signer = wallet.connect(baseProvider);
  const usdc = new ethers.Contract(USDC_BASE, ERC20_ABI, signer);
  const allowance = await usdc.allowance(wallet.address, UNISWAP_V2_ROUTER);
  if (allowance < amountUSDC) {
    const appTx = await usdc.approve(UNISWAP_V2_ROUTER, ethers.MaxUint256);
    await appTx.wait();
  }
  const r = baseRouter.connect(signer);
  const path = [USDC_BASE, WETH];
  const amounts = await baseRouter.getAmountsOut(amountUSDC, path);
  const minOut = amounts[1] * BigInt(100 - slippage) / 100n;
  const deadline = Math.floor(Date.now() / 1000) + 1200;
  const tx = await r.swapExactTokensForTokens(amountUSDC, minOut, path, wallet.address, deadline, { gasLimit: 300000n });
  const receipt = await tx.wait();
  return { hash: receipt.hash, amountOut: amounts[1] };
}

// Swap WETH -> USDC (sell ETH for USDC)
async function baseSellETHForUSDC(wallet, amountETH, slippage) {
  const signer = wallet.connect(baseProvider);
  const r = baseRouter.connect(signer);
  const path = [WETH, USDC_BASE];
  const amounts = await baseRouter.getAmountsOut(amountETH, path);
  const minOut = amounts[1] * BigInt(100 - slippage) / 100n;
  const deadline = Math.floor(Date.now() / 1000) + 1200;
  const tx = await r.swapExactETHForTokens(minOut, path, wallet.address, deadline, { value: amountETH, gasLimit: 300000n });
  const receipt = await tx.wait();
  return { hash: receipt.hash, amountOut: amounts[1] };
}

// ============================================================
// ACCUMULATE: Price-reactive VIRTUAL <-> BACK trading
// ============================================================
// Strategy: Track VIRTUAL/BACK price ratio over time.
//   - VIRTUAL pumps (price above avg by threshold%) → buy BACK with VIRTUAL
//   - VIRTUAL dips (price below avg by threshold%) → sell some BACK for cheap VIRTUAL
//   - Flat → skip, save gas
// Net effect: accumulate BACK by buying when VIRTUAL is strong, reloading when cheap.

const PAIR_ABI = [
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
];
const VIRTUAL_BACK_PAIR = '0xE84923f730526819FAa23F4203CFFDd92F0636C3';

async function baseSwapTokenToToken(wallet, tokenIn, tokenOut, amountIn, slippage) {
  const signer = wallet.connect(baseProvider);
  const tokenContract = new ethers.Contract(tokenIn, ERC20_ABI, signer);
  const allowance = await tokenContract.allowance(wallet.address, UNISWAP_V2_ROUTER);
  if (allowance < amountIn) {
    const appTx = await tokenContract.approve(UNISWAP_V2_ROUTER, ethers.MaxUint256);
    await appTx.wait();
  }
  const r = baseRouter.connect(signer);
  const path = [tokenIn, tokenOut];
  const amounts = await baseRouter.getAmountsOut(amountIn, path);
  const minOut = amounts[1] * BigInt(100 - slippage) / 100n;
  const deadline = Math.floor(Date.now() / 1000) + 1200;
  const tx = await r.swapExactTokensForTokens(amountIn, minOut, path, wallet.address, deadline, { gasLimit: 350000n });
  const receipt = await tx.wait();
  return { hash: receipt.hash, amountOut: amounts[1] };
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function defaultAccumState() {
  return {
    running: false, cycle: 0, trades: 0, skips: 0,
    minAmount: ethers.parseUnits('1', 18), maxAmount: ethers.parseUnits('5', 18),
    minDelay: 120, maxDelay: 300, threshold: 2,
    recyclePercent: 15, slippage: 20,
    priceHistory: [],
    totalBackBought: 0, totalBackSold: 0, totalVirtualSpent: 0, totalVirtualRecovered: 0,
  };
}

// Get VIRTUAL price in BACK from pair reserves (how much BACK per 1 VIRTUAL)
let _pairToken0 = null; // cache token0 address
async function getVirtualPriceInBack() {
  const pair = new ethers.Contract(VIRTUAL_BACK_PAIR, PAIR_ABI, baseProvider);
  if (!_pairToken0) _pairToken0 = (await pair.token0()).toLowerCase();
  const [reserve0, reserve1] = await pair.getReserves();
  const virtualIsToken0 = _pairToken0 === VIRTUAL_TOKEN.toLowerCase();
  const virtualReserve = virtualIsToken0 ? Number(reserve0) : Number(reserve1);
  const backReserve = virtualIsToken0 ? Number(reserve1) : Number(reserve0);
  return backReserve / virtualReserve; // BACK per VIRTUAL
}

async function runAccumulateCycle(chatId) {
  const state = getState(chatId);
  const cs = state.base;
  const accum = cs.accum;

  if (!accum || !accum.running) return;

  accum.cycle++;
  const label = `[${accum.cycle}]`;

  try {
    // ── Price check ──────────────────────────────────────────
    const currentPrice = await getVirtualPriceInBack();
    accum.priceHistory.push(currentPrice);

    // Keep last N samples for rolling average
    const MAX_HISTORY = 20;
    if (accum.priceHistory.length > MAX_HISTORY) accum.priceHistory.shift();

    const avg = accum.priceHistory.reduce((a, b) => a + b, 0) / accum.priceHistory.length;
    const deviation = ((currentPrice - avg) / avg) * 100; // +% means VIRTUAL is strong

    // Need at least 3 data points before trading (build baseline)
    if (accum.priceHistory.length < 3) {
      const nextDelay = Math.floor(randomBetween(accum.minDelay, accum.maxDelay));
      await bot.api.sendMessage(chatId,
        `${label} SCAN price=${currentPrice.toFixed(4)} BACK/VIRTUAL | building baseline (${accum.priceHistory.length}/3)...`
      );
      if (accum.running) setTimeout(() => runAccumulateCycle(chatId), nextDelay * 1000);
      return;
    }

    const threshold = accum.threshold; // e.g. 2 means ±2%

    // ── VIRTUAL is UP → buy BACK (good rate) ────────────────
    if (deviation >= threshold) {
      const virtualContract = new ethers.Contract(VIRTUAL_TOKEN, ERC20_ABI, baseProvider);
      const virtualBal = await virtualContract.balanceOf(cs.wallet.address);

      if (virtualBal === 0n) {
        await bot.api.sendMessage(chatId, `${label} No VIRTUAL balance — waiting for reload signal.`);
      } else {
        // Randomize buy amount
        const minFloat = Number(ethers.formatUnits(accum.minAmount, 18));
        const maxFloat = Number(ethers.formatUnits(accum.maxAmount, 18));
        const randomAmt = randomBetween(minFloat, maxFloat);
        let buyAmount = ethers.parseUnits(randomAmt.toFixed(6), 18);
        if (buyAmount > virtualBal) buyAmount = virtualBal;

        let buyResult;
        for (let i = 1; i <= MAX_RETRIES; i++) {
          try { buyResult = await baseSwapTokenToToken(cs.wallet, VIRTUAL_TOKEN, BACK_TOKEN, buyAmount, accum.slippage); break; }
          catch (e) { if (i === MAX_RETRIES) throw e; await sleep(3000); }
        }

        const virtualSpent = Number(ethers.formatUnits(buyAmount, 18)).toFixed(4);
        const backReceived = Number(ethers.formatUnits(buyResult.amountOut, 18)).toFixed(2);
        accum.totalBackBought += Number(backReceived);
        accum.totalVirtualSpent += Number(virtualSpent);
        accum.trades++;

        await bot.api.sendMessage(chatId,
          `${label} BUY ${virtualSpent} VIRTUAL -> ${backReceived} BACK\nprice=${currentPrice.toFixed(4)} avg=${avg.toFixed(4)} dev=+${deviation.toFixed(1)}%\nTx: ${fmt.txBase(buyResult.hash)}`,
          { parse_mode: 'Markdown', disable_web_page_preview: true }
        );
      }

    // ── VIRTUAL is DOWN → reload VIRTUAL (it's cheap) ───────
    } else if (deviation <= -threshold) {
      const backContract = new ethers.Contract(BACK_TOKEN, ERC20_ABI, baseProvider);
      const backBal = await backContract.balanceOf(cs.wallet.address);
      const recycleAmount = backBal * BigInt(accum.recyclePercent) / 100n;

      if (recycleAmount === 0n || backBal === 0n) {
        await bot.api.sendMessage(chatId, `${label} No BACK to reload with — waiting for buy signal.`);
      } else {
        let sellResult;
        for (let i = 1; i <= MAX_RETRIES; i++) {
          try { sellResult = await baseSwapTokenToToken(cs.wallet, BACK_TOKEN, VIRTUAL_TOKEN, recycleAmount, accum.slippage); break; }
          catch (e) { if (i === MAX_RETRIES) throw e; await sleep(3000); }
        }

        const backSold = Number(ethers.formatUnits(recycleAmount, 18)).toFixed(2);
        const virtualRecovered = Number(ethers.formatUnits(sellResult.amountOut, 18)).toFixed(4);
        accum.totalBackSold += Number(backSold);
        accum.totalVirtualRecovered += Number(virtualRecovered);
        accum.trades++;

        await bot.api.sendMessage(chatId,
          `${label} RELOAD ${backSold} BACK -> ${virtualRecovered} VIRTUAL\nprice=${currentPrice.toFixed(4)} avg=${avg.toFixed(4)} dev=${deviation.toFixed(1)}%\nTx: ${fmt.txBase(sellResult.hash)}`,
          { parse_mode: 'Markdown', disable_web_page_preview: true }
        );
      }

    // ── FLAT → skip ─────────────────────────────────────────
    } else {
      accum.skips++;
      // Only notify every 5th skip to avoid spam
      if (accum.skips % 5 === 0) {
        await bot.api.sendMessage(chatId,
          `${label} SKIP (${accum.skips} total) | price=${currentPrice.toFixed(4)} avg=${avg.toFixed(4)} dev=${deviation.toFixed(1)}% | threshold=±${threshold}%`
        );
      }
    }

    // ── Schedule next cycle ─────────────────────────────────
    const nextDelay = Math.floor(randomBetween(accum.minDelay, accum.maxDelay));
    if (accum.running) {
      setTimeout(() => runAccumulateCycle(chatId), nextDelay * 1000);
    }

  } catch (error) {
    // Don't stop on transient errors — retry next cycle
    const nextDelay = Math.floor(randomBetween(accum.minDelay, accum.maxDelay));
    await bot.api.sendMessage(chatId, `${label} Error: ${error.message}\nRetrying in ${nextDelay}s...`);
    if (accum.running) {
      setTimeout(() => runAccumulateCycle(chatId), nextDelay * 1000);
    }
  }
}

async function startAccumulate(chatId) {
  const state = getState(chatId);
  const cs = state.base;
  if (!cs.wallet) return 'No wallet connected.';
  if (!state.riskAccepted) return '__SHOW_RISK__';
  if (cs.accum && cs.accum.running) return 'Already running.';

  // Check ETH for gas
  const ethBal = await baseProvider.getBalance(cs.wallet.address);
  if (ethBal < ethers.parseEther('0.001')) return 'Need ETH for gas.';

  // Check VIRTUAL balance
  const virtualContract = new ethers.Contract(VIRTUAL_TOKEN, ERC20_ABI, baseProvider);
  const virtualBal = await virtualContract.balanceOf(cs.wallet.address);

  // Check BACK balance
  const backContract = new ethers.Contract(BACK_TOKEN, ERC20_ABI, baseProvider);
  const backBal = await backContract.balanceOf(cs.wallet.address);

  if (virtualBal === 0n && backBal === 0n) return 'Need VIRTUAL or BACK balance to start.';

  if (!cs.accum) {
    cs.accum = defaultAccumState();
  }

  cs.accum.running = true;
  cs.accum.cycle = 0;
  cs.accum.trades = 0;
  cs.accum.skips = 0;
  cs.accum.priceHistory = [];
  cs.accum.totalBackBought = 0;
  cs.accum.totalBackSold = 0;
  cs.accum.totalVirtualSpent = 0;
  cs.accum.totalVirtualRecovered = 0;

  // Get initial price
  const price = await getVirtualPriceInBack();

  runAccumulateCycle(chatId);

  const vBal = Number(ethers.formatUnits(virtualBal, 18)).toFixed(2);
  const bBal = Number(ethers.formatUnits(backBal, 18)).toFixed(2);
  return fmt.header('ACCUMULATE STARTED') + '\n' +
    fmt.line('Strategy', 'Price-reactive BACK accumulation') + '\n' +
    fmt.line('Current Price', `${price.toFixed(4)} BACK/VIRTUAL`) + '\n' +
    fmt.line('Buy Range', `${ethers.formatUnits(cs.accum.minAmount, 18)}-${ethers.formatUnits(cs.accum.maxAmount, 18)} VIRTUAL`) + '\n' +
    fmt.line('Threshold', `±${cs.accum.threshold}%`) + '\n' +
    fmt.line('Check Every', `${cs.accum.minDelay}-${cs.accum.maxDelay}s`) + '\n' +
    fmt.line('Reload %', `${cs.accum.recyclePercent}%`) + '\n' +
    fmt.line('VIRTUAL Bal', vBal) + '\n' +
    fmt.line('BACK Bal', bBal) + '\n' + fmt.div() + '\n' +
    'Building price baseline (3 checks), then trading starts.';
}

function stopAccumulate(chatId) {
  const state = getState(chatId);
  const cs = state.base;
  if (!cs.accum || !cs.accum.running) return 'Not running.';
  cs.accum.running = false;
  const netBack = (cs.accum.totalBackBought - cs.accum.totalBackSold).toFixed(2);
  const netVirtual = (cs.accum.totalVirtualRecovered - cs.accum.totalVirtualSpent).toFixed(4);
  return fmt.header('ACCUMULATE STOPPED') + '\n' +
    fmt.line('Cycles', cs.accum.cycle) + '\n' +
    fmt.line('Trades', cs.accum.trades) + '\n' +
    fmt.line('Skips', cs.accum.skips) + '\n' +
    fmt.line('BACK Bought', cs.accum.totalBackBought.toFixed(2)) + '\n' +
    fmt.line('BACK Sold', cs.accum.totalBackSold.toFixed(2)) + '\n' +
    fmt.line('Net BACK', netBack) + '\n' +
    fmt.line('VIRTUAL Spent', cs.accum.totalVirtualSpent.toFixed(4)) + '\n' +
    fmt.line('VIRTUAL Recovered', cs.accum.totalVirtualRecovered.toFixed(4)) + '\n' +
    fmt.line('Net VIRTUAL', netVirtual) + '\n' + fmt.div();
}

function accumSettingsKeyboard(accum) {
  if (!accum) {
    return new InlineKeyboard()
      .text('Start Accumulate', 'start_accum').row()
      .text('Back', 'main_menu');
  }
  const minA = Number(ethers.formatUnits(accum.minAmount, 18)).toFixed(1);
  const maxA = Number(ethers.formatUnits(accum.maxAmount, 18)).toFixed(1);
  return new InlineKeyboard()
    .text(`Buy: ${minA}-${maxA} VIRTUAL`, 'accum_set_amount').row()
    .text(`Check: ${accum.minDelay}-${accum.maxDelay}s`, 'accum_set_delay')
    .text(`Threshold: ±${accum.threshold}%`, 'accum_set_threshold').row()
    .text(`Reload: ${accum.recyclePercent}%`, 'accum_set_recycle')
    .text(`Slippage: ${accum.slippage}%`, 'accum_set_slippage').row()
    .text('Back', 'main_menu');
}

// Get ETH price in USDC
async function baseGetETHPrice() {
  const oneETH = ethers.parseEther('1');
  const amounts = await baseRouter.getAmountsOut(oneETH, [WETH, USDC_BASE]);
  return Number(ethers.formatUnits(amounts[1], 6)); // USDC has 6 decimals
}

async function basePayFee(wallet) {
  const signer = wallet.connect(baseProvider);
  const tx = await signer.sendTransaction({ to: DEV_WALLET_BASE, value: ethers.parseEther(FEE_BASE), gasLimit: 21000n });
  const receipt = await tx.wait();
  return receipt.hash;
}

// ============================================================
// SOLANA: Wallet & Swap
// ============================================================
function solCreateWallet() { return Keypair.generate(); }

function solImportWallet(key) {
  const trimmed = key.trim();
  try { return Keypair.fromSecretKey(bs58Decode(trimmed)); }
  catch { return Keypair.fromSecretKey(Buffer.from(trimmed.replace('0x', ''), 'hex')); }
}

async function solGetBalance(wallet) { return solConnection.getBalance(wallet.publicKey); }

async function solValidateToken(mintStr) {
  await getMint(solConnection, new PublicKey(mintStr));
  return { mint: mintStr };
}

async function solGetQuote(inputMint, outputMint, amount, slippageBps) {
  const res = await fetch(`${JUP_QUOTE}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`);
  if (!res.ok) throw new Error('Quote failed: ' + res.statusText);
  const data = await res.json();
  if (!data.inAmount || !data.outAmount) throw new Error('Invalid quote');
  return data;
}

async function solSwap(quote, wallet) {
  const res = await fetch(JUP_SWAP, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quoteResponse: quote, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true }),
  });
  if (!res.ok) throw new Error('Swap failed: ' + res.statusText);
  const { swapTransaction } = await res.json();
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
  tx.sign([wallet]);
  const sig = await solConnection.sendRawTransaction(tx.serialize());
  const { value } = await solConnection.confirmTransaction(sig, 'confirmed');
  if (value.err) throw new Error('Transaction failed');
  return sig;
}

async function solPayFee(wallet) {
  const { blockhash } = await solConnection.getLatestBlockhash();
  const tx = new Transaction({ recentBlockhash: blockhash, feePayer: wallet.publicKey }).add(
    SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: new PublicKey(DEV_WALLET_SOL), lamports: FEE_SOL * LAMPORTS_PER_SOL })
  );
  tx.sign(wallet);
  const sig = await solConnection.sendRawTransaction(tx.serialize());
  await solConnection.confirmTransaction(sig, 'confirmed');
  return sig;
}

// Get SOL price in USDC
async function solGetSOLPrice() {
  const quote = await solGetQuote(SOL_MINT, USDC_SOL, LAMPORTS_PER_SOL, 100);
  return Number(quote.outAmount) / 1e6;
}

// ============================================================
// GRID TRADING ENGINE
// ============================================================

/*
  Grid trading on ETH/USDC (Base) or SOL/USDC (Solana):

  - User deposits USDC
  - Bot creates grid levels above and below current price
  - Levels below current price are "buy" orders (buy ETH/SOL when price drops)
  - Levels above current price are "sell" orders (sell ETH/SOL when price rises)
  - When price crosses a level, execute the trade and flip the level
  - Each completed round-trip (buy low + sell high) captures the spread as profit

  Grid state:
  - levels: array of { price, type: 'buy'|'sell', filled: bool, amountUSDC }
  - totalUSDC: total USDC deployed
  - totalProfit: accumulated profit in USDC
  - tradesCompleted: count
  - running: bool
  - pollInterval: ms between price checks
  - slippage: percent
*/

function createGrid(currentPrice, numLevels, rangePercent, totalUSDC) {
  const halfLevels = Math.floor(numLevels / 2);
  const stepSize = (currentPrice * rangePercent / 100) / halfLevels;
  const perLevel = totalUSDC / numLevels;
  const levels = [];

  // Buy levels below current price
  for (let i = halfLevels; i >= 1; i--) {
    levels.push({
      price: currentPrice - (stepSize * i),
      type: 'buy',
      filled: false,
      amountUSDC: perLevel,
      ethHeld: 0, // ETH/SOL bought at this level
    });
  }

  // Sell levels above current price
  for (let i = 1; i <= halfLevels; i++) {
    levels.push({
      price: currentPrice + (stepSize * i),
      type: 'sell',
      filled: false,
      amountUSDC: perLevel,
      ethHeld: 0,
    });
  }

  // Sort by price ascending
  levels.sort((a, b) => a.price - b.price);

  return {
    levels,
    basePrice: currentPrice,
    totalUSDC,
    usdcRemaining: totalUSDC,
    ethHeld: 0, // total ETH/SOL inventory
    totalProfit: 0,
    tradesCompleted: 0,
    running: false,
    pollInterval: 30, // seconds
    slippage: 3, // percent
    numLevels,
    rangePercent,
    lastPrice: currentPrice,
    startTime: Date.now(),
  };
}

async function runGridBase(chatId) {
  const state = getState(chatId);
  const cs = state.base;
  const grid = cs.grid;

  if (!grid || !grid.running) return;

  try {
    const currentPrice = await baseGetETHPrice();
    grid.lastPrice = currentPrice;

    // Check each level
    for (const level of grid.levels) {
      if (level.filled) continue;

      if (level.type === 'buy' && currentPrice <= level.price) {
        // Price dropped to buy level — buy ETH with USDC
        const usdcAmount = ethers.parseUnits(level.amountUSDC.toFixed(6), 6);
        const usdcContract = new ethers.Contract(USDC_BASE, ERC20_ABI, baseProvider);
        const usdcBal = await usdcContract.balanceOf(cs.wallet.address);

        if (usdcBal < usdcAmount) {
          await bot.api.sendMessage(chatId, `Grid: Insufficient USDC for buy at $${level.price.toFixed(2)}. Need ${level.amountUSDC.toFixed(2)} USDC.`);
          continue;
        }

        let result;
        for (let i = 1; i <= MAX_RETRIES; i++) {
          try { result = await baseBuyETHWithUSDC(cs.wallet, usdcAmount, grid.slippage); break; }
          catch (e) { if (i === MAX_RETRIES) throw e; await sleep(3000); }
        }

        const ethBought = Number(ethers.formatEther(result.amountOut));
        level.filled = true;
        level.ethHeld = ethBought;
        grid.ethHeld += ethBought;
        grid.usdcRemaining -= level.amountUSDC;

        await bot.api.sendMessage(chatId,
          `GRID BUY at $${level.price.toFixed(2)}\n` +
          `Bought: ${ethBought.toFixed(6)} ETH for ${level.amountUSDC.toFixed(2)} USDC\n` +
          `Tx: ${fmt.txBase(result.hash)}`,
          { parse_mode: 'Markdown', disable_web_page_preview: true }
        );

        // Flip to sell at next level up
        const sellPrice = level.price + (grid.basePrice * grid.rangePercent / 100 / Math.floor(grid.numLevels / 2));
        level.type = 'sell';
        level.price = sellPrice;
        level.filled = false;

      } else if (level.type === 'sell' && currentPrice >= level.price && level.ethHeld > 0) {
        // Price rose to sell level — sell ETH for USDC
        const ethToSell = ethers.parseEther(level.ethHeld.toFixed(18));

        let result;
        for (let i = 1; i <= MAX_RETRIES; i++) {
          try { result = await baseSellETHForUSDC(cs.wallet, ethToSell, grid.slippage); break; }
          catch (e) { if (i === MAX_RETRIES) throw e; await sleep(3000); }
        }

        const usdcReceived = Number(ethers.formatUnits(result.amountOut, 6));
        const profit = usdcReceived - level.amountUSDC;
        grid.totalProfit += profit;
        grid.ethHeld -= level.ethHeld;
        grid.usdcRemaining += usdcReceived;
        grid.tradesCompleted++;

        await bot.api.sendMessage(chatId,
          `GRID SELL at $${level.price.toFixed(2)}\n` +
          `Sold: ${level.ethHeld.toFixed(6)} ETH for ${usdcReceived.toFixed(2)} USDC\n` +
          `Profit: ${profit >= 0 ? '+' : ''}${profit.toFixed(2)} USDC\n` +
          `Total P&L: ${grid.totalProfit >= 0 ? '+' : ''}${grid.totalProfit.toFixed(2)} USDC (${grid.tradesCompleted} trades)\n` +
          `Tx: ${fmt.txBase(result.hash)}`,
          { parse_mode: 'Markdown', disable_web_page_preview: true }
        );

        // Flip back to buy at lower price
        const buyPrice = level.price - (grid.basePrice * grid.rangePercent / 100 / Math.floor(grid.numLevels / 2));
        level.type = 'buy';
        level.price = buyPrice;
        level.filled = false;
        level.ethHeld = 0;
        level.amountUSDC = usdcReceived; // Reinvest profit
      }
    }

    // Re-sort levels after price changes
    grid.levels.sort((a, b) => a.price - b.price);

  } catch (error) {
    console.error('Grid error:', error.message);
    await bot.api.sendMessage(chatId, `Grid error: ${error.message}`);
  }

  // Continue polling
  if (grid.running) {
    setTimeout(() => runGridBase(chatId), grid.pollInterval * 1000);
  }
}

async function runGridSolana(chatId) {
  const state = getState(chatId);
  const cs = state.solana;
  const grid = cs.grid;

  if (!grid || !grid.running) return;

  try {
    const currentPrice = await solGetSOLPrice();
    grid.lastPrice = currentPrice;

    for (const level of grid.levels) {
      if (level.filled) continue;

      if (level.type === 'buy' && currentPrice <= level.price) {
        // Buy SOL with USDC via Jupiter
        const usdcAmount = Math.round(level.amountUSDC * 1e6); // USDC 6 decimals

        let quote;
        for (let i = 1; i <= MAX_RETRIES; i++) {
          try { quote = await solGetQuote(USDC_SOL, SOL_MINT, usdcAmount, grid.slippage * 100); break; }
          catch (e) { if (i === MAX_RETRIES) throw e; await sleep(3000); }
        }
        let sig;
        for (let i = 1; i <= MAX_RETRIES; i++) {
          try { sig = await solSwap(quote, cs.wallet); break; }
          catch (e) { if (i === MAX_RETRIES) throw e; await sleep(3000); }
        }

        const solBought = Number(quote.outAmount) / LAMPORTS_PER_SOL;
        level.filled = true;
        level.ethHeld = solBought; // reusing field name for SOL
        grid.ethHeld += solBought;
        grid.usdcRemaining -= level.amountUSDC;

        await bot.api.sendMessage(chatId,
          `GRID BUY at $${level.price.toFixed(2)}\n` +
          `Bought: ${solBought.toFixed(4)} SOL for ${level.amountUSDC.toFixed(2)} USDC\n` +
          `Tx: ${fmt.txSol(sig)}`,
          { parse_mode: 'Markdown', disable_web_page_preview: true }
        );

        const stepSize = grid.basePrice * grid.rangePercent / 100 / Math.floor(grid.numLevels / 2);
        level.type = 'sell';
        level.price = level.price + stepSize;
        level.filled = false;

      } else if (level.type === 'sell' && currentPrice >= level.price && level.ethHeld > 0) {
        // Sell SOL for USDC
        const solAmount = Math.round(level.ethHeld * LAMPORTS_PER_SOL);

        let quote;
        for (let i = 1; i <= MAX_RETRIES; i++) {
          try { quote = await solGetQuote(SOL_MINT, USDC_SOL, solAmount, grid.slippage * 100); break; }
          catch (e) { if (i === MAX_RETRIES) throw e; await sleep(3000); }
        }
        let sig;
        for (let i = 1; i <= MAX_RETRIES; i++) {
          try { sig = await solSwap(quote, cs.wallet); break; }
          catch (e) { if (i === MAX_RETRIES) throw e; await sleep(3000); }
        }

        const usdcReceived = Number(quote.outAmount) / 1e6;
        const profit = usdcReceived - level.amountUSDC;
        grid.totalProfit += profit;
        grid.ethHeld -= level.ethHeld;
        grid.usdcRemaining += usdcReceived;
        grid.tradesCompleted++;

        const nativeLabel = 'SOL';
        await bot.api.sendMessage(chatId,
          `GRID SELL at $${level.price.toFixed(2)}\n` +
          `Sold: ${level.ethHeld.toFixed(4)} ${nativeLabel} for ${usdcReceived.toFixed(2)} USDC\n` +
          `Profit: ${profit >= 0 ? '+' : ''}${profit.toFixed(2)} USDC\n` +
          `Total P&L: ${grid.totalProfit >= 0 ? '+' : ''}${grid.totalProfit.toFixed(2)} USDC (${grid.tradesCompleted} trades)\n` +
          `Tx: ${fmt.txSol(sig)}`,
          { parse_mode: 'Markdown', disable_web_page_preview: true }
        );

        const stepSize = grid.basePrice * grid.rangePercent / 100 / Math.floor(grid.numLevels / 2);
        level.type = 'buy';
        level.price = level.price - stepSize;
        level.filled = false;
        level.ethHeld = 0;
        level.amountUSDC = usdcReceived;
      }
    }

    grid.levels.sort((a, b) => a.price - b.price);

  } catch (error) {
    console.error('Grid error:', error.message);
    await bot.api.sendMessage(chatId, `Grid error: ${error.message}`);
  }

  if (grid.running) {
    setTimeout(() => runGridSolana(chatId), grid.pollInterval * 1000);
  }
}

async function startGrid(chatId, username) {
  const state = getState(chatId);
  const chain = state.chain;
  const cs = state[chain];

  if (cs.grid && cs.grid.running) return 'Grid already running.';
  if (!cs.wallet) return 'No wallet. Go to Wallet menu.';
  if (!cs.grid) return 'Configure grid first via Grid Settings.';
  if (!state.riskAccepted) return '__SHOW_RISK__';

  // Token gate check for grid
  if (!isWhitelisted(username) && !isVerified(state)) {
    return `Grid requires BACK token verification.\n\n` +
      `Hold ${BACK_GATE_AMOUNT.toLocaleString()} BACK and verify via "Switch Mode" > "Verify BACK".`;
  }

  cs.grid.running = true;
  cs.grid.startTime = Date.now();

  if (chain === 'base') runGridBase(chatId);
  else runGridSolana(chatId);

  const native = chain === 'base' ? 'ETH' : 'SOL';
  return fmt.header('GRID STARTED') + '\n' +
    fmt.line('Chain', chain === 'base' ? 'Base' : 'Solana') + '\n' +
    fmt.line('Pair', `${native}/USDC`) + '\n' +
    fmt.line('Capital', fmt.usd(cs.grid.totalUSDC)) + '\n' +
    fmt.line('Levels', cs.grid.numLevels) + '\n' +
    fmt.line('Range', fmt.pct(cs.grid.rangePercent)) + '\n' +
    fmt.line('Base Price', fmt.usd(cs.grid.basePrice)) + '\n' +
    fmt.line('Poll', cs.grid.pollInterval + 's') + '\n' +
    fmt.line('Slippage', cs.grid.slippage + '%') + '\n' +
    fmt.div() + '\n' +
    'Grid levels:\n' +
    cs.grid.levels.map(l => `  ${l.type === 'buy' ? 'BUY' : 'SELL'} @ $${l.price.toFixed(2)} (${fmt.usd(l.amountUSDC)} ea)`).join('\n');
}

function stopGrid(chatId) {
  const state = getState(chatId);
  const cs = state[state.chain];
  if (cs.grid) cs.grid.running = false;
}

function buildGridStatus(chatId) {
  const state = getState(chatId);
  const cs = state[state.chain];
  const grid = cs.grid;
  if (!grid) return 'No grid configured.';

  const chain = state.chain;
  const native = chain === 'base' ? 'ETH' : 'SOL';
  const elapsed = grid.startTime ? Math.floor((Date.now() - grid.startTime) / 60000) : 0;

  let msg = fmt.header('GRID STATUS') + '\n\n';
  msg += fmt.line('Pair', `${native}/USDC`) + '\n';
  msg += fmt.line('Status', grid.running ? 'Running' : 'Stopped') + '\n';
  msg += fmt.line('Current Price', fmt.usd(grid.lastPrice)) + '\n';
  msg += fmt.line('Base Price', fmt.usd(grid.basePrice)) + '\n';
  msg += fmt.div() + '\n';
  msg += fmt.line('Capital', fmt.usd(grid.totalUSDC)) + '\n';
  msg += fmt.line('USDC Available', fmt.usd(grid.usdcRemaining)) + '\n';
  msg += fmt.line(`${native} Held`, grid.ethHeld.toFixed(6)) + '\n';
  msg += fmt.line(`${native} Value`, fmt.usd(grid.ethHeld * grid.lastPrice)) + '\n';
  msg += fmt.line('Total Value', fmt.usd(grid.usdcRemaining + grid.ethHeld * grid.lastPrice)) + '\n';
  msg += fmt.div() + '\n';
  msg += fmt.line('Trades', grid.tradesCompleted) + '\n';
  msg += fmt.line('P&L', `${grid.totalProfit >= 0 ? '+' : ''}${fmt.usd(grid.totalProfit)}`) + '\n';
  msg += fmt.line('ROI', fmt.pct(grid.totalUSDC > 0 ? (grid.totalProfit / grid.totalUSDC) * 100 : 0)) + '\n';
  msg += fmt.line('Runtime', elapsed + ' min') + '\n';
  msg += fmt.div() + '\n';
  msg += 'Levels:\n';
  for (const l of grid.levels) {
    const status = l.filled ? (l.type === 'sell' ? `holding ${l.ethHeld.toFixed(4)} ${native}` : 'filled') : 'waiting';
    msg += `  ${l.type === 'buy' ? 'BUY' : 'SELL'} $${l.price.toFixed(2)} [${status}]\n`;
  }

  return msg;
}

// ============================================================
// ARBITRAGE ENGINE (Base only — cross-DEX)
// ============================================================

/*
  Cross-DEX arbitrage on Base:
  - Scans WETH/USDC (or custom pairs) across Uniswap V2, Aerodrome, BaseSwap, SushiSwap
  - Finds price discrepancies between DEXes
  - Buys on cheaper DEX, sells on more expensive DEX
  - Profit = spread minus gas costs
  - Base-only (Solana uses Jupiter aggregator which already finds best price)
*/

async function getDexPrice(dex, tokenIn, tokenOut, amountIn) {
  try {
    if (dex.type === 'aerodrome') {
      const routes = [{ from: tokenIn, to: tokenOut, stable: false, factory: AERODROME_FACTORY }];
      const amounts = await dex.router.getAmountsOut(amountIn, routes);
      return { dex: dex.name, amountOut: amounts[amounts.length - 1], router: dex };
    } else {
      const path = [tokenIn, tokenOut];
      const amounts = await dex.router.getAmountsOut(amountIn, path);
      return { dex: dex.name, amountOut: amounts[1], router: dex };
    }
  } catch {
    return null; // DEX may not have this pair or liquidity
  }
}

async function scanArbOpportunity(tokenA, tokenB, amountIn) {
  // Get prices on all DEXes in parallel
  const [forwardPrices, reversePrices] = await Promise.all([
    Promise.all(DEXES.map(d => getDexPrice(d, tokenA, tokenB, amountIn))),
    Promise.all(DEXES.map(d => getDexPrice(d, tokenB, tokenA, 0n))), // placeholder, we'll use forward results
  ]);

  const validForward = forwardPrices.filter(Boolean);
  if (validForward.length < 2) return null;

  // Find best buy (most tokenB per tokenA) and worst buy (least tokenB per tokenA)
  validForward.sort((a, b) => {
    if (a.amountOut > b.amountOut) return -1;
    if (a.amountOut < b.amountOut) return 1;
    return 0;
  });

  const bestBuy = validForward[0]; // most tokenB output (buy here)
  const worstBuy = validForward[validForward.length - 1]; // least tokenB output

  // Now check: if we buy tokenB on bestBuy DEX, can we sell it back for more tokenA on another DEX?
  const tokenBAmount = bestBuy.amountOut;

  // Get reverse prices (sell tokenB back to tokenA) on all DEXes
  const sellPrices = await Promise.all(
    DEXES.map(d => getDexPrice(d, tokenB, tokenA, tokenBAmount))
  );

  const validSell = sellPrices.filter(Boolean);
  if (validSell.length === 0) return null;

  validSell.sort((a, b) => {
    if (a.amountOut > b.amountOut) return -1;
    if (a.amountOut < b.amountOut) return 1;
    return 0;
  });

  const bestSell = validSell[0];

  // Profit = what we get back - what we put in
  const profitWei = bestSell.amountOut - amountIn;
  if (profitWei <= 0n) return null;

  const profitBps = Number((profitWei * 10000n) / amountIn);

  return {
    buyDex: bestBuy.dex,
    buyRouter: bestBuy.router,
    sellDex: bestSell.dex,
    sellRouter: bestSell.router,
    amountIn,
    tokenBReceived: tokenBAmount,
    amountOut: bestSell.amountOut,
    profitWei,
    profitBps,
    tokenA,
    tokenB,
    allPrices: validForward.map(p => ({
      dex: p.dex,
      amountOut: p.amountOut,
    })),
  };
}

async function executeArb(wallet, opp) {
  const signer = wallet.connect(baseProvider);

  // Step 1: Buy tokenB on cheaper DEX
  let buyHash;
  const buyDex = DEXES.find(d => d.name === opp.buyDex);
  const deadline = Math.floor(Date.now() / 1000) + 300;
  const minBuyOut = opp.tokenBReceived * 97n / 100n; // 3% slippage

  if (opp.tokenA === WETH) {
    // Buying with ETH
    if (buyDex.type === 'aerodrome') {
      const routes = [{ from: WETH, to: opp.tokenB, stable: false, factory: AERODROME_FACTORY }];
      const r = buyDex.router.connect(signer);
      const tx = await r.swapExactETHForTokens(minBuyOut, routes, wallet.address, deadline, { value: opp.amountIn, gasLimit: 350000n });
      const receipt = await tx.wait();
      buyHash = receipt.hash;
    } else {
      const r = buyDex.router.connect(signer);
      const path = [WETH, opp.tokenB];
      const tx = await r.swapExactETHForTokens(minBuyOut, path, wallet.address, deadline, { value: opp.amountIn, gasLimit: 350000n });
      const receipt = await tx.wait();
      buyHash = receipt.hash;
    }
  } else {
    // Buying with ERC20
    const tokenContract = new ethers.Contract(opp.tokenA, ERC20_ABI, signer);
    const allowance = await tokenContract.allowance(wallet.address, buyDex.address);
    if (allowance < opp.amountIn) {
      const appTx = await tokenContract.approve(buyDex.address, ethers.MaxUint256);
      await appTx.wait();
    }
    if (buyDex.type === 'aerodrome') {
      const routes = [{ from: opp.tokenA, to: opp.tokenB, stable: false, factory: AERODROME_FACTORY }];
      const r = buyDex.router.connect(signer);
      const tx = await r.swapExactTokensForTokens(opp.amountIn, minBuyOut, routes, wallet.address, deadline, { gasLimit: 350000n });
      const receipt = await tx.wait();
      buyHash = receipt.hash;
    } else {
      const r = buyDex.router.connect(signer);
      const path = [opp.tokenA, opp.tokenB];
      const tx = await r.swapExactTokensForTokens(opp.amountIn, minBuyOut, path, wallet.address, deadline, { gasLimit: 350000n });
      const receipt = await tx.wait();
      buyHash = receipt.hash;
    }
  }

  // Step 2: Sell tokenB on more expensive DEX
  let sellHash;
  const sellDex = DEXES.find(d => d.name === opp.sellDex);

  // Get actual tokenB balance after buy
  const tokenBContract = new ethers.Contract(opp.tokenB, ERC20_ABI, signer);
  const tokenBBal = await tokenBContract.balanceOf(wallet.address);
  const minSellOut = opp.amountIn; // at minimum get back what we put in

  // Approve sell router
  const sellAllowance = await tokenBContract.allowance(wallet.address, sellDex.address);
  if (sellAllowance < tokenBBal) {
    const appTx = await tokenBContract.approve(sellDex.address, ethers.MaxUint256);
    await appTx.wait();
  }

  if (opp.tokenA === WETH) {
    // Selling back to ETH
    if (sellDex.type === 'aerodrome') {
      const routes = [{ from: opp.tokenB, to: WETH, stable: false, factory: AERODROME_FACTORY }];
      const r = sellDex.router.connect(signer);
      const tx = await r.swapExactTokensForETH(tokenBBal, minSellOut, routes, wallet.address, deadline, { gasLimit: 350000n });
      const receipt = await tx.wait();
      sellHash = receipt.hash;
    } else {
      const r = sellDex.router.connect(signer);
      const path = [opp.tokenB, WETH];
      const tx = await r.swapExactTokensForETH(tokenBBal, minSellOut, path, wallet.address, deadline, { gasLimit: 350000n });
      const receipt = await tx.wait();
      sellHash = receipt.hash;
    }
  } else {
    if (sellDex.type === 'aerodrome') {
      const routes = [{ from: opp.tokenB, to: opp.tokenA, stable: false, factory: AERODROME_FACTORY }];
      const r = sellDex.router.connect(signer);
      const tx = await r.swapExactTokensForTokens(tokenBBal, minSellOut, routes, wallet.address, deadline, { gasLimit: 350000n });
      const receipt = await tx.wait();
      sellHash = receipt.hash;
    } else {
      const r = sellDex.router.connect(signer);
      const path = [opp.tokenB, opp.tokenA];
      const tx = await r.swapExactTokensForTokens(tokenBBal, minSellOut, path, wallet.address, deadline, { gasLimit: 350000n });
      const receipt = await tx.wait();
      sellHash = receipt.hash;
    }
  }

  return { buyHash, sellHash };
}

function createArbState() {
  return {
    running: false,
    pairs: [{ tokenA: WETH, tokenB: USDC_BASE, label: 'ETH/USDC' }],
    tradeSize: ethers.parseEther('0.01'), // ETH per arb attempt
    minProfitBps: 30, // 0.3% minimum spread to execute
    pollInterval: 10, // seconds between scans
    totalProfit: 0, // in ETH
    tradesCompleted: 0,
    scansCompleted: 0,
    opportunitiesFound: 0,
    lastScan: null, // latest scan results
    startTime: null,
  };
}

async function runArbLoop(chatId) {
  const state = getState(chatId);
  const cs = state.base;
  const arb = cs.arb;

  if (!arb || !arb.running) return;

  try {
    arb.scansCompleted++;

    for (const pair of arb.pairs) {
      const opp = await scanArbOpportunity(pair.tokenA, pair.tokenB, arb.tradeSize);

      arb.lastScan = {
        pair: pair.label,
        time: Date.now(),
        opportunity: opp,
      };

      if (!opp || opp.profitBps < arb.minProfitBps) continue;

      // Estimate gas cost (~0.0002 ETH for 2 swaps on Base)
      const gasCost = ethers.parseEther('0.0003');
      if (opp.profitWei <= gasCost) continue;

      arb.opportunitiesFound++;

      // Check ETH balance for trade + gas
      const ethBal = await baseProvider.getBalance(cs.wallet.address);
      const needed = arb.tradeSize + gasCost;
      if (ethBal < needed) {
        await bot.api.sendMessage(chatId,
          `ARB: Insufficient ETH. Need ${Number(ethers.formatEther(needed)).toFixed(6)} ETH, have ${Number(ethers.formatEther(ethBal)).toFixed(6)} ETH.`
        );
        continue;
      }

      // Execute
      try {
        const result = await executeArb(cs.wallet, opp);
        const profitEth = Number(ethers.formatEther(opp.profitWei));
        arb.totalProfit += profitEth;
        arb.tradesCompleted++;

        await bot.api.sendMessage(chatId,
          fmt.header('ARB EXECUTED') + '\n\n' +
          fmt.line('Pair', pair.label) + '\n' +
          fmt.line('Buy', `${opp.buyDex}`) + '\n' +
          fmt.line('Sell', `${opp.sellDex}`) + '\n' +
          fmt.line('Spread', `${opp.profitBps} bps`) + '\n' +
          fmt.line('Profit', `+${profitEth.toFixed(6)} ETH`) + '\n' +
          fmt.line('Total P&L', `${arb.totalProfit >= 0 ? '+' : ''}${arb.totalProfit.toFixed(6)} ETH`) + '\n' +
          fmt.div() + '\n' +
          `Buy: ${fmt.txBase(result.buyHash)}\n` +
          `Sell: ${fmt.txBase(result.sellHash)}`,
          { parse_mode: 'Markdown', disable_web_page_preview: true }
        );
      } catch (execErr) {
        console.error('Arb execution error:', execErr.message);
        await bot.api.sendMessage(chatId, `ARB exec failed: ${execErr.message}`);
      }
    }

  } catch (error) {
    console.error('Arb scan error:', error.message);
    // Don't spam user with scan errors, just log
  }

  if (arb.running) {
    setTimeout(() => runArbLoop(chatId), arb.pollInterval * 1000);
  }
}

async function startArb(chatId, username) {
  const state = getState(chatId);
  const cs = state.base;

  if (cs.arb && cs.arb.running) return 'Arb already running.';
  if (!cs.wallet) return 'No wallet. Go to Wallet menu.';
  if (!state.riskAccepted) return '__SHOW_RISK__';

  // Token gate check
  if (!isWhitelisted(username) && !isVerified(state)) {
    return 'Arb requires BACK token verification.\n\n' +
      `Hold ${BACK_GATE_AMOUNT.toLocaleString()} BACK in your main wallet and verify via the Verify button.\n\n` +
      'Use "Switch Mode" > "Verify BACK" to verify your holdings.';
  }

  if (!cs.arb) cs.arb = createArbState();

  cs.arb.running = true;
  cs.arb.startTime = Date.now();
  runArbLoop(chatId);

  let msg = fmt.header('ARB STARTED') + '\n\n';
  msg += fmt.line('Chain', 'Base') + '\n';
  msg += fmt.line('Pairs', cs.arb.pairs.map(p => p.label).join(', ')) + '\n';
  msg += fmt.line('Trade Size', Number(ethers.formatEther(cs.arb.tradeSize)).toFixed(4) + ' ETH') + '\n';
  msg += fmt.line('Min Spread', cs.arb.minProfitBps + ' bps') + '\n';
  msg += fmt.line('Poll', cs.arb.pollInterval + 's') + '\n';
  msg += fmt.line('DEXes', DEXES.map(d => d.name).join(', ')) + '\n';
  msg += fmt.div() + '\n';
  msg += 'Scanning for cross-DEX arbitrage opportunities...';
  return msg;
}

function stopArb(chatId) {
  const state = getState(chatId);
  if (state.base.arb) state.base.arb.running = false;
}

function buildArbStatus(chatId) {
  const state = getState(chatId);
  const arb = state.base.arb;
  if (!arb) return 'No arb configured. Start from Arb mode.';

  const elapsed = arb.startTime ? Math.floor((Date.now() - arb.startTime) / 60000) : 0;

  let msg = fmt.header('ARB STATUS') + '\n\n';
  msg += fmt.line('Status', arb.running ? 'Scanning' : 'Stopped') + '\n';
  msg += fmt.line('Pairs', arb.pairs.map(p => p.label).join(', ')) + '\n';
  msg += fmt.line('Trade Size', Number(ethers.formatEther(arb.tradeSize)).toFixed(4) + ' ETH') + '\n';
  msg += fmt.line('Min Spread', arb.minProfitBps + ' bps') + '\n';
  msg += fmt.line('Poll', arb.pollInterval + 's') + '\n';
  msg += fmt.div() + '\n';
  msg += fmt.line('Scans', arb.scansCompleted) + '\n';
  msg += fmt.line('Opportunities', arb.opportunitiesFound) + '\n';
  msg += fmt.line('Trades', arb.tradesCompleted) + '\n';
  msg += fmt.line('P&L', `${arb.totalProfit >= 0 ? '+' : ''}${arb.totalProfit.toFixed(6)} ETH`) + '\n';
  msg += fmt.line('Runtime', elapsed + ' min') + '\n';

  if (arb.lastScan) {
    msg += fmt.div() + '\n';
    msg += 'Last scan:\n';
    if (arb.lastScan.opportunity) {
      const opp = arb.lastScan.opportunity;
      msg += `  Best spread: ${opp.profitBps} bps\n`;
      msg += `  Buy: ${opp.buyDex} | Sell: ${opp.sellDex}\n`;
      for (const p of opp.allPrices) {
        const label = opp.tokenA === WETH ? 'USDC' : 'ETH';
        msg += `  ${p.dex}: ${Number(ethers.formatUnits(p.amountOut, opp.tokenB === USDC_BASE ? 6 : 18)).toFixed(4)} ${label}\n`;
      }
    } else {
      msg += '  No profitable spread found\n';
    }
  }

  return msg;
}

// ============================================================
// VOLUME TRADING (existing)
// ============================================================
async function runVolumeCycle(chatId) {
  const state = getState(chatId);
  const chain = state.chain;
  const cs = state[chain];

  if (!cs.isRunning || cs.currentCycle >= cs.cycles) {
    cs.isRunning = false;
    await bot.api.sendMessage(chatId,
      fmt.header('VOLUME COMPLETE') + '\n' + fmt.line('Cycles', `${cs.currentCycle}/${cs.cycles}`) + '\n' + fmt.div(),
      { parse_mode: 'Markdown', disable_web_page_preview: true }
    );
    return;
  }

  cs.currentCycle++;
  const label = `[${cs.currentCycle}/${cs.cycles}]`;

  try {
    if (chain === 'base') {
      const bal = await baseProvider.getBalance(cs.wallet.address);
      if (bal < ethers.parseEther('0.002')) { cs.isRunning = false; await bot.api.sendMessage(chatId, `${label} Low ETH.`); return; }

      let buyResult;
      for (let i = 1; i <= MAX_RETRIES; i++) {
        try { buyResult = await baseBuyETH(cs.wallet, cs.token, cs.amount, cs.slippage); break; }
        catch (e) { if (i === MAX_RETRIES) throw e; await sleep(3000); }
      }
      const buyAmt = ethers.formatUnits(buyResult.amountOut, cs.tokenDecimals || 18);
      await bot.api.sendMessage(chatId,
        `${label} BUY ${fmt.eth(cs.amount)} -> ${Number(buyAmt).toFixed(4)} ${cs.tokenSymbol}\nTx: ${fmt.txBase(buyResult.hash)}`,
        { parse_mode: 'Markdown', disable_web_page_preview: true }
      );

      await sleep(cs.delay * 1000);

      const token = new ethers.Contract(cs.token, ERC20_ABI, baseProvider);
      const tokenBal = await token.balanceOf(cs.wallet.address);
      if (tokenBal === 0n) return;

      let sellResult;
      for (let i = 1; i <= MAX_RETRIES; i++) {
        try { sellResult = await baseSellETH(cs.wallet, cs.token, tokenBal, cs.slippage); break; }
        catch (e) { if (i === MAX_RETRIES) throw e; await sleep(3000); }
      }
      await bot.api.sendMessage(chatId,
        `${label} SELL -> ${Number(ethers.formatEther(sellResult.amountOut)).toFixed(6)} ETH\nTx: ${fmt.txBase(sellResult.hash)}`,
        { parse_mode: 'Markdown', disable_web_page_preview: true }
      );
    } else {
      const bal = await solGetBalance(cs.wallet);
      if (bal < 0.005 * LAMPORTS_PER_SOL) { cs.isRunning = false; await bot.api.sendMessage(chatId, `${label} Low SOL.`); return; }

      let buyQuote;
      for (let i = 1; i <= MAX_RETRIES; i++) {
        try { buyQuote = await solGetQuote(SOL_MINT, cs.token, cs.amount, cs.slippage); break; }
        catch (e) { if (i === MAX_RETRIES) throw e; await sleep(3000); }
      }
      let buySig;
      for (let i = 1; i <= MAX_RETRIES; i++) {
        try { buySig = await solSwap(buyQuote, cs.wallet); break; }
        catch (e) { if (i === MAX_RETRIES) throw e; await sleep(3000); }
      }
      await bot.api.sendMessage(chatId,
        `${label} BUY ${fmt.sol(cs.amount)}\nTx: ${fmt.txSol(buySig)}`,
        { parse_mode: 'Markdown', disable_web_page_preview: true }
      );

      await sleep(cs.delay * 1000);

      let sellQuote;
      for (let i = 1; i <= MAX_RETRIES; i++) {
        try { sellQuote = await solGetQuote(cs.token, SOL_MINT, buyQuote.outAmount, cs.slippage); break; }
        catch (e) { if (i === MAX_RETRIES) throw e; await sleep(3000); }
      }
      let sellSig;
      for (let i = 1; i <= MAX_RETRIES; i++) {
        try { sellSig = await solSwap(sellQuote, cs.wallet); break; }
        catch (e) { if (i === MAX_RETRIES) throw e; await sleep(3000); }
      }
      await bot.api.sendMessage(chatId,
        `${label} SELL -> ${(sellQuote.outAmount / LAMPORTS_PER_SOL).toFixed(4)} SOL\nTx: ${fmt.txSol(sellSig)}`,
        { parse_mode: 'Markdown', disable_web_page_preview: true }
      );
    }

    if (cs.currentCycle < cs.cycles) await sleep(cs.delay * 1000);
    if (cs.isRunning) runVolumeCycle(chatId);

  } catch (error) {
    cs.isRunning = false;
    await bot.api.sendMessage(chatId, `${label} Error: ${error.message}\nStopped.`);
  }
}

async function startVolume(chatId, username) {
  const state = getState(chatId);
  const cs = state[state.chain];
  if (cs.isRunning) return 'Already running.';
  if (!cs.wallet) return 'No wallet.';
  if (!cs.token) return 'No token set.';
  if (!state.riskAccepted) return '__SHOW_RISK__';

  const needsFee = !isWhitelisted(username) && cs.feePaidFor !== cs.token;
  if (needsFee) {
    try {
      if (state.chain === 'base') await basePayFee(cs.wallet);
      else await solPayFee(cs.wallet);
      cs.feePaidFor = cs.token;
    } catch (e) { return 'Fee failed: ' + e.message; }
  }

  cs.isRunning = true;
  cs.currentCycle = 0;
  runVolumeCycle(chatId);

  const amountStr = state.chain === 'base' ? fmt.eth(cs.amount) : fmt.sol(cs.amount);
  return fmt.header('VOLUME STARTED') + '\n' +
    fmt.line('Token', cs.tokenSymbol || cs.token?.slice(0, 10)) + '\n' +
    fmt.line('Amount', amountStr) + '\n' +
    fmt.line('Cycles', cs.cycles) + '\n' + fmt.div();
}

function stopVolume(chatId) {
  const state = getState(chatId);
  state[state.chain].isRunning = false;
}

// ============================================================
// Keyboards
// ============================================================
function chainKeyboard() {
  return new InlineKeyboard()
    .text('Base (ETH)', 'chain_base')
    .text('Solana (SOL)', 'chain_solana');
}

function modeKeyboard(chain) {
  const kb = new InlineKeyboard()
    .text('Volume Bot', 'mode_volume')
    .text('Grid Trade', 'mode_grid');
  if (chain === 'base') kb.text('Arb Bot', 'mode_arb');
  if (chain === 'base') kb.row().text('Accumulate BACK', 'mode_accumulate');
  kb.row().text('Verify BACK', 'verify_back');
  return kb;
}

function mainKeyboard(mode) {
  const kb = new InlineKeyboard()
    .text('Wallet', 'wallet_menu').text('Settings', 'settings_menu').row();
  if (mode === 'volume') {
    kb.text('Start Volume', 'start_volume').text('Stop', 'stop_volume').row();
  } else if (mode === 'grid') {
    kb.text('Start Grid', 'start_grid').text('Stop Grid', 'stop_grid').row();
    kb.text('Grid Status', 'grid_status').row();
  } else if (mode === 'arb') {
    kb.text('Start Arb', 'start_arb').text('Stop Arb', 'stop_arb').row();
    kb.text('Arb Status', 'arb_status').row();
  } else if (mode === 'accumulate') {
    kb.text('Start Accum', 'start_accum').text('Stop Accum', 'stop_accum').row();
    kb.text('Accum Status', 'accum_status').row();
  }
  kb.text('Status', 'status').text('Refresh', 'refresh').row();
  kb.text('Switch Mode', 'switch_mode').text('Switch Chain', 'switch_chain');
  return kb;
}

function walletKeyboard(state, chain) {
  const kb = new InlineKeyboard();
  if (isLocked(state, chain)) {
    kb.text('Unlock Wallet', 'unlock_wallet').row();
  } else {
    kb.text('Show Private Key', 'export_wallet').row();
    kb.text('Import Wallet', 'import_wallet').row();
    kb.text('New Wallet', 'new_wallet').row();
  }
  kb.text(state.pin ? 'Change PIN' : 'Set PIN', 'set_pin').row();
  kb.text('Back', 'main_menu');
  return kb;
}

function volumeSettingsKeyboard(cs, chain) {
  const amtLabel = chain === 'base' ? `${ethers.formatEther(cs.amount)} ETH` : `${(cs.amount / LAMPORTS_PER_SOL).toFixed(4)} SOL`;
  const slipLabel = chain === 'base' ? `${cs.slippage}%` : `${(cs.slippage / 100).toFixed(1)}%`;
  return new InlineKeyboard()
    .text(`Token: ${cs.tokenSymbol || cs.tokenName || 'Not Set'}`, 'set_token').row()
    .text(`Amount: ${amtLabel}`, 'set_amount')
    .text(`Cycles: ${cs.cycles}`, 'set_cycles').row()
    .text(`Delay: ${cs.delay}s`, 'set_delay')
    .text(`Slippage: ${slipLabel}`, 'set_slippage').row()
    .text('Back', 'main_menu');
}

function gridSettingsKeyboard(grid) {
  if (!grid) {
    return new InlineKeyboard()
      .text('Setup Grid', 'grid_setup').row()
      .text('Back', 'main_menu');
  }
  return new InlineKeyboard()
    .text(`Capital: ${fmt.usd(grid.totalUSDC)}`, 'grid_set_capital').row()
    .text(`Levels: ${grid.numLevels}`, 'grid_set_levels')
    .text(`Range: ${fmt.pct(grid.rangePercent)}`, 'grid_set_range').row()
    .text(`Poll: ${grid.pollInterval}s`, 'grid_set_poll')
    .text(`Slippage: ${grid.slippage}%`, 'grid_set_slippage').row()
    .text('Reconfigure Grid', 'grid_setup').row()
    .text('Back', 'main_menu');
}

function arbSettingsKeyboard(arb) {
  if (!arb) {
    return new InlineKeyboard()
      .text('Initialize Arb', 'arb_init').row()
      .text('Back', 'main_menu');
  }
  return new InlineKeyboard()
    .text(`Trade Size: ${Number(ethers.formatEther(arb.tradeSize)).toFixed(4)} ETH`, 'arb_set_size').row()
    .text(`Min Spread: ${arb.minProfitBps} bps`, 'arb_set_profit').row()
    .text(`Poll: ${arb.pollInterval}s`, 'arb_set_poll').row()
    .text(`Pairs: ${arb.pairs.map(p => p.label).join(', ')}`, 'arb_add_pair').row()
    .text('Back', 'main_menu');
}

// ============================================================
// Message Builders
// ============================================================
async function buildMainMsg(chatId) {
  const state = getState(chatId);
  const chain = state.chain;
  const cs = state[chain];
  const mode = state.mode;
  const chainName = chain === 'base' ? 'Base' : 'Solana';
  const modeName = mode === 'grid' ? 'Grid Trade' : 'Volume';

  let msg = fmt.header('SILVERBACK BOT') + '\n\n';
  msg += fmt.line('Chain', chainName) + '\n';
  msg += fmt.line('Mode', modeName) + '\n';

  if (chain === 'base') {
    if (!cs.wallet) cs.wallet = baseCreateWallet();
    const { ethBal, tokenBal, symbol, decimals } = await baseGetBalances(cs.wallet, cs.token);
    msg += fmt.line('Wallet', fmt.addrBase(cs.wallet.address)) + '\n';
    msg += fmt.line('ETH', fmt.eth(ethBal)) + '\n';

    if (mode === 'grid') {
      const usdcContract = new ethers.Contract(USDC_BASE, ERC20_ABI, baseProvider);
      const usdcBal = await usdcContract.balanceOf(cs.wallet.address);
      msg += fmt.line('USDC', Number(ethers.formatUnits(usdcBal, 6)).toFixed(2)) + '\n';
      if (cs.grid && cs.grid.running) {
        msg += fmt.div() + '\n';
        msg += `Grid running: ${cs.grid.tradesCompleted} trades, P&L: ${cs.grid.totalProfit >= 0 ? '+' : ''}${fmt.usd(cs.grid.totalProfit)}`;
      }
    } else {
      if (cs.token) {
        msg += fmt.line('Token', `${symbol} (${fmt.addrBase(cs.token)})`) + '\n';
        msg += fmt.line('Token Bal', `${Number(ethers.formatUnits(tokenBal, decimals)).toFixed(4)} ${symbol}`) + '\n';
      }
    }

    if (mode === 'arb') {
      if (cs.arb && cs.arb.running) {
        msg += fmt.div() + '\n';
        msg += `Arb running: ${cs.arb.tradesCompleted} trades, P&L: ${cs.arb.totalProfit >= 0 ? '+' : ''}${cs.arb.totalProfit.toFixed(6)} ETH\n`;
        msg += `Scans: ${cs.arb.scansCompleted} | Opportunities: ${cs.arb.opportunitiesFound}`;
      }
    }

    // Show BACK verification status
    if (state.verified) {
      msg += '\n' + fmt.line('BACK', `${state.verified.balance.toLocaleString()} (verified)`);
    }

    if (ethBal === 0n) msg += '\nFund wallet:\n' + fmt.mono(cs.wallet.address);
  } else {
    if (!cs.wallet) cs.wallet = solCreateWallet();
    const bal = await solGetBalance(cs.wallet);
    msg += fmt.line('Wallet', fmt.addrSol(cs.wallet.publicKey.toBase58())) + '\n';
    msg += fmt.line('SOL', fmt.sol(bal)) + '\n';

    if (mode === 'grid' && cs.grid && cs.grid.running) {
      msg += fmt.div() + '\n';
      msg += `Grid running: ${cs.grid.tradesCompleted} trades, P&L: ${cs.grid.totalProfit >= 0 ? '+' : ''}${fmt.usd(cs.grid.totalProfit)}`;
    } else if (cs.token) {
      msg += fmt.line('Token', cs.tokenName || cs.token.slice(0, 12)) + '\n';
    }

    if (bal === 0) msg += '\nFund wallet:\n' + fmt.mono(cs.wallet.publicKey.toBase58());
  }

  return msg;
}

// ============================================================
// Helpers
// ============================================================
async function safeDelete(chatId, msgId) {
  try { if (msgId) await bot.api.deleteMessage(chatId, msgId); } catch {}
}

async function send(chatId, text, keyboard) {
  return bot.api.sendMessage(chatId, text, {
    parse_mode: 'Markdown', disable_web_page_preview: true, reply_markup: keyboard,
  });
}

async function editOrReply(ctx, text, keyboard) {
  try {
    await ctx.editMessageText(text, { parse_mode: 'Markdown', disable_web_page_preview: true, reply_markup: keyboard });
  } catch {
    await ctx.reply(text, { parse_mode: 'Markdown', disable_web_page_preview: true, reply_markup: keyboard });
  }
}

// ============================================================
// Commands
// ============================================================
bot.command('start', async (ctx) => {
  const state = getState(ctx.chat.id);
  if (!state.chain) {
    await ctx.reply(fmt.header('SILVERBACK BOT') + '\n\nSelect chain:', { parse_mode: 'Markdown', reply_markup: chainKeyboard() });
  } else if (!state.mode) {
    await ctx.reply(fmt.header('SELECT MODE') + '\n\nVolume: Buy-sell cycles for volume\nGrid: Automated spread trading\nArb: Cross-DEX arbitrage (Base only)', { parse_mode: 'Markdown', reply_markup: modeKeyboard(state.chain) });
  } else {
    const msg = await buildMainMsg(ctx.chat.id);
    await ctx.reply(msg, { parse_mode: 'Markdown', disable_web_page_preview: true, reply_markup: mainKeyboard(state.mode) });
  }
});

bot.command('stop', async (ctx) => {
  const state = getState(ctx.chat.id);
  if (state.chain && state.mode === 'volume') stopVolume(ctx.chat.id);
  if (state.chain && state.mode === 'grid') stopGrid(ctx.chat.id);
  if (state.chain && state.mode === 'arb') stopArb(ctx.chat.id);
  await ctx.reply('Stopped.');
});

bot.command('status', async (ctx) => {
  const state = getState(ctx.chat.id);
  if (!state.chain || !state.mode) { await ctx.reply('Use /start first.'); return; }
  if (state.mode === 'grid') {
    const msg = buildGridStatus(ctx.chat.id);
    await ctx.reply(msg, { parse_mode: 'Markdown', disable_web_page_preview: true, reply_markup: mainKeyboard(state.mode) });
  } else if (state.mode === 'arb') {
    const msg = buildArbStatus(ctx.chat.id);
    await ctx.reply(msg, { parse_mode: 'Markdown', disable_web_page_preview: true, reply_markup: mainKeyboard(state.mode) });
  } else {
    const msg = await buildMainMsg(ctx.chat.id);
    await ctx.reply(msg, { parse_mode: 'Markdown', disable_web_page_preview: true, reply_markup: mainKeyboard(state.mode) });
  }
});

bot.command('help', async (ctx) => {
  await ctx.reply(
    fmt.header('HELP') + '\n\n' +
    '/start - Main menu\n/stop - Stop all\n/status - View status\n\n' +
    'VOLUME MODE:\nBuy-sell cycles to generate token volume.\n\n' +
    'GRID MODE:\nAutomated spread trading on ETH/USDC or SOL/USDC.\n' +
    'Sets buy orders below price, sell orders above.\n' +
    'Profits from each completed buy-sell spread.\n\n' +
    'ARB MODE (Base only):\nCross-DEX arbitrage across Uniswap, Aerodrome,\n' +
    'BaseSwap & SushiSwap. Scans for price spreads\n' +
    'and executes profitable trades automatically.\n\n' +
    fmt.div() + '\n' +
    'TOKEN GATE (BACK):\n' +
    `Volume: Free\n` +
    `Grid & Arb: ${BACK_GATE_AMOUNT.toLocaleString()} BACK required\n\n` +
    'Verify by signing a message with your BACK-holding\n' +
    'wallet. Use "Verify BACK" in mode selection.',
    { parse_mode: 'Markdown' }
  );
});

// ============================================================
// Callback Handler
// ============================================================
bot.on('callback_query:data', async (ctx) => {
  const chatId = ctx.chat.id;
  const data = ctx.callbackQuery.data;
  const state = getState(chatId);
  const username = ctx.from.username;

  switch (data) {
    // ---- Chain & Mode Selection ----
    case 'chain_base': {
      state.chain = 'base';
      if (!state.mode) {
        await editOrReply(ctx, fmt.header('SELECT MODE') + '\n\nVolume: Buy-sell cycles\nGrid: Spread trading\nArb: Cross-DEX arbitrage (Base)', modeKeyboard('base'));
      } else {
        const msg = await buildMainMsg(chatId);
        await editOrReply(ctx, msg, mainKeyboard(state.mode));
      }
      break;
    }
    case 'chain_solana': {
      state.chain = 'solana';
      if (state.mode === 'arb') state.mode = null; // arb is Base-only
      if (!state.mode) {
        await editOrReply(ctx, fmt.header('SELECT MODE') + '\n\nVolume: Buy-sell cycles\nGrid: Spread trading', modeKeyboard('solana'));
      } else {
        const msg = await buildMainMsg(chatId);
        await editOrReply(ctx, msg, mainKeyboard(state.mode));
      }
      break;
    }
    case 'switch_chain': {
      await editOrReply(ctx, fmt.header('SWITCH CHAIN'), chainKeyboard());
      break;
    }
    case 'mode_volume': {
      state.mode = 'volume';
      const msg = await buildMainMsg(chatId);
      await editOrReply(ctx, msg, mainKeyboard('volume'));
      break;
    }
    case 'mode_grid': {
      state.mode = 'grid';
      const msg = await buildMainMsg(chatId);
      await editOrReply(ctx, msg, mainKeyboard('grid'));
      break;
    }
    case 'mode_arb': {
      if (state.chain !== 'base') {
        await ctx.answerCallbackQuery({ text: 'Arb is Base-only.', show_alert: true });
        break;
      }
      state.mode = 'arb';
      state.chain = 'base'; // force Base
      const msg3 = await buildMainMsg(chatId);
      await editOrReply(ctx, msg3, mainKeyboard('arb'));
      break;
    }
    case 'mode_accumulate': {
      if (state.chain !== 'base') {
        await ctx.answerCallbackQuery({ text: 'Accumulate is Base-only.', show_alert: true });
        break;
      }
      state.mode = 'accumulate';
      state.chain = 'base';
      const msg4 = await buildMainMsg(chatId);
      await editOrReply(ctx, msg4, mainKeyboard('accumulate'));
      break;
    }
    case 'start_accum': {
      const response = await startAccumulate(chatId);
      if (response === '__SHOW_RISK__') {
        state._pendingAction = 'start_accum';
        await editOrReply(ctx, fmt.header('RISK DISCLAIMER') + '\n\nTrading involves risk. You may lose funds.\nSlippage, failed txns, and price impact can reduce value.\n\nAccept to continue.', new InlineKeyboard().text('Accept Risk', 'accept_risk').text('Cancel', 'main_menu'));
      } else {
        await send(chatId, response, mainKeyboard('accumulate'));
      }
      break;
    }
    case 'stop_accum': {
      const stopMsg = stopAccumulate(chatId);
      await editOrReply(ctx, stopMsg, mainKeyboard('accumulate'));
      break;
    }
    case 'accum_status': {
      const cs5 = state.base;
      const a = cs5.accum;
      if (!a) { await editOrReply(ctx, 'No accumulate session.', mainKeyboard('accumulate')); break; }
      const netBack = (a.totalBackBought - a.totalBackSold).toFixed(2);
      const netVirtual = ((a.totalVirtualRecovered || 0) - a.totalVirtualSpent).toFixed(4);
      const lastPrice = a.priceHistory && a.priceHistory.length > 0 ? a.priceHistory[a.priceHistory.length - 1].toFixed(4) : 'n/a';
      const avg = a.priceHistory && a.priceHistory.length > 0
        ? (a.priceHistory.reduce((x, y) => x + y, 0) / a.priceHistory.length).toFixed(4) : 'n/a';
      const statusMsg = fmt.header('ACCUMULATE STATUS') + '\n' +
        fmt.line('Running', a.running ? 'YES' : 'NO') + '\n' +
        fmt.line('Cycles', a.cycle) + '\n' +
        fmt.line('Trades', a.trades || 0) + '\n' +
        fmt.line('Skips', a.skips || 0) + '\n' +
        fmt.line('Price', `${lastPrice} BACK/VIRTUAL`) + '\n' +
        fmt.line('Avg', `${avg} BACK/VIRTUAL`) + '\n' +
        fmt.div() + '\n' +
        fmt.line('BACK Bought', a.totalBackBought.toFixed(2)) + '\n' +
        fmt.line('BACK Sold', a.totalBackSold.toFixed(2)) + '\n' +
        fmt.line('Net BACK', netBack) + '\n' +
        fmt.line('VIRTUAL Spent', a.totalVirtualSpent.toFixed(4)) + '\n' +
        fmt.line('VIRTUAL Recovered', (a.totalVirtualRecovered || 0).toFixed(4)) + '\n' +
        fmt.line('Net VIRTUAL', netVirtual) + '\n' + fmt.div();
      await editOrReply(ctx, statusMsg, mainKeyboard('accumulate'));
      break;
    }
    case 'accum_settings': {
      const cs6 = state.base;
      if (!cs6.accum) {
        cs6.accum = defaultAccumState();
      }
      await editOrReply(ctx, fmt.header('ACCUMULATE SETTINGS'), accumSettingsKeyboard(cs6.accum));
      break;
    }
    case 'accum_set_amount': {
      state.waiting_for = 'accum_amount';
      await send(chatId, 'Enter buy range (min-max VIRTUAL per trade).\nExample: 1-5');
      break;
    }
    case 'accum_set_delay': {
      state.waiting_for = 'accum_delay';
      await send(chatId, 'Enter price check interval (min-max seconds).\nExample: 120-300');
      break;
    }
    case 'accum_set_threshold': {
      state.waiting_for = 'accum_threshold';
      await send(chatId, 'Enter price deviation threshold (%).\nBuy BACK when VIRTUAL is up this %, reload when down.\nExample: 2');
      break;
    }
    case 'accum_set_recycle': {
      state.waiting_for = 'accum_recycle';
      await send(chatId, 'Enter reload % (amount of BACK sold to reload VIRTUAL when price dips).\nExample: 15');
      break;
    }
    case 'accum_set_slippage': {
      state.waiting_for = 'accum_slippage';
      await send(chatId, 'Enter slippage % for swaps.\nExample: 20');
      break;
    }
    case 'switch_mode': {
      await editOrReply(ctx, fmt.header('SELECT MODE') + '\n\nVolume: Buy-sell cycles\nGrid: Spread trading\nArb: Cross-DEX arbitrage (Base)\nAccumulate: Price-reactive BACK accumulation', modeKeyboard(state.chain));
      break;
    }

    // ---- Navigation ----
    case 'main_menu': {
      if (!state.chain) { await editOrReply(ctx, 'Select chain:', chainKeyboard()); break; }
      if (!state.mode) { await editOrReply(ctx, 'Select mode:', modeKeyboard()); break; }
      const msg = await buildMainMsg(chatId);
      await editOrReply(ctx, msg, mainKeyboard(state.mode));
      break;
    }

    case 'wallet_menu': {
      const cs = chainState(chatId);
      const secNote = state.pin
        ? '\n\nKey AES-256 encrypted with your PIN.\nAuto-locks after 2h idle. Enter PIN to unlock.\nForgot PIN = key unrecoverable.'
        : '\n\nKeys in memory only — wiped after 2h idle.\nSet a PIN to encrypt your key at rest.';
      const pinNote = state.pin ? '\nPIN: Set (remember it!)' : '\nPIN: Not set (strongly recommended)';
      const lockNote = isLocked(state, state.chain) ? '\nStatus: LOCKED — enter PIN to unlock' : '';

      if (isLocked(state, state.chain)) {
        // Wallet exists but is encrypted — show address from encrypted state if we saved it
        const label = state.chain === 'base' ? 'BASE' : 'SOLANA';
        const savedAddr = cs._savedAddress || 'Unknown';
        await editOrReply(ctx,
          fmt.header(`${label} WALLET`) + '\n\n' + fmt.line('Address', savedAddr) + lockNote + pinNote + secNote,
          walletKeyboard(state, state.chain)
        );
      } else if (state.chain === 'base') {
        if (!cs.wallet) cs.wallet = baseCreateWallet();
        const addr = cs.wallet.address;
        cs._savedAddress = fmt.addrBase(addr); // save for locked display
        await editOrReply(ctx,
          fmt.header('BASE WALLET') + '\n\n' + fmt.line('Address', fmt.addrBase(addr)) + '\n\n' + fmt.mono(addr) + pinNote + secNote,
          walletKeyboard(state, state.chain)
        );
      } else {
        if (!cs.wallet) cs.wallet = solCreateWallet();
        const addr = cs.wallet.publicKey.toBase58();
        cs._savedAddress = fmt.addrSol(addr);
        await editOrReply(ctx,
          fmt.header('SOLANA WALLET') + '\n\n' + fmt.line('Address', fmt.addrSol(addr)) + '\n\n' + fmt.mono(addr) + pinNote + secNote,
          walletKeyboard(state, state.chain)
        );
      }
      break;
    }

    case 'settings_menu': {
      const cs = chainState(chatId);
      if (state.mode === 'accumulate') {
        if (!cs.accum) cs.accum = defaultAccumState();
        await editOrReply(ctx, fmt.header('ACCUMULATE SETTINGS'), accumSettingsKeyboard(cs.accum));
      } else if (state.mode === 'arb') {
        await editOrReply(ctx, fmt.header('ARB SETTINGS'), arbSettingsKeyboard(cs.arb));
      } else if (state.mode === 'grid') {
        await editOrReply(ctx, fmt.header('GRID SETTINGS'), gridSettingsKeyboard(cs.grid));
      } else {
        await editOrReply(ctx, fmt.header('VOLUME SETTINGS'), volumeSettingsKeyboard(cs, state.chain));
      }
      break;
    }

    // ---- Wallet ----
    case 'export_wallet': {
      const cs = chainState(chatId);
      if (!cs.wallet) { await ctx.answerCallbackQuery({ text: 'No wallet.', show_alert: true }); break; }
      const key = state.chain === 'base' ? cs.wallet.privateKey : bs58Encode(cs.wallet.secretKey);
      const keyMsg = await bot.api.sendMessage(chatId,
        'Private key (auto-deletes 30s):\n\n' + fmt.mono(key) + '\n\nNEVER share.',
        { parse_mode: 'Markdown' }
      );
      setTimeout(() => safeDelete(chatId, keyMsg.message_id), 30000);
      await ctx.answerCallbackQuery({ text: 'Key shown - 30s' });
      break;
    }

    case 'import_wallet': {
      state.waiting_for = 'import_wallet';
      const hint = state.chain === 'base' ? 'Send hex private key.' : 'Send base58 private key.';
      const p = await bot.api.sendMessage(chatId, hint + '\nDeleted after import.');
      state.promptMsgId = p.message_id;
      await ctx.answerCallbackQuery();
      break;
    }

    case 'new_wallet': {
      const cs = chainState(chatId);
      if (state.chain === 'base') cs.wallet = baseCreateWallet();
      else cs.wallet = solCreateWallet();
      cs.feePaidFor = null;
      cs._encryptedKey = null; // clear old encrypted key
      const addr = state.chain === 'base' ? cs.wallet.address : cs.wallet.publicKey.toBase58();
      const addrFmt = state.chain === 'base' ? fmt.addrBase(addr) : fmt.addrSol(addr);
      cs._savedAddress = addrFmt;
      const pinHint = state.pin ? '' : '\n\nSet a PIN to encrypt your key.\nWithout a PIN, key is wiped after 2h idle.';
      await editOrReply(ctx, fmt.header('NEW WALLET') + '\n\n' + fmt.line('Address', addrFmt) + '\n\n' + fmt.mono(addr) + pinHint, walletKeyboard(state, state.chain));
      break;
    }

    case 'set_pin': {
      state.waiting_for = 'set_pin';
      const p6 = await bot.api.sendMessage(chatId,
        'Set a 4-8 digit PIN to encrypt your wallet.\n\n' +
        'IMPORTANT:\n' +
        '- Your PIN encrypts your private key with AES-256\n' +
        '- We DO NOT store your PIN anywhere\n' +
        '- If you forget your PIN, your key CANNOT be recovered\n' +
        '- Write it down or save it somewhere safe\n\n' +
        'Send your PIN now (digits only):');
      state.promptMsgId = p6.message_id;
      await ctx.answerCallbackQuery();
      break;
    }

    case 'unlock_wallet': {
      state.waiting_for = 'unlock_wallet';
      const p6 = await bot.api.sendMessage(chatId, 'Wallet is locked.\nEnter your PIN to decrypt and unlock.');
      state.promptMsgId = p6.message_id;
      await ctx.answerCallbackQuery();
      break;
    }

    // ---- Volume Settings ----
    case 'set_token': {
      state.waiting_for = 'set_token';
      const p = await bot.api.sendMessage(chatId, state.chain === 'base' ? 'Send ERC-20 address.' : 'Send SPL mint address.');
      state.promptMsgId = p.message_id;
      await ctx.answerCallbackQuery();
      break;
    }
    case 'set_amount': {
      state.waiting_for = 'set_amount';
      const cs = chainState(chatId);
      const unit = state.chain === 'base' ? 'ETH' : 'SOL';
      const cur = state.chain === 'base' ? ethers.formatEther(cs.amount) : (cs.amount / LAMPORTS_PER_SOL).toFixed(4);
      const p = await bot.api.sendMessage(chatId, `Current: ${cur} ${unit}\nSend new amount.`);
      state.promptMsgId = p.message_id;
      await ctx.answerCallbackQuery();
      break;
    }
    case 'set_cycles': {
      state.waiting_for = 'set_cycles';
      const p = await bot.api.sendMessage(chatId, `Current: ${chainState(chatId).cycles}\nSend cycles.`);
      state.promptMsgId = p.message_id;
      await ctx.answerCallbackQuery();
      break;
    }
    case 'set_delay': {
      state.waiting_for = 'set_delay';
      const p = await bot.api.sendMessage(chatId, `Current: ${chainState(chatId).delay}s\nSend seconds.`);
      state.promptMsgId = p.message_id;
      await ctx.answerCallbackQuery();
      break;
    }
    case 'set_slippage': {
      state.waiting_for = 'set_slippage';
      const cs = chainState(chatId);
      const cur = state.chain === 'base' ? cs.slippage + '%' : (cs.slippage / 100) + '%';
      const p = await bot.api.sendMessage(chatId, `Current: ${cur}\nSend % (e.g. 20).`);
      state.promptMsgId = p.message_id;
      await ctx.answerCallbackQuery();
      break;
    }

    // ---- Grid Settings ----
    case 'grid_setup': {
      state.waiting_for = 'grid_setup';
      const native = state.chain === 'base' ? 'ETH' : 'SOL';
      const p = await bot.api.sendMessage(chatId,
        `Setup ${native}/USDC grid.\n\n` +
        `Send: capital levels range\n` +
        `Example: 500 10 5\n\n` +
        `= $500 USDC, 10 grid levels, 5% range\n` +
        `(5 buy levels below price, 5 sell above)`
      );
      state.promptMsgId = p.message_id;
      await ctx.answerCallbackQuery();
      break;
    }
    case 'grid_set_capital': {
      state.waiting_for = 'grid_set_capital';
      const p = await bot.api.sendMessage(chatId, `Current: ${fmt.usd(chainState(chatId).grid?.totalUSDC || 0)}\nSend USDC amount.`);
      state.promptMsgId = p.message_id;
      await ctx.answerCallbackQuery();
      break;
    }
    case 'grid_set_levels': {
      state.waiting_for = 'grid_set_levels';
      const p = await bot.api.sendMessage(chatId, `Current: ${chainState(chatId).grid?.numLevels || 0}\nSend number (even, e.g. 10).`);
      state.promptMsgId = p.message_id;
      await ctx.answerCallbackQuery();
      break;
    }
    case 'grid_set_range': {
      state.waiting_for = 'grid_set_range';
      const p = await bot.api.sendMessage(chatId, `Current: ${fmt.pct(chainState(chatId).grid?.rangePercent || 0)}\nSend % (e.g. 5).`);
      state.promptMsgId = p.message_id;
      await ctx.answerCallbackQuery();
      break;
    }
    case 'grid_set_poll': {
      state.waiting_for = 'grid_set_poll';
      const p = await bot.api.sendMessage(chatId, `Current: ${chainState(chatId).grid?.pollInterval || 30}s\nSend seconds.`);
      state.promptMsgId = p.message_id;
      await ctx.answerCallbackQuery();
      break;
    }
    case 'grid_set_slippage': {
      state.waiting_for = 'grid_set_slippage';
      const p = await bot.api.sendMessage(chatId, `Current: ${chainState(chatId).grid?.slippage || 3}%\nSend %.`);
      state.promptMsgId = p.message_id;
      await ctx.answerCallbackQuery();
      break;
    }

    // ---- Bot Control ----
    case 'start_volume': {
      const response = await startVolume(chatId, username);
      if (response === '__SHOW_RISK__') {
        state._pendingAction = 'start_volume';
        await send(chatId, RISK_DISCLAIMER, riskKeyboard());
      } else {
        await send(chatId, response, mainKeyboard('volume'));
      }
      await ctx.answerCallbackQuery();
      break;
    }
    case 'stop_volume': {
      stopVolume(chatId);
      lockOnStop(state);
      await ctx.answerCallbackQuery({ text: 'Stopped.' });
      const msg = await buildMainMsg(chatId);
      await editOrReply(ctx, msg, mainKeyboard('volume'));
      break;
    }
    case 'start_grid': {
      const response = await startGrid(chatId, username);
      if (response === '__SHOW_RISK__') {
        state._pendingAction = 'start_grid';
        await send(chatId, RISK_DISCLAIMER, riskKeyboard());
      } else {
        await send(chatId, response, mainKeyboard('grid'));
      }
      await ctx.answerCallbackQuery();
      break;
    }
    case 'stop_grid': {
      stopGrid(chatId);
      lockOnStop(state);
      await ctx.answerCallbackQuery({ text: 'Grid stopped.' });
      const msg = buildGridStatus(chatId);
      await send(chatId, msg, mainKeyboard('grid'));
      break;
    }
    case 'grid_status': {
      const msg = buildGridStatus(chatId);
      await send(chatId, msg, mainKeyboard('grid'));
      await ctx.answerCallbackQuery();
      break;
    }

    // ---- Arb Control ----
    case 'start_arb': {
      const response = await startArb(chatId, username);
      if (response === '__SHOW_RISK__') {
        state._pendingAction = 'start_arb';
        await send(chatId, RISK_DISCLAIMER, riskKeyboard());
      } else {
        await send(chatId, response, mainKeyboard('arb'));
      }
      await ctx.answerCallbackQuery();
      break;
    }
    case 'stop_arb': {
      stopArb(chatId);
      lockOnStop(state);
      await ctx.answerCallbackQuery({ text: 'Arb stopped.' });
      const arbMsg = buildArbStatus(chatId);
      await send(chatId, arbMsg, mainKeyboard('arb'));
      break;
    }
    case 'arb_status': {
      const arbMsg = buildArbStatus(chatId);
      await send(chatId, arbMsg, mainKeyboard('arb'));
      await ctx.answerCallbackQuery();
      break;
    }
    case 'arb_init': {
      const cs4 = chainState(chatId);
      cs4.arb = createArbState();
      await editOrReply(ctx, fmt.header('ARB INITIALIZED') + '\n\nDefault: ETH/USDC, 0.01 ETH per trade, 30 bps min spread.', arbSettingsKeyboard(cs4.arb));
      break;
    }
    case 'arb_set_size': {
      state.waiting_for = 'arb_set_size';
      const cs4 = chainState(chatId);
      const p4 = await bot.api.sendMessage(chatId, `Current: ${Number(ethers.formatEther(cs4.arb?.tradeSize || 0n)).toFixed(4)} ETH\nSend ETH amount per arb trade.`);
      state.promptMsgId = p4.message_id;
      await ctx.answerCallbackQuery();
      break;
    }
    case 'arb_set_profit': {
      state.waiting_for = 'arb_set_profit';
      const cs4 = chainState(chatId);
      const p4 = await bot.api.sendMessage(chatId, `Current: ${cs4.arb?.minProfitBps || 30} bps\nSend min spread in basis points (e.g. 30 = 0.3%).`);
      state.promptMsgId = p4.message_id;
      await ctx.answerCallbackQuery();
      break;
    }
    case 'arb_set_poll': {
      state.waiting_for = 'arb_set_poll';
      const cs4 = chainState(chatId);
      const p4 = await bot.api.sendMessage(chatId, `Current: ${cs4.arb?.pollInterval || 10}s\nSend seconds between scans.`);
      state.promptMsgId = p4.message_id;
      await ctx.answerCallbackQuery();
      break;
    }
    case 'arb_add_pair': {
      state.waiting_for = 'arb_add_pair';
      const cs4 = chainState(chatId);
      let pairList = cs4.arb ? cs4.arb.pairs.map(p => p.label).join(', ') : 'none';
      const p4 = await bot.api.sendMessage(chatId, `Current pairs: ${pairList}\n\nSend token address to add as pair vs WETH.\nOr send "reset" to go back to ETH/USDC only.`);
      state.promptMsgId = p4.message_id;
      await ctx.answerCallbackQuery();
      break;
    }

    // ---- Risk Acceptance ----
    case 'accept_risk': {
      state.riskAccepted = true;
      const pending = state._pendingAction;
      state._pendingAction = null;

      if (pending === 'start_volume') {
        const resp = await startVolume(chatId, username);
        await send(chatId, resp, mainKeyboard('volume'));
      } else if (pending === 'start_grid') {
        const resp = await startGrid(chatId, username);
        await send(chatId, resp, mainKeyboard('grid'));
      } else if (pending === 'start_arb') {
        const resp = await startArb(chatId, username);
        await send(chatId, resp, mainKeyboard('arb'));
      } else if (pending === 'start_accum') {
        const resp = await startAccumulate(chatId);
        await send(chatId, resp, mainKeyboard('accumulate'));
      } else {
        await editOrReply(ctx, 'Risks accepted. You can now start trading.', mainKeyboard(state.mode || 'volume'));
      }
      await ctx.answerCallbackQuery({ text: 'Risks accepted.' });
      break;
    }

    // ---- BACK Verification ----
    case 'verify_back': {
      const verifyMsg = generateVerifyMessage(chatId);
      state.waiting_for = 'verify_signature';
      state._verifyMessage = verifyMsg;
      const p5 = await bot.api.sendMessage(chatId,
        fmt.header('VERIFY BACK HOLDINGS') + '\n\n' +
        '1. Copy this message:\n\n' +
        fmt.mono(verifyMsg) + '\n\n' +
        '2. Sign it with your BACK-holding wallet\n' +
        '   (MetaMask > Settings > Sign Message)\n\n' +
        '3. Paste the signature (0x...) here\n\n' +
        `Required: ${BACK_GATE_AMOUNT.toLocaleString()} BACK`,
        { parse_mode: 'Markdown' }
      );
      state.promptMsgId = p5.message_id;
      await ctx.answerCallbackQuery();
      break;
    }

    case 'status': {
      if (state.mode === 'grid') {
        const msg = buildGridStatus(chatId);
        await editOrReply(ctx, msg, mainKeyboard('grid'));
      } else if (state.mode === 'arb') {
        const msg = buildArbStatus(chatId);
        await editOrReply(ctx, msg, mainKeyboard('arb'));
      } else {
        const msg = await buildMainMsg(chatId);
        await editOrReply(ctx, msg, mainKeyboard(state.mode));
      }
      break;
    }
    case 'refresh': {
      const msg = await buildMainMsg(chatId);
      await editOrReply(ctx, msg, mainKeyboard(state.mode));
      break;
    }
  }

  try { await ctx.answerCallbackQuery(); } catch {}
});

// ============================================================
// Text Input Handler
// ============================================================
bot.on('message:text', async (ctx) => {
  const chatId = ctx.chat.id;
  const text = ctx.message.text;
  const msgId = ctx.message.message_id;
  const state = getState(chatId);

  if (!state.waiting_for || text.startsWith('/')) return;

  const action = state.waiting_for;
  state.waiting_for = null;
  const cs = chainState(chatId);
  const chain = state.chain;

  switch (action) {
    case 'import_wallet': {
      try {
        if (chain === 'base') cs.wallet = baseImportWallet(text);
        else cs.wallet = solImportWallet(text);
        cs.feePaidFor = null;
        cs._encryptedKey = null;
        await safeDelete(chatId, msgId);
        await safeDelete(chatId, state.promptMsgId);
        const addr = chain === 'base' ? cs.wallet.address : cs.wallet.publicKey.toBase58();
        const addrFmt = chain === 'base' ? fmt.addrBase(addr) : fmt.addrSol(addr);
        cs._savedAddress = addrFmt;
        const pinHint = state.pin ? '' : '\n\nSet a PIN in Wallet menu to encrypt your key.\nWithout a PIN, keys are wiped after 2h idle.';
        await send(chatId, 'Wallet imported.\n' + fmt.line('Address', addrFmt) + pinHint, mainKeyboard(state.mode));
      } catch (e) {
        await safeDelete(chatId, msgId);
        await safeDelete(chatId, state.promptMsgId);
        await send(chatId, 'Invalid key: ' + e.message);
      }
      break;
    }

    case 'set_token': {
      try {
        if (chain === 'base') {
          const info = await baseValidateToken(text.trim());
          cs.token = text.trim(); cs.tokenSymbol = info.symbol; cs.tokenDecimals = info.decimals;
          await safeDelete(chatId, msgId); await safeDelete(chatId, state.promptMsgId);
          await send(chatId, `Token: ${info.name} (${info.symbol})`, volumeSettingsKeyboard(cs, chain));
        } else {
          await solValidateToken(text.trim());
          cs.token = text.trim(); cs.tokenName = text.trim().slice(0, 8) + '...';
          await safeDelete(chatId, msgId); await safeDelete(chatId, state.promptMsgId);
          await send(chatId, 'Token set.', volumeSettingsKeyboard(cs, chain));
        }
      } catch (e) {
        await safeDelete(chatId, msgId); await safeDelete(chatId, state.promptMsgId);
        await send(chatId, 'Invalid: ' + e.message);
      }
      break;
    }

    case 'set_amount': {
      try {
        const val = parseFloat(text.trim());
        if (isNaN(val) || val <= 0) throw new Error('positive');
        if (chain === 'base') cs.amount = ethers.parseEther(text.trim());
        else cs.amount = Math.round(val * LAMPORTS_PER_SOL);
        await safeDelete(chatId, msgId); await safeDelete(chatId, state.promptMsgId);
        const d = chain === 'base' ? fmt.eth(cs.amount) : fmt.sol(cs.amount);
        await send(chatId, `Amount: ${d}`, volumeSettingsKeyboard(cs, chain));
      } catch {
        await safeDelete(chatId, msgId); await safeDelete(chatId, state.promptMsgId);
        await send(chatId, 'Invalid amount.');
      }
      break;
    }

    case 'set_cycles': {
      const n = parseInt(text.trim());
      if (isNaN(n) || n <= 0) { await ctx.reply('Positive number.'); break; }
      cs.cycles = n;
      await safeDelete(chatId, msgId); await safeDelete(chatId, state.promptMsgId);
      await send(chatId, `Cycles: ${n}`, volumeSettingsKeyboard(cs, chain));
      break;
    }

    case 'set_delay': {
      const n = parseInt(text.trim());
      if (isNaN(n) || n <= 0) { await ctx.reply('Positive number.'); break; }
      cs.delay = n;
      await safeDelete(chatId, msgId); await safeDelete(chatId, state.promptMsgId);
      await send(chatId, `Delay: ${n}s`, volumeSettingsKeyboard(cs, chain));
      break;
    }

    case 'set_slippage': {
      const n = parseFloat(text.trim());
      if (isNaN(n) || n < 0.1 || n > 100) { await ctx.reply('0.1-100.'); break; }
      if (chain === 'base') cs.slippage = Math.round(n);
      else cs.slippage = Math.round(n * 100);
      await safeDelete(chatId, msgId); await safeDelete(chatId, state.promptMsgId);
      const d = chain === 'base' ? cs.slippage + '%' : (cs.slippage / 100) + '%';
      await send(chatId, `Slippage: ${d}`, volumeSettingsKeyboard(cs, chain));
      break;
    }

    // ---- Accumulate Settings Input ----
    case 'accum_amount': {
      try {
        const parts = text.trim().split('-');
        if (parts.length !== 2) throw new Error('Format: min-max (e.g. 1-5)');
        const min = parseFloat(parts[0]);
        const max = parseFloat(parts[1]);
        if (isNaN(min) || isNaN(max) || min <= 0 || max <= min) throw new Error('Need positive numbers, max > min');
        const cs = chainState(chatId);
        if (!cs.accum) cs.accum = defaultAccumState();
        cs.accum.minAmount = ethers.parseUnits(parts[0].trim(), 18);
        cs.accum.maxAmount = ethers.parseUnits(parts[1].trim(), 18);
        await safeDelete(chatId, msgId); await safeDelete(chatId, state.promptMsgId);
        await send(chatId, `Buy range: ${min}-${max} VIRTUAL per trade`, accumSettingsKeyboard(cs.accum));
      } catch (e) {
        await safeDelete(chatId, msgId); await safeDelete(chatId, state.promptMsgId);
        await send(chatId, 'Invalid: ' + e.message + '\nFormat: min-max (e.g. 1-5)');
      }
      break;
    }

    case 'accum_delay': {
      try {
        const parts = text.trim().split('-');
        if (parts.length !== 2) throw new Error('Format: min-max (e.g. 120-300)');
        const min = parseInt(parts[0]);
        const max = parseInt(parts[1]);
        if (isNaN(min) || isNaN(max) || min < 10 || max <= min) throw new Error('Need positive integers, max > min, min >= 10');
        const cs = chainState(chatId);
        if (!cs.accum) cs.accum = defaultAccumState();
        cs.accum.minDelay = min;
        cs.accum.maxDelay = max;
        await safeDelete(chatId, msgId); await safeDelete(chatId, state.promptMsgId);
        await send(chatId, `Check interval: ${min}-${max}s`, accumSettingsKeyboard(cs.accum));
      } catch (e) {
        await safeDelete(chatId, msgId); await safeDelete(chatId, state.promptMsgId);
        await send(chatId, 'Invalid: ' + e.message + '\nFormat: min-max seconds (e.g. 120-300)');
      }
      break;
    }

    case 'accum_threshold': {
      const n = parseFloat(text.trim());
      if (isNaN(n) || n < 0.1 || n > 50) { await ctx.reply('Enter 0.1-50.'); break; }
      const cs = chainState(chatId);
      if (!cs.accum) cs.accum = defaultAccumState();
      cs.accum.threshold = n;
      await safeDelete(chatId, msgId); await safeDelete(chatId, state.promptMsgId);
      await send(chatId, `Threshold: ±${n}%`, accumSettingsKeyboard(cs.accum));
      break;
    }

    case 'accum_recycle': {
      const n = parseFloat(text.trim());
      if (isNaN(n) || n < 0 || n > 100) { await ctx.reply('Enter 0-100.'); break; }
      const cs = chainState(chatId);
      if (!cs.accum) cs.accum = defaultAccumState();
      cs.accum.recyclePercent = n;
      await safeDelete(chatId, msgId); await safeDelete(chatId, state.promptMsgId);
      await send(chatId, `Reload: ${n}%`, accumSettingsKeyboard(cs.accum));
      break;
    }

    case 'accum_slippage': {
      const n = parseFloat(text.trim());
      if (isNaN(n) || n < 0.1 || n > 100) { await ctx.reply('Enter 0.1-100.'); break; }
      const cs = chainState(chatId);
      if (!cs.accum) cs.accum = defaultAccumState();
      cs.accum.slippage = Math.round(n);
      await safeDelete(chatId, msgId); await safeDelete(chatId, state.promptMsgId);
      await send(chatId, `Slippage: ${n}%`, accumSettingsKeyboard(cs.accum));
      break;
    }

    // ---- Grid Setup ----
    case 'grid_setup': {
      try {
        const parts = text.trim().split(/\s+/);
        if (parts.length < 3) throw new Error('Send: capital levels range (e.g. 500 10 5)');
        const capital = parseFloat(parts[0]);
        const levels = parseInt(parts[1]);
        const range = parseFloat(parts[2]);
        if (isNaN(capital) || capital <= 0) throw new Error('Capital must be positive');
        if (isNaN(levels) || levels < 2) throw new Error('Need at least 2 levels');
        if (levels % 2 !== 0) throw new Error('Levels should be even');
        if (isNaN(range) || range <= 0 || range > 50) throw new Error('Range 0.1-50%');

        let currentPrice;
        if (chain === 'base') currentPrice = await baseGetETHPrice();
        else currentPrice = await solGetSOLPrice();

        cs.grid = createGrid(currentPrice, levels, range, capital);

        await safeDelete(chatId, msgId); await safeDelete(chatId, state.promptMsgId);

        const native = chain === 'base' ? 'ETH' : 'SOL';
        const stepSize = (currentPrice * range / 100) / (levels / 2);
        let msg = fmt.header('GRID CONFIGURED') + '\n\n';
        msg += fmt.line('Pair', `${native}/USDC`) + '\n';
        msg += fmt.line('Current Price', fmt.usd(currentPrice)) + '\n';
        msg += fmt.line('Capital', fmt.usd(capital)) + '\n';
        msg += fmt.line('Levels', levels) + '\n';
        msg += fmt.line('Range', fmt.pct(range)) + '\n';
        msg += fmt.line('Step Size', fmt.usd(stepSize)) + '\n';
        msg += fmt.line('Per Level', fmt.usd(capital / levels)) + '\n';
        msg += fmt.div() + '\n';
        msg += cs.grid.levels.map(l => `  ${l.type === 'buy' ? 'BUY' : 'SELL'} @ $${l.price.toFixed(2)}`).join('\n');
        msg += '\n\nHit Start Grid when ready.';

        await send(chatId, msg, mainKeyboard('grid'));
      } catch (e) {
        await safeDelete(chatId, msgId); await safeDelete(chatId, state.promptMsgId);
        await send(chatId, 'Error: ' + e.message + '\n\nFormat: capital levels range\nExample: 500 10 5');
      }
      break;
    }

    case 'grid_set_capital': {
      const n = parseFloat(text.trim());
      if (isNaN(n) || n <= 0) { await ctx.reply('Positive number.'); break; }
      if (cs.grid) {
        cs.grid.totalUSDC = n;
        cs.grid.usdcRemaining = n;
        const perLevel = n / cs.grid.numLevels;
        cs.grid.levels.forEach(l => l.amountUSDC = perLevel);
      }
      await safeDelete(chatId, msgId); await safeDelete(chatId, state.promptMsgId);
      await send(chatId, `Capital: ${fmt.usd(n)}`, gridSettingsKeyboard(cs.grid));
      break;
    }

    case 'grid_set_levels': {
      const n = parseInt(text.trim());
      if (isNaN(n) || n < 2 || n % 2 !== 0) { await ctx.reply('Even number >= 2.'); break; }
      if (cs.grid) {
        let price;
        if (chain === 'base') price = await baseGetETHPrice();
        else price = await solGetSOLPrice();
        cs.grid = createGrid(price, n, cs.grid.rangePercent, cs.grid.totalUSDC);
      }
      await safeDelete(chatId, msgId); await safeDelete(chatId, state.promptMsgId);
      await send(chatId, `Levels: ${n}`, gridSettingsKeyboard(cs.grid));
      break;
    }

    case 'grid_set_range': {
      const n = parseFloat(text.trim());
      if (isNaN(n) || n <= 0 || n > 50) { await ctx.reply('0.1-50.'); break; }
      if (cs.grid) {
        let price;
        if (chain === 'base') price = await baseGetETHPrice();
        else price = await solGetSOLPrice();
        cs.grid = createGrid(price, cs.grid.numLevels, n, cs.grid.totalUSDC);
      }
      await safeDelete(chatId, msgId); await safeDelete(chatId, state.promptMsgId);
      await send(chatId, `Range: ${fmt.pct(n)}`, gridSettingsKeyboard(cs.grid));
      break;
    }

    case 'grid_set_poll': {
      const n = parseInt(text.trim());
      if (isNaN(n) || n < 5) { await ctx.reply('Min 5 seconds.'); break; }
      if (cs.grid) cs.grid.pollInterval = n;
      await safeDelete(chatId, msgId); await safeDelete(chatId, state.promptMsgId);
      await send(chatId, `Poll: ${n}s`, gridSettingsKeyboard(cs.grid));
      break;
    }

    case 'grid_set_slippage': {
      const n = parseFloat(text.trim());
      if (isNaN(n) || n < 0.1 || n > 50) { await ctx.reply('0.1-50.'); break; }
      if (cs.grid) cs.grid.slippage = Math.round(n);
      await safeDelete(chatId, msgId); await safeDelete(chatId, state.promptMsgId);
      await send(chatId, `Slippage: ${n}%`, gridSettingsKeyboard(cs.grid));
      break;
    }

    // ---- Arb Settings ----
    case 'arb_set_size': {
      try {
        const val = parseFloat(text.trim());
        if (isNaN(val) || val <= 0) throw new Error('positive');
        if (cs.arb) cs.arb.tradeSize = ethers.parseEther(text.trim());
        await safeDelete(chatId, msgId); await safeDelete(chatId, state.promptMsgId);
        await send(chatId, `Trade size: ${val} ETH`, arbSettingsKeyboard(cs.arb));
      } catch {
        await safeDelete(chatId, msgId); await safeDelete(chatId, state.promptMsgId);
        await send(chatId, 'Invalid amount.');
      }
      break;
    }

    case 'arb_set_profit': {
      const n = parseInt(text.trim());
      if (isNaN(n) || n < 1) { await ctx.reply('Min 1 bps.'); break; }
      if (cs.arb) cs.arb.minProfitBps = n;
      await safeDelete(chatId, msgId); await safeDelete(chatId, state.promptMsgId);
      await send(chatId, `Min spread: ${n} bps (${(n / 100).toFixed(2)}%)`, arbSettingsKeyboard(cs.arb));
      break;
    }

    case 'arb_set_poll': {
      const n = parseInt(text.trim());
      if (isNaN(n) || n < 3) { await ctx.reply('Min 3 seconds.'); break; }
      if (cs.arb) cs.arb.pollInterval = n;
      await safeDelete(chatId, msgId); await safeDelete(chatId, state.promptMsgId);
      await send(chatId, `Poll: ${n}s`, arbSettingsKeyboard(cs.arb));
      break;
    }

    case 'arb_add_pair': {
      try {
        const input = text.trim();
        if (input.toLowerCase() === 'reset') {
          if (cs.arb) cs.arb.pairs = [{ tokenA: WETH, tokenB: USDC_BASE, label: 'ETH/USDC' }];
          await safeDelete(chatId, msgId); await safeDelete(chatId, state.promptMsgId);
          await send(chatId, 'Pairs reset to ETH/USDC.', arbSettingsKeyboard(cs.arb));
        } else {
          if (!ethers.isAddress(input)) throw new Error('Invalid address');
          const info = await baseValidateToken(input);
          if (cs.arb) {
            // Add WETH/token pair
            const exists = cs.arb.pairs.some(p => p.tokenB.toLowerCase() === input.toLowerCase());
            if (!exists) {
              cs.arb.pairs.push({ tokenA: WETH, tokenB: input, label: `ETH/${info.symbol}` });
            }
          }
          await safeDelete(chatId, msgId); await safeDelete(chatId, state.promptMsgId);
          await send(chatId, `Added ETH/${info.symbol} pair.`, arbSettingsKeyboard(cs.arb));
        }
      } catch (e) {
        await safeDelete(chatId, msgId); await safeDelete(chatId, state.promptMsgId);
        await send(chatId, 'Invalid: ' + e.message);
      }
      break;
    }

    // ---- PIN & Unlock ----
    case 'set_pin': {
      const pin = text.trim();
      if (!/^\d{4,8}$/.test(pin)) {
        await safeDelete(chatId, msgId); await safeDelete(chatId, state.promptMsgId);
        await send(chatId, 'PIN must be 4-8 digits.');
        break;
      }
      state.pin = pin;
      await safeDelete(chatId, msgId); await safeDelete(chatId, state.promptMsgId);

      // Encrypt any existing unlocked wallets
      if (state.base.wallet) lockWallet(state, 'base');
      if (state.solana.wallet) lockWallet(state, 'solana');

      // Immediately unlock current chain so user can keep working
      if (isLocked(state, state.chain)) unlockWallet(state, state.chain, pin);

      await send(chatId,
        'PIN set. Wallet key encrypted (AES-256-GCM).\n\n' +
        'Your key is now protected at rest.\n' +
        'You will need this PIN to:\n' +
        '- Unlock after 2h of inactivity\n' +
        '- Unlock after bot restart\n\n' +
        'REMEMBER YOUR PIN — it cannot be recovered.',
        mainKeyboard(state.mode));
      break;
    }

    case 'unlock_wallet': {
      const pin = text.trim();
      await safeDelete(chatId, msgId); await safeDelete(chatId, state.promptMsgId);
      if (!state.pin) {
        // No PIN was set — shouldn't happen but handle gracefully
        await send(chatId, 'No PIN set. Wallet not encrypted.');
        break;
      }
      const ok = unlockWallet(state, state.chain, pin);
      if (ok) {
        await send(chatId, 'Wallet unlocked.', mainKeyboard(state.mode));
      } else {
        await send(chatId, 'Wrong PIN.\nIf you forgot your PIN, you will need to import a new wallet.\nYour encrypted key cannot be recovered without the correct PIN.');
      }
      break;
    }

    // ---- BACK Verification ----
    case 'verify_signature': {
      try {
        const sig = text.trim();
        if (!sig.startsWith('0x') || sig.length < 130) throw new Error('Invalid signature format');
        const verifyMessage = state._verifyMessage;
        if (!verifyMessage) throw new Error('Verification expired. Try again.');

        const result = await verifySignatureAndCheckBack(verifyMessage, sig);
        state.verified = {
          address: result.address,
          balance: result.balance,
          passed: result.passed,
          timestamp: Date.now(),
        };
        state._verifyMessage = null;

        await safeDelete(chatId, msgId); await safeDelete(chatId, state.promptMsgId);
        await send(chatId,
          fmt.header(result.passed ? 'VERIFIED' : 'NOT VERIFIED') + '\n\n' + gateMessage(result),
          state.mode ? mainKeyboard(state.mode) : modeKeyboard(state.chain)
        );
      } catch (e) {
        state._verifyMessage = null;
        await safeDelete(chatId, msgId); await safeDelete(chatId, state.promptMsgId);
        await send(chatId, 'Verification failed: ' + e.message);
      }
      break;
    }
  }

  state.promptMsgId = null;
});

// ============================================================
// Start
// ============================================================
console.log('Silverback Bot starting (Volume + Grid + Arb | Base + Solana)...');

// Register command menu in Telegram
bot.api.setMyCommands([
  { command: 'start', description: 'Main menu — select chain & mode' },
  { command: 'status', description: 'View current status & positions' },
  { command: 'stop', description: 'Stop all active operations' },
  { command: 'help', description: 'How to use Silverback Bot' },
]).catch(e => console.warn('Failed to set commands:', e.message));

bot.start();
console.log('Bot is live.');
