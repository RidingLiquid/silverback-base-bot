require('dotenv').config();
const { ethers } = require('ethers');
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

// ============================================================
// Providers
// ============================================================
const baseProvider = new ethers.JsonRpcProvider(BASE_RPC);
const baseRouter = new ethers.Contract(UNISWAP_V2_ROUTER, ROUTER_ABI, baseProvider);
const solConnection = new Connection(SOL_RPC, 'confirmed');

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
      mode: null, // 'volume' or 'grid'
      base: {
        wallet: null,
        token: null, tokenSymbol: null, tokenDecimals: null,
        // Volume settings
        amount: ethers.parseEther('0.001'),
        cycles: 10, slippage: 20, delay: 30,
        isRunning: false, currentCycle: 0, feePaidFor: null,
        // Grid settings
        grid: null, // active grid state
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
    });
  }
  return userStates.get(userId);
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

function modeKeyboard() {
  return new InlineKeyboard()
    .text('Volume Bot', 'mode_volume')
    .text('Grid Trade', 'mode_grid');
}

function mainKeyboard(mode) {
  const kb = new InlineKeyboard()
    .text('Wallet', 'wallet_menu').text('Settings', 'settings_menu').row();
  if (mode === 'volume') {
    kb.text('Start Volume', 'start_volume').text('Stop', 'stop_volume').row();
  } else if (mode === 'grid') {
    kb.text('Start Grid', 'start_grid').text('Stop Grid', 'stop_grid').row();
    kb.text('Grid Status', 'grid_status').row();
  }
  kb.text('Status', 'status').text('Refresh', 'refresh').row();
  kb.text('Switch Mode', 'switch_mode').text('Switch Chain', 'switch_chain');
  return kb;
}

function walletKeyboard() {
  return new InlineKeyboard()
    .text('Show Private Key', 'export_wallet').row()
    .text('Import Wallet', 'import_wallet').row()
    .text('New Wallet', 'new_wallet').row()
    .text('Back', 'main_menu');
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
    await ctx.reply(fmt.header('SELECT MODE') + '\n\nVolume: Buy-sell cycles for volume\nGrid: Automated spread trading for profit', { parse_mode: 'Markdown', reply_markup: modeKeyboard() });
  } else {
    const msg = await buildMainMsg(ctx.chat.id);
    await ctx.reply(msg, { parse_mode: 'Markdown', disable_web_page_preview: true, reply_markup: mainKeyboard(state.mode) });
  }
});

bot.command('stop', async (ctx) => {
  const state = getState(ctx.chat.id);
  if (state.chain && state.mode === 'volume') stopVolume(ctx.chat.id);
  if (state.chain && state.mode === 'grid') stopGrid(ctx.chat.id);
  await ctx.reply('Stopped.');
});

bot.command('status', async (ctx) => {
  const state = getState(ctx.chat.id);
  if (!state.chain || !state.mode) { await ctx.reply('Use /start first.'); return; }
  if (state.mode === 'grid') {
    const msg = buildGridStatus(ctx.chat.id);
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
    'Profits from each completed buy-sell spread.\n' +
    'Best in sideways/choppy markets.\n\n' +
    'Grid tips:\n' +
    '- More levels = more trades but smaller profit each\n' +
    '- Wider range = catches bigger moves but less frequent\n' +
    '- 5-10% range with 10 levels is a good start\n' +
    '- Poll every 15-30s to catch moves without burning RPC',
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
        await editOrReply(ctx, fmt.header('SELECT MODE'), modeKeyboard());
      } else {
        const msg = await buildMainMsg(chatId);
        await editOrReply(ctx, msg, mainKeyboard(state.mode));
      }
      break;
    }
    case 'chain_solana': {
      state.chain = 'solana';
      if (!state.mode) {
        await editOrReply(ctx, fmt.header('SELECT MODE'), modeKeyboard());
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
    case 'switch_mode': {
      await editOrReply(ctx, fmt.header('SELECT MODE'), modeKeyboard());
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
      if (state.chain === 'base') {
        if (!cs.wallet) cs.wallet = baseCreateWallet();
        const addr = cs.wallet.address;
        await editOrReply(ctx,
          fmt.header('BASE WALLET') + '\n\n' + fmt.line('Address', fmt.addrBase(addr)) + '\n\n' + fmt.mono(addr),
          walletKeyboard()
        );
      } else {
        if (!cs.wallet) cs.wallet = solCreateWallet();
        const addr = cs.wallet.publicKey.toBase58();
        await editOrReply(ctx,
          fmt.header('SOLANA WALLET') + '\n\n' + fmt.line('Address', fmt.addrSol(addr)) + '\n\n' + fmt.mono(addr),
          walletKeyboard()
        );
      }
      break;
    }

    case 'settings_menu': {
      const cs = chainState(chatId);
      if (state.mode === 'grid') {
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
      const addr = state.chain === 'base' ? cs.wallet.address : cs.wallet.publicKey.toBase58();
      const addrFmt = state.chain === 'base' ? fmt.addrBase(addr) : fmt.addrSol(addr);
      await editOrReply(ctx, fmt.header('NEW WALLET') + '\n\n' + fmt.line('Address', addrFmt) + '\n\n' + fmt.mono(addr), walletKeyboard());
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
      await send(chatId, response, mainKeyboard('volume'));
      await ctx.answerCallbackQuery();
      break;
    }
    case 'stop_volume': {
      stopVolume(chatId);
      await ctx.answerCallbackQuery({ text: 'Stopped.' });
      const msg = await buildMainMsg(chatId);
      await editOrReply(ctx, msg, mainKeyboard('volume'));
      break;
    }
    case 'start_grid': {
      const response = await startGrid(chatId, username);
      await send(chatId, response, mainKeyboard('grid'));
      await ctx.answerCallbackQuery();
      break;
    }
    case 'stop_grid': {
      stopGrid(chatId);
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

    case 'status': {
      if (state.mode === 'grid') {
        const msg = buildGridStatus(chatId);
        await editOrReply(ctx, msg, mainKeyboard('grid'));
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
        await safeDelete(chatId, msgId);
        await safeDelete(chatId, state.promptMsgId);
        const addr = chain === 'base' ? cs.wallet.address : cs.wallet.publicKey.toBase58();
        const addrFmt = chain === 'base' ? fmt.addrBase(addr) : fmt.addrSol(addr);
        await send(chatId, 'Wallet imported.\n' + fmt.line('Address', addrFmt), mainKeyboard(state.mode));
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
  }

  state.promptMsgId = null;
});

// ============================================================
// Start
// ============================================================
console.log('Silverback Bot starting (Volume + Grid | Base + Solana)...');
bot.start();
console.log('Bot is live.');
