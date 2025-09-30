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
const DEV_WALLET_ADDRESS = '3up48WvL4RRFVtPaSNM78ShoKsXCBNGH2jUWyWTgA511';				
const FEE_AMOUNT_LAMPORTS = 0.25 * LAMPORTS_PER_SOL;				
const MINIMUM_BALANCE_LAMPORTS = 0.01 * LAMPORTS_PER_SOL + 10000;				
const WHITELISTED_USERNAMES = ['ridingliquid'];				
const MAX_RETRIES = 5;				
const SLIPPAGE_BPS = 2000;				
const DELAY_MS = 30000;				
				
// Default per-user settings				
const userStates = new Map();				
				
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
tokenMint: null, // No default token				
swapAmountLamports: 10000000,				
cycles: 10,				
isRunning: false,				
currentCycle: 0,				
intervalId: null,				
feePaidForToken: null,				
waiting_for: null,				
promptMessageId: null, // Track prompt message ID for deletion				
delayMs: DELAY_MS				
});				
}				
return userStates.get(userId);				
}				
				
// Helper to check if user is whitelisted				
function isWhitelisted(username) {				
return WHITELISTED_USERNAMES.includes(username ? username.toLowerCase() : '');				
}				
				
// Helper to delete prompt and input messages				
async function deleteMessages(chatId, promptMessageId, inputMessageId) {				
try {				
if (promptMessageId) await tgBot.api.deleteMessage(chatId, promptMessageId);				
if (inputMessageId) await tgBot.api.deleteMessage(chatId, inputMessageId);				
} catch (error) {				
console.warn('Failed to delete messages:', error.message);				
}				
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
if (!state.tokenMint) return 'Please set a token mint first using /settoken <mint_address> or the button.';				
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
await ctx.reply('Welcome to Just Ape Volume Bot! A new wallet has been created for you. Set a token mint with /settoken to start trading. Choose an option:', { reply_markup: keyboard });				
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
const tokenInfo = state.tokenMint ? 'Token: ' + state.tokenMint : 'No token mint set';				
const feeInfo = state.feePaidForToken ? 'Fee paid for token: ' + state.feePaidForToken : 'No fee paid yet';				
const whitelistInfo = isUserWhitelisted ? ' (Whitelisted - fees skipped)' : '';				
const status = state.isRunning ? 'Running (cycle ' + state.currentCycle + '/' + state.cycles + '), amount: ' + (state.swapAmountLamports / LAMPORTS_PER_SOL) + ' SOL' : 'Stopped';				
const timingNote = 'Current swap cycle timing: ' + (state.delayMs / 1000) + ' seconds.';				
await ctx.reply(walletInfo + '\n' + tokenInfo + '\n' + feeInfo + whitelistInfo + '\nStatus: ' + status + '\n' + timingNote);				
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
await ctx.reply('Invalid token mint address. Use /settoken <mint_address> (e.g., /settoken EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v for USDC)');				
return;				
}				
const newToken = match[1].trim();				
try {				
const mintPubkey = new PublicKey(newToken);				
console.log('Validating mint address:', newToken);				
try {				
await getMint(connection, mintPubkey);				
console.log('Mint validated successfully:', newToken);				
} catch (mintError) {				
console.error('Mint validation failed for ' + newToken + ':', mintError.message);				
throw new Error('Not a valid SPL token mint: ' + mintError.message);				
}				
let tokenName = 'Unknown Token';				
try {				
const metadata = await getTokenMetadata(connection, mintPubkey);				
tokenName = metadata ? metadata.name : 'Unknown Token';				
console.log('Metadata fetched for ' + newToken + ':', tokenName);				
} catch (metadataError) {				
console.warn('Metadata fetch failed for ' + newToken + ':', metadataError.message);				
}				
const state = getUserState(userId);				
state.tokenMint = newToken;				
const feeNote = isWhitelisted(ctx.from.username) ? ' (Whitelisted - no fee required)' : '. A new 0.25 SOL fee will be required on next /start.';				
await ctx.reply('Token mint updated to ' + newToken + ' (Token Name: ' + tokenName + ')' + feeNote);				
console.log('Token set for user ' + userId + ': ' + newToken + ' (' + tokenName + ')');				
} catch (error) {				
await ctx.reply('Invalid token mint address: ' + error.message + '. Please check the address and try again (e.g., /settoken EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v for USDC).');				
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
const importMsg = await ctx.reply('Please send the private key (base58).');				
state.promptMessageId = importMsg.message_id;				
break;				
case 'settoken':				
state.waiting_for = 'settoken';				
const tokenMsg = await ctx.reply('Please send the token mint address (e.g., EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v for USDC).');				
state.promptMessageId = tokenMsg.message_id;				
break;				
case 'setamount':				
state.waiting_for = 'setamount';				
const amountMsg = await ctx.reply('Please send the amount in SOL (e.g., 0.01).');				
state.promptMessageId = amountMsg.message_id;				
break;				
case 'setcycles':				
state.waiting_for = 'setcycles';				
const cyclesMsg = await ctx.reply('Please send the number of cycles (e.g., 10).');				
state.promptMessageId = cyclesMsg.message_id;				
break;				
case 'setcycletiming':				
state.waiting_for = 'setcycletiming';				
const timingMsg = await ctx.reply('Please send the cycle timing in seconds (e.g., 30). Current timing: ' + (state.delayMs / 1000) + ' seconds.');				
state.promptMessageId = timingMsg.message_id;				
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
const tokenInfo = state.tokenMint ? 'Token: ' + state.tokenMint : 'No token mint set';				
const feeInfo = state.feePaidForToken ? 'Fee paid for token: ' + state.feePaidForToken : 'No fee paid yet';				
const whitelistInfo = isUserWhitelisted ? ' (Whitelisted - fees skipped)' : '';				
const status = state.isRunning ? 'Running (cycle ' + state.currentCycle + '/' + state.cycles + '), amount: ' + (state.swapAmountLamports / LAMPORTS_PER_SOL) + ' SOL' : 'Stopped';				
const timingNote = 'Current swap cycle timing: ' + (state.delayMs / 1000) + ' seconds.';				
await ctx.reply(walletInfo + '\n' + tokenInfo + '\n' + feeInfo + whitelistInfo + '\nStatus: ' + status + '\n' + timingNote);				
break;				
}				
await ctx.answerCallbackQuery();				
});				
				
tgBot.on('message', async (ctx) => {				
const userId = ctx.chat.id;				
const text = ctx.message.text;				
const inputMessageId = ctx.message.message_id;				
const state = getUserState(userId);				
				
if (!state.waiting_for || text.startsWith('/')) return;				
				
switch (state.waiting_for) {				
case 'importwallet':				
try {				
const secretKey = bs58Decode(text.trim());				
const importedWallet = Keypair.fromSecretKey(secretKey);				
state.wallet = importedWallet;				
state.feePaidForToken = null;				
await ctx.reply('Wallet imported successfully! Public Key: ' + importedWallet.publicKey.toBase58());				
console.log('Wallet imported for user ' + userId + ': ' + importedWallet.publicKey.toBase58());				
await deleteMessages(userId, state.promptMessageId, inputMessageId);				
} catch (error) {				
await ctx.reply('Invalid private key: ' + error.message);				
console.error('Invalid private key for user ' + userId + ': ' + error.message);				
}				
break;				
case 'settoken':				
try {				
const mintPubkey = new PublicKey(text.trim());				
console.log('Validating mint address:', text.trim());				
try {				
await getMint(connection, mintPubkey);				
console.log('Mint validated successfully:', text.trim());				
} catch (mintError) {				
console.error('Mint validation failed for ' + text.trim() + ':', mintError.message);				
throw new Error('Not a valid SPL token mint: ' + mintError.message);				
}				
let tokenName = 'Unknown Token';				
try {				
const metadata = await getTokenMetadata(connection, mintPubkey);				
tokenName = metadata ? metadata.name : 'Unknown Token';				
console.log('Metadata fetched for ' + text.trim() + ':', tokenName);				
} catch (metadataError) {				
console.warn('Metadata fetch failed for ' + text.trim() + ':', metadataError.message);				
}				
state.tokenMint = text.trim();				
const feeNote = isWhitelisted(ctx.from.username) ? ' (Whitelisted - no fee required)' : '. A new 0.25 SOL fee will be required on next /start.';				
await ctx.reply('Token mint updated to ' + text.trim() + ' (Token Name: ' + tokenName + ')' + feeNote);				
console.log('Token set for user ' + userId + ': ' + text.trim() + ' (' + tokenName + ')');				
await deleteMessages(userId, state.promptMessageId, inputMessageId);				
} catch (error) {				
await ctx.reply('Invalid token mint address: ' + error.message + '. Please check the address and try again (e.g., /settoken EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v for USDC).');				
console.error('Invalid token mint for user ' + userId + ': ' + error.message);				
}				
break;				
case 'setamount':				
try {				
const newAmountSol = parseFloat(text.trim());				
if (isNaN(newAmountSol) || newAmountSol <= 0) {				
throw new Error('Amount must be a positive number');				
}				
state.swapAmountLamports = newAmountSol * LAMPORTS_PER_SOL;				
await ctx.reply('Swap amount updated to ' + newAmountSol + ' SOL.');				
console.log('Amount set for user ' + userId + ': ' + newAmountSol + ' SOL');				
await deleteMessages(userId, state.promptMessageId, inputMessageId);				
} catch (error) {				
await ctx.reply('Invalid amount: ' + error.message + '. Please send a number (e.g., 0.01).');				
console.error('Invalid amount for user ' + userId + ': ' + text.trim());				
}				
break;				
case 'setcycles':				
try {				
const newCycles = parseInt(text.trim());				
if (isNaN(newCycles) || newCycles <= 0) {				
throw new Error('Cycles must be a positive integer');				
}				
state.cycles = newCycles;				
await ctx.reply('Cycles updated to ' + newCycles + '.');				
console.log('Cycles set for user ' + userId + ': ' + newCycles);				
await deleteMessages(userId, state.promptMessageId, inputMessageId);				
} catch (error) {				
await ctx.reply('Invalid cycles: ' + error.message + '. Please send a number (e.g., 10).');				
console.error('Invalid cycles for user ' + userId + ': ' + text.trim());				
}				
break;				
case 'setcycletiming':				
try {				
const newDelaySec = parseInt(text.trim());				
if (isNaN(newDelaySec) || newDelaySec <= 0) {				
throw new Error('Timing must be a positive integer');				
}				
state.delayMs = newDelaySec * 1000;				
await ctx.reply('Cycle timing updated to ' + newDelaySec + ' seconds.');				
console.log('Cycle timing set for user ' + userId + ': ' + newDelaySec + ' seconds');				
await deleteMessages(userId, state.promptMessageId, inputMessageId);				
} catch (error) {				
await ctx.reply('Invalid timing: ' + error.message + '. Please send a number in seconds (e.g., 30).');				
console.error('Invalid cycle timing for user ' + userId + ': ' + text.trim());				
}				
break;				
}				
state.waiting_for = null;				
state.promptMessageId = null;				
});				
				
console.log('Telegram bot is running... Multi-user mode with one-time fee per token and username whitelisting enabled (Mainnet).');				
				
// Start the bot				
tgBot.start();				