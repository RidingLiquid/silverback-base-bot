require('dotenv').config();
const { Connection, Keypair, PublicKey, VersionedTransaction, Transaction, SystemProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { getMint, getTokenMetadata } = require('@solana/spl-token');
const bs58 = require('bs58');
const { Bot, InlineKeyboard } = require('grammy');

// Diagnostic logging for bs58
console.log('bs58 module loaded:', bs58);
console.log('bs58.default.encode exists:', typeof bs58.default?.encode === 'function');
console.log('bs58.default.decode exists:', typeof bs58.default?.decode === 'function');

// Verify bs58 module
if (!bs58 || !bs58.default || typeof bs58.default.encode !== 'function' || typeof bs58.default.decode !== 'function') {
  console.error('Error: bs58 module is not correctly loaded. Ensure bs58@6.0.0 is installed and no conflicting versions are present.');
  process.exit(1);
}

// Use bs58.default for encode/decode
const bs58Encode = bs58.default.encode;
const bs58Decode = bs58.default.decode;

// Configurable settings
const DEV_WALLET_ADDRESS = '3up48WvL4RRFVtPaSNM78ShoKsXCBNGH2jUWyWTgA511'; // Solana address for fees
const FEE_AMOUNT_LAMPORTS = 0.25 * LAMPORTS_PER_SOL; // 0.25 SOL fee
const MINIMUM_BALANCE_LAMPORTS = 0.01 * LAMPORTS_PER_SOL + 10000; // Enough for one trade (0.01 SOL) + gas (~0.00001 SOL)
const WHITELISTED_USERNAMES = ['ridingliquid']; // Whitelisted usernames (lowercase, no @) - skips fees
const MAX_RETRIES = 5; // Retry failed API calls
const SLIPPAGE_BPS = 2000; // 20% for very low-liquidity tokens
const DELAY_MS = 30000; // 30s delay to avoid rate limits

// Default per-user settings
const userStates = new Map(); // userId -> {wallet, tokenMint, swapAmountLamports, cycles, isRunning, currentCycle, intervalId, feePaidForToken, waiting_for, delayMs}

// Shared settings
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Load connection
const connection = new Connection(process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com', 'confirmed');

// Telegram setup
const telegramToken = process.env.TELEGRAM_TOKEN;
if (!telegramToken) throw new Error('TELEGRAM_TOKEN not set in .env');
const tgBot = new Bot(telegramToken);

// Error handler to prevent crashes
tgBot.catch((err) => {
  console.error('Bot error:', err.message);
  const userId = err.ctx?.chat?.id;
  if (userId) {
    tgBot.api.sendMessage(userId, 'An error occurred: ' + err.message + '. Please try again or contact support.');
  }
});

// Initialize wallet for new users
function initializeUserWallet(userId) {
  const state = getUserState(userId);
  if (!state.wallet) {
    state.wallet = Keypair.generate();
    state.feePaidForToken = null;
  }
  return state.wallet;
}

// Helper to get or init user state
function getUserState(userId) {
  if (!userStates.has(userId)) {
    userStates.set(userId, {
      wallet: null,
      tokenMint: 'G56JUUNkXyfhVFof5QAC1YuF3jVuSTH5RuTzhJbgjupx', // Default token
      swapAmountLamports: 10000000, // Default 0.01 SOL
      cycles: 10, // Default cycles
      isRunning: false,
      currentCycle: 0,
      intervalId: null,
      feePaidForToken: null, // Tracks token for which fee was paid
      waiting_for: null, // For input waiting state
      delayMs: DELAY_MS // Default cycle timing in ms
    });
  }
  return userStates.get(userId);
}

// Helper to check if user is whitelisted
function isWhitelisted(username) {
  return WHITELISTED_USERNAMES.includes(username ? username.toLowerCase() : '');
}

// Helper functions
async function getQuote(inputMint, outputMint, amount, retryCount = 0) {
  try {
    const url = 'https://quote-api.jup.ag/v6/quote?inputMint=' + inputMint + '&outputMint=' + outputMint + '&amount=' + amount + '&slippageBps=' + SLIPPAGE_BPS;
    const response = await fetch(url);
    if (!response.ok) throw new Error('Quote failed: ' + response.statusText);
    const data = await response.json();
    if (!data.inAmount || !data.outAmount) throw new Error('Invalid quote response');
    console.log('Quote fetched:', JSON.stringify(data, null, 2));
    return data;
  } catch (error) {
    if (retryCount < MAX_RETRIES) {
      console.log('Retrying quote (attempt ' + (retryCount + 1) + '): ' + error.message);
      await new Promise(resolve => setTimeout(resolve, 3000));
      return getQuote(inputMint, outputMint, amount, retryCount + 1);
    }
    throw error;
  }
}

async function getSwapTransaction(quote, userPublicKey, retryCount = 0) {
  try {
    const response = await fetch('https://quote-api.jup.ag/v6/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: userPublicKey.toBase58(),
        wrapAndUnwrapSol: true,
      }),
    });
    if (!response.ok) throw new Error('Swap tx failed: ' + response.statusText);
    const { swapTransaction } = await response.json();
    console.log('Swap transaction fetched:', swapTransaction.substring(0, 50) + '...');
    // Jupiter swapTransaction is base64, not base58
    return VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
  } catch (error) {
    if (retryCount < MAX_RETRIES) {
      console.log('Retrying swap transaction (attempt ' + (retryCount + 1) + '): ' + error.message);
      await new Promise(resolve => setTimeout(resolve, 3000));
      return getSwapTransaction(quote, userPublicKey, retryCount + 1);
    }
    throw error;
  }
}

async function executeTransaction(tx, wallet) {
  tx.sign([wallet]);
  const signature = await connection.sendRawTransaction(tx.serialize());
  console.log('Tx sent: https://solscan.io/tx/' + signature);
  const { value } = await connection.confirmTransaction(signature, 'confirmed');
  if (value.err) throw new Error('Transaction failed');
  console.log('Tx confirmed!');
  return signature;
}

async function sendFee(userWallet, userId) {
  const devPubkey = new PublicKey(DEV_WALLET_ADDRESS);
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: userWallet.publicKey,
      toPubkey: devPubkey,
      lamports: FEE_AMOUNT_LAMPORTS,
    })
  );
  const signature = await executeTransaction(new VersionedTransaction(tx), userWallet);
  console.log('Fee sent: ' + signature);
  const state = getUserState(userId);
  state.feePaidForToken = state.tokenMint;
  return signature;
}

async function checkBalance(userWallet) {
  const balance = await connection.getBalance(userWallet.publicKey);
  console.log('Wallet balance: ' + (balance / LAMPORTS_PER_SOL) + ' SOL');
  return balance >= MINIMUM_BALANCE_LAMPORTS;
}

async function runCycle(userId) {
  const state = getUserState(userId);
  if (!state.isRunning || state.currentCycle >= state.cycles) {
    stopBot(userId);
    return;
  }

  try {
    if (!(await checkBalance(state.wallet))) {
      state.isRunning = false;
      clearInterval(state.intervalId);
      await tgBot.api.sendMessage(userId, 'Insufficient balance. Please fund wallet ' + state.wallet.publicKey.toBase58() + ' with at least ' + (MINIMUM_BALANCE_LAMPORTS / LAMPORTS_PER_SOL) + ' SOL.');
      return;
    }

    state.currentCycle++;
    await tgBot.api.sendMessage(userId, 'Cycle ' + state.currentCycle + '/' + state.cycles + ': Buying token with ' + (state.swapAmountLamports / LAMPORTS_PER_SOL) + ' SOL...');
    const buyQuote = await getQuote(SOL_MINT, state.tokenMint, state.swapAmountLamports);
    const buyTx = await getSwapTransaction(buyQuote, state.wallet.publicKey);
    await executeTransaction(buyTx, state.wallet);
    await new Promise(resolve => setTimeout(resolve, state.delayMs));

    await tgBot.api.sendMessage(userId, 'Cycle ' + state.currentCycle + '/' + state.cycles + ': Selling token for SOL...');
    const sellAmount = buyQuote.outAmount;
    const sellQuote = await getQuote(state.tokenMint, SOL_MINT, sellAmount);
    const sellTx = await getSwapTransaction(sellQuote, state.wallet.publicKey);
    await executeTransaction(sellTx, state.wallet);
    await new Promise(resolve => setTimeout(resolve, state.delayMs));
  } catch (error) {
    await tgBot.api.sendMessage(userId, 'Error in cycle ' + state.currentCycle + ': ' + error.message);
    console.error('Cycle error: ' + error.message);
    stopBot(userId);
  }
}

function startBot(userId, username) {
  const state = getUserState(userId);
  if (state.isRunning) return 'Bot is already running.';
  if (!state.wallet) return 'Please set up a wallet first using /exportwallet or /importwallet.';
  const isUserWhitelisted = isWhitelisted(username);
  const needsFee = !isUserWhitelisted && state.feePaidForToken !== state.tokenMint;

  if (needsFee) {
    return sendFee(state.wallet, userId)
      .then(() => {
        state.isRunning = true;
        state.currentCycle = 0;
        state.intervalId = setInterval(() => runCycle(userId), state.delayMs * 2 + 1000);
        return 'Fee of 0.25 SOL sent for token ' + state.tokenMint + '. Started volume bot with ' + state.cycles + ' cycles, amount: ' + (state.swapAmountLamports / LAMPORTS_PER_SOL) + ' SOL.';
      })
      .catch(error => 'Failed to send fee: ' + error.message + '. Bot not started.');
  } else {
    return checkBalance(state.wallet)
      .then(enough => {
        if (!enough) {
          return 'Insufficient balance. Please fund wallet ' + state.wallet.publicKey.toBase58() + ' with at least ' + (MINIMUM_BALANCE_LAMPORTS / LAMPORTS_PER_SOL) + ' SOL.';
        }
        state.isRunning = true;
        state.currentCycle = 0;
        state.intervalId = setInterval(() => runCycle(userId), state.delayMs * 2 + 1000);
        const feeNote = isUserWhitelisted ? ' (Whitelisted - no fee required)' : 'No new fee needed for token ' + state.tokenMint + '.';
        return 'Started volume bot with ' + state.cycles + ' cycles, amount: ' + (state.swapAmountLamports / LAMPORTS_PER_SOL) + ' SOL.' + feeNote;
      })
      .catch(error => 'Balance check failed: ' + error.message + '. Bot not started.');
  }
}

function stopBot(userId) {
  const state = getUserState(userId);
  if (!state.isRunning) return 'Bot is not running.';
  state.isRunning = false;
  clearInterval(state.intervalId);
  console.log('Bot stopped for user ' + userId + ' after ' + state.currentCycle + ' cycles.');
  return 'Stopped volume bot after ' + state.currentCycle + ' cycles.';
}

// Telegram command handlers
tgBot.command('start', async (ctx) => {
  const userId = ctx.chat.id;
  initializeUserWallet(userId);
  const state = getUserState(userId);
  const keyboard = new InlineKeyboard()
    .text('Export Wallet', 'exportwallet').text('Import Wallet', 'importwallet').row()
    .text('Set Token', 'settoken').text('Set Amount', 'setamount').text('Set Cycles', 'setcycles').row()
    .text('Set Cycle Timing', 'setcycletiming').row()
    .text('Start Bot', 'start').text('Stop Bot', 'stop').text('Status', 'status');
  await ctx.reply('Welcome to Just Ape Volume Bot! A new wallet with a private key has been created for you. To export it, use the "Export Wallet" button below. Choose an option:', { reply_markup: keyboard });
});

tgBot.command('stop', async (ctx) => {
  const userId = ctx.chat.id;
  const response = stopBot(userId);
  await ctx.reply(response);
});

tgBot.command('status', async (ctx) => {
  const userId = ctx.chat.id;
  const username = ctx.from.username;
  const state = getUserState(userId);
  const isUserWhitelisted = isWhitelisted(username);
  const walletInfo = state.wallet ? 'Wallet: ' + state.wallet.publicKey.toBase58() : 'No wallet set';
  const feeInfo = state.feePaidForToken ? 'Fee paid for token: ' + state.feePaidForToken : 'No fee paid yet';
  const whitelistInfo = isUserWhitelisted ? ' (Whitelisted - fees skipped)' : '';
  const status = state.isRunning ? 'Running (cycle ' + state.currentCycle + '/' + state.cycles + '), amount: ' + (state.swapAmountLamports / LAMPORTS_PER_SOL) + ' SOL, token: ' + state.tokenMint : 'Stopped';
  const timingNote = 'Current swap cycle timing: ' + (state.delayMs / 1000) + ' seconds.';
  await ctx.reply(walletInfo + '\n' + feeInfo + whitelistInfo + '\nStatus: ' + status + '\n' + timingNote);
});

tgBot.command('help', async (ctx) => {
  const helpText = '/exportwallet - Export your wallet’s private key\n/importwallet <private_key_base58> - Import an existing wallet\n/settoken <mint_address> - Set the token to trade\n/setamount <sol> - Set buy/sell amount\n/setcycles <num> - Set number of cycles\n/setcycletiming <seconds> - Set cycle timing in seconds\n/start - Start the bot (0.25 SOL fee if new token, skipped if whitelisted)\n/stop - Stop the bot\n/status - Check status\n\nAlternatively, use the buttons and send the input directly. Security Note: Never share your private key. Use a test wallet with minimal funds on mainnet. Whitelisted users (@ridingliquid) skip fees.';
  await ctx.reply(helpText);
});

tgBot.command('setamount', async (ctx) => {
  const userId = ctx.chat.id;
  const match = ctx.message.text.match(/\/setamount\s+(.+)/);
  if (!match) {
    await ctx.reply('Invalid amount. Use /setamount <number> (e.g., /setamount 0.01)');
    return;
  }
  const newAmountSol = parseFloat(match[1]);
  if (isNaN(newAmountSol) || newAmountSol <= 0) {
    await ctx.reply('Invalid amount. Use /setamount <number> (e.g., /setamount 0.01)');
    return;
  }
  const state = getUserState(userId);
  state.swapAmountLamports = newAmountSol * LAMPORTS_PER_SOL;
  await ctx.reply('Swap amount updated to ' + newAmountSol + ' SOL.');
  console.log('Amount set for user ' + userId + ': ' + newAmountSol + ' SOL');
});

tgBot.command('setcycles', async (ctx) => {
  const userId = ctx.chat.id;
  const match = ctx.message.text.match(/\/setcycles\s+(.+)/);
  if (!match) {
    await ctx.reply('Invalid cycles. Use /setcycles <number> (e.g., /setcycles 10)');
    return;
  }
  const newCycles = parseInt(match[1]);
  if (isNaN(newCycles) || newCycles <= 0) {
    await ctx.reply('Invalid cycles. Use /setcycles <number> (e.g., /setcycles 10)');
    return;
  }
  const state = getUserState(userId);
  state.cycles = newCycles;
  await ctx.reply('Cycles updated to ' + newCycles + '.');
  console.log('Cycles set for user ' + userId + ': ' + newCycles);
});

tgBot.command('setcycletiming', async (ctx) => {
  const userId = ctx.chat.id;
  const match = ctx.message.text.match(/\/setcycletiming\s+(.+)/);
  if (!match) {
    await ctx.reply('Invalid timing. Use /setcycletiming <seconds> (e.g., /setcycletiming 30)');
    return;
  }
  const newDelaySec = parseInt(match[1]);
  if (isNaN(newDelaySec) || newDelaySec <= 0) {
    await ctx.reply('Invalid timing. Use /setcycletiming <seconds> (e.g., /setcycletiming 30)');
    return;
  }
  const state = getUserState(userId);
  state.delayMs = newDelaySec * 1000;
  await ctx.reply('Cycle timing updated to ' + newDelaySec + ' seconds.');
  console.log('Cycle timing set for user ' + userId + ': ' + newDelaySec + ' seconds');
});

tgBot.command('settoken', async (ctx) => {
  const userId = ctx.chat.id;
  const match = ctx.message.text.match(/\/settoken\s+(.+)/);
  if (!match) {
    await ctx.reply('Invalid token mint address. Use /settoken <mint_address>');
    return;
  }
  const newToken = match[1].trim();
  try {
    const mintPubkey = new PublicKey(newToken);
    await getMint(connection, mintPubkey);
    const metadata = await getTokenMetadata(connection, mintPubkey);
    const tokenName = metadata ? metadata.name : 'Unknown Token';
    const state = getUserState(userId);
    state.tokenMint = newToken;
    const feeNote = isWhitelisted(ctx.from.username) ? ' (Whitelisted - no fee required)' : '. A new 0.25 SOL fee will be required on next /start.';
    await ctx.reply('Token mint updated to ' + newToken + ' (Token Name: ' + tokenName + ')' + feeNote);
    console.log('Token set for user ' + userId + ': ' + newToken + ' (' + tokenName + ')');
  } catch (error) {
    await ctx.reply('Invalid token mint address: ' + error.message);
    console.error('Invalid token mint for user ' + userId + ': ' + error.message);
  }
});

tgBot.command('exportwallet', async (ctx) => {
  const userId = ctx.chat.id;
  const state = getUserState(userId);
  if (!state.wallet) {
    await ctx.reply('No wallet found. Please use /start to create a wallet.');
    return;
  }
  const privateKeyBase58 = bs58Encode(state.wallet.secretKey);
  await ctx.reply('Your private key (KEEP THIS SAFE AND NEVER SHARE):\n' + privateKeyBase58 + '\n\nStore this securely. Anyone with this key can access your funds.');
  console.log('Wallet exported for user ' + userId + ': ' + state.wallet.publicKey.toBase58());
});

tgBot.command('importwallet', async (ctx) => {
  const userId = ctx.chat.id;
  const match = ctx.message.text.match(/\/importwallet\s+(.+)/);
  if (!match) {
    await ctx.reply('Invalid private key. Use /importwallet <private_key_base58>');
    return;
  }
  const privateKeyBase58 = match[1].trim();
  try {
    const secretKey = bs58Decode(privateKeyBase58);
    const importedWallet = Keypair.fromSecretKey(secretKey);
    const state = getUserState(userId);
    state.wallet = importedWallet;
    state.feePaidForToken = null;
    await ctx.reply('Wallet imported successfully! Public Key: ' + importedWallet.publicKey.toBase58());
    console.log('Wallet imported for user ' + userId + ': ' + importedWallet.publicKey.toBase58());
  } catch (error) {
    await ctx.reply('Invalid private key: ' + error.message);
    console.error('Invalid private key for user ' + userId + ': ' + error.message);
  }
});

// Callback query handler
tgBot.on('callback_query', async (ctx) => {
  const userId = ctx.chat.id;
  const username = ctx.from.username;
  const data = ctx.callbackQuery.data;
  const state = getUserState(userId);

  switch (data) {
    case 'exportwallet':
      if (!state.wallet) {
        await ctx.reply('No wallet found. Please use /start to create a wallet.');
        return;
      }
      const privateKeyBase58 = bs58Encode(state.wallet.secretKey);
      await ctx.reply('Your private key (KEEP THIS SAFE AND NEVER SHARE):\n' + privateKeyBase58 + '\n\nStore this securely. Anyone with this key can access your funds.');
      console.log('Wallet exported for user ' + userId + ': ' + state.wallet.publicKey.toBase58());
      break;
    case 'importwallet':
      state.waiting_for = 'importwallet';
      await ctx.reply('Please send the private key (base58).');
      break;
    case 'settoken':
      state.waiting_for = 'settoken';
      await ctx.reply('Please send the token mint address.');
      break;
    case 'setamount':
      state.waiting_for = 'setamount';
      await ctx.reply('Please send the amount in SOL (e.g., 0.01).');
      break;
    case 'setcycles':
      state.waiting_for = 'setcycles';
      await ctx.reply('Please send the number of cycles (e.g., 10).');
      break;
    case 'setcycletiming':
      state.waiting_for = 'setcycletiming';
      await ctx.reply('Please send the cycle timing in seconds (e.g., 30). Current timing: ' + (state.delayMs / 1000) + ' seconds.');
      break;
    case 'start':
      const response = await startBot(userId, username);
      await ctx.reply(response);
      break;
    case 'stop':
      const stopResponse = stopBot(userId);
      await ctx.reply(stopResponse);
      break;
    case 'status':
      const isUserWhitelisted = isWhitelisted(username);
      const walletInfo = state.wallet ? 'Wallet: ' + state.wallet.publicKey.toBase58() : 'No wallet set';
      const feeInfo = state.feePaidForToken ? 'Fee paid for token: ' + state.tokenMint : 'No fee paid yet';
      const whitelistInfo = isUserWhitelisted ? ' (Whitelisted - fees skipped)' : '';
      const status = state.isRunning ? 'Running (cycle ' + state.currentCycle + '/' + state.cycles + '), amount: ' + (state.swapAmountLamports / LAMPORTS_PER_SOL) + ' SOL, token: ' + state.tokenMint : 'Stopped';
      const timingNote = 'Current swap cycle timing: ' + (state.delayMs / 1000) + ' seconds.';
      await ctx.reply(walletInfo + '\n' + feeInfo + whitelistInfo + '\nStatus: ' + status + '\n' + timingNote);
      break;
  }
  await ctx.answerCallbackQuery();
});

// General text handler for waiting_for state
tgBot.on('message', async (ctx) => {
  const userId = ctx.chat.id;
  const text = ctx.message.text;
  const state = getUserState(userId);

  if (!state.waiting_for || text.startsWith('/')) return; // Ignore commands or if not waiting

  switch (state.waiting_for) {
    case 'importwallet':
      try {
        const secretKey = bs58Decode(text.trim());
        const importedWallet = Keypair.fromSecretKey(secretKey);
        state.wallet = importedWallet;
        state.feePaidForToken = null;
        await ctx.reply('Wallet imported successfully! Public Key: ' + importedWallet.publicKey.toBase58());
        console.log('Wallet imported for user ' + userId + ': ' + importedWallet.publicKey.toBase58());
      } catch (error) {
        await ctx.reply('Invalid private key: ' + error.message);
        console.error('Invalid private key for user ' + userId + ': ' + error.message);
      }
      break;
    case 'settoken':
      try {
        const mintPubkey = new PublicKey(text.trim());
        await getMint(connection, mintPubkey);
        const metadata = await getTokenMetadata(connection, mintPubkey);
        const tokenName = metadata ? metadata.name : 'Unknown Token';
        state.tokenMint = text.trim();
        const feeNote = isWhitelisted(ctx.from.username) ? ' (Whitelisted - no fee required)' : '. A new 0.25 SOL fee will be required on next /start.';
        await ctx.reply('Token mint updated to ' + text.trim() + ' (Token Name: ' + tokenName + ')' + feeNote);
        console.log('Token set for user ' + userId + ': ' + text.trim() + ' (' + tokenName + ')');
      } catch (error) {
        await ctx.reply('Invalid token mint address: ' + error.message);
        console.error('Invalid token mint for user ' + userId + ': ' + error.message);
      }
      break;
    case 'setamount':
      const newAmountSol = parseFloat(text.trim());
      if (isNaN(newAmountSol) || newAmountSol <= 0) {
        await ctx.reply('Invalid amount. Please send a number (e.g., 0.01).');
        console.error('Invalid amount for user ' + userId + ': ' + text.trim());
      } else {
        state.swapAmountLamports = newAmountSol * LAMPORTS_PER_SOL;
        await ctx.reply('Swap amount updated to ' + newAmountSol + ' SOL.');
        console.log('Amount set for user ' + userId + ': ' + newAmountSol + ' SOL');
      }
      break;
    case 'setcycles':
      const newCycles = parseInt(text.trim());
      if (isNaN(newCycles) || newCycles <= 0) {
        await ctx.reply('Invalid cycles. Please send a number (e.g., 10).');
        console.error('Invalid cycles for user ' + userId + ': ' + text.trim());
      } else {
        state.cycles = newCycles;
        await ctx.reply('Cycles updated to ' + newCycles + '.');
        console.log('Cycles set for user ' + userId + ': ' + newCycles);
      }
      break;
    case 'setcycletiming':
      const newDelaySec = parseInt(text.trim());
      if (isNaN(newDelaySec) || newDelaySec <= 0) {
        await ctx.reply('Invalid timing. Please send a number in seconds (e.g., 30).');
        console.error('Invalid cycle timing for user ' + userId + ': ' + text.trim());
      } else {
        state.delayMs = newDelaySec * 1000;
        await ctx.reply('Cycle timing updated to ' + newDelaySec + ' seconds.');
        console.log('Cycle timing set for user ' + userId + ': ' + newDelaySec + ' seconds');
      }
      break;
  }
  state.waiting_for = null;
});

// Start the bot
tgBot.start();