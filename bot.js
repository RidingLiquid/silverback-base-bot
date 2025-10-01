     require('dotenv').config();
     const { ethers } = require('ethers');
     const { Token, TradeType, Route, Pool, Fetcher, Trade, Percent } = require('@uniswap/v3-sdk');
     const { CurrencyAmount } = require('@uniswap/sdk-core');
     const bs58 = require('bs58');
     const { Bot, InlineKeyboard } = require('grammy');

     // Diagnostic logging for bs58
     console.log('bs58 module loaded:', bs58);
     console.log('bs58.default.encode exists:', typeof bs58.default?.encode === 'function');
     console.log('bs58.default.decode exists:', typeof bs58.default?.decode === 'function');

     // Verify bs58 module
     if (!bs58 || !bs58.default || typeof bs58.default.encode !== 'function' || typeof bs58.default.decode !== 'function') {
       console.error('Error: bs58 module is not correctly loaded. Ensure bs58@6.0.0 is installed.');
       process.exit(1);
     }

     // Use bs58.default for encode/decode
     const bs58Encode = bs58.default.encode;
     const bs58Decode = bs58.default.decode;

     // Configurable settings
     const DEV_WALLET_ADDRESS = '0xYourDevWalletAddressOnBase'; // Replace with your Base wallet address
     const FEE_AMOUNT_ETH = ethers.utils.parseEther('0.25'); // 0.25 ETH fee
     const MINIMUM_BALANCE_ETH = ethers.utils.parseEther('0.01'); // Minimum for trades
     const WHITELISTED_USERNAMES = ['ridingliquid'];
     const MAX_RETRIES = 5;
     const SLIPPAGE_PERCENT = new Percent(2000, 10000); // 20% slippage
     const DELAY_MS = 30000; // 30s delay

     // Base chain settings
     const BASE_RPC = process.env.RPC_ENDPOINT || 'https://mainnet.base.org';
     const UNISWAP_V3_ROUTER = '0x2626664c2603336E57B271c5C0b26F421741e481'; // Uniswap V3 SwapRouter on Base
     const WETH_ADDRESS = '0x4200000000000000000000000000000000000006'; // WETH on Base
     const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // USDC on Base

     // Default per-user settings
     const userStates = new Map();

     // Provider and Router
     const provider = new ethers.providers.JsonRpcProvider(BASE_RPC);
     const routerAbi = [
       'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)'
     ];
     const router = new ethers.Contract(UNISWAP_V3_ROUTER, routerAbi, provider);

     // Telegram setup
     const telegramToken = process.env.TELEGRAM_TOKEN;
     if (!telegramToken) throw new Error('TELEGRAM_TOKEN not set in .env');
     const tgBot = new Bot(telegramToken);

     // Error handler
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
         state.wallet = ethers.Wallet.createRandom().connect(provider);
         state.feePaidForToken = null;
       }
       return state.wallet;
     }

     // Helper to get or init user state
     function getUserState(userId) {
       if (!userStates.has(userId)) {
         userStates.set(userId, {
           wallet: null,
           tokenAddress: null,
           swapAmountEth: ethers.utils.parseEther('0.01'),
           cycles: 10,
           isRunning: false,
           currentCycle: 0,
           intervalId: null,
           feePaidForToken: null,
           waiting_for: null,
           promptMessageId: null,
           commandMessageId: null,
           delayMs: DELAY_MS
         });
       }
       return userStates.get(userId);
     }

     // Helper to check if user is whitelisted
     function isWhitelisted(username) {
       return WHITELISTED_USERNAMES.includes(username ? username.toLowerCase() : '');
     }

     // Helper to delete command, prompt, and input messages
     async function deleteMessages(chatId, commandMessageId, promptMessageId, inputMessageId) {
       try {
         if (commandMessageId) await tgBot.api.deleteMessage(chatId, commandMessageId);
         if (promptMessageId) await tgBot.api.deleteMessage(chatId, promptMessageId);
         if (inputMessageId) await tgBot.api.deleteMessage(chatId, inputMessageId);
       } catch (error) {
         console.warn('Failed to delete messages:', error.message);
       }
     }

     // Helper to validate ERC20 token
     async function validateToken(address) {
       const erc20Abi = ['function decimals() view returns (uint8)', 'function symbol() view returns (string)'];
       const contract = new ethers.Contract(address, erc20Abi, provider);
       try {
         const decimals = await contract.decimals();
         console.log('Validated token:', address, 'Decimals:', decimals);
         return { decimals, contract };
       } catch (error) {
         throw new Error('Invalid ERC20 token: ' + error.message);
       }
     }

     // Helper to get Uniswap V3 quote
     async function getQuote(inputTokenAddress, outputTokenAddress, amount, retryCount = 0) {
       try {
         const inputTokenData = await validateToken(inputTokenAddress === ethers.constants.AddressZero ? WETH_ADDRESS : inputTokenAddress);
         const outputTokenData = await validateToken(outputTokenAddress === ethers.constants.AddressZero ? WETH_ADDRESS : outputTokenAddress);
         const inputToken = new Token(8453, inputTokenAddress === ethers.constants.AddressZero ? WETH_ADDRESS : inputTokenAddress, inputTokenData.decimals);
         const outputToken = new Token(8453, outputTokenAddress === ethers.constants.AddressZero ? WETH_ADDRESS : outputTokenAddress, outputTokenData.decimals);
         const pool = await Fetcher.fetchPoolData(inputToken, outputToken, provider);
         const route = new Route([pool], inputToken, outputToken);
         const trade = await Trade.exactIn(route, CurrencyAmount.fromRawAmount(inputToken, amount));
         const minimumOut = trade.minimumAmountOut(SLIPPAGE_PERCENT).toExact();
         console.log('Quote fetched: In', ethers.utils.formatEther(amount), 'Out', minimumOut);
         return { inAmount: amount, outAmount: trade.outputAmount.toExact(), minimumOut };
       } catch (error) {
         if (retryCount < MAX_RETRIES) {
           console.log('Retrying quote (attempt ' + (retryCount + 1) + '): ' + error.message);
           await new Promise(resolve => setTimeout(resolve, 3000));
           return getQuote(inputTokenAddress, outputTokenAddress, amount, retryCount + 1);
         }
         throw error;
       }
     }

     // Helper to execute swap
     async function executeSwap(wallet, inputTokenAddress, outputTokenAddress, amountIn, amountOutMin, retryCount = 0) {
       try {
         const signer = wallet.connect(provider);
         const params = {
           tokenIn: inputTokenAddress === WETH_ADDRESS ? ethers.constants.AddressZero : inputTokenAddress,
           tokenOut: outputTokenAddress === WETH_ADDRESS ? ethers.constants.AddressZero : outputTokenAddress,
           fee: 3000,
           recipient: wallet.address,
           deadline: Math.floor(Date.now() / 1000) + 60 * 20,
           amountIn: amountIn,
           amountOutMinimum: amountOutMin,
           sqrtPriceLimitX96: 0
         };
         const tx = await signer.sendTransaction({
           to: UNISWAP_V3_ROUTER,
           data: router.interface.encodeFunctionData('exactInputSingle', [params]),
           value: inputTokenAddress === WETH_ADDRESS ? amountIn : 0,
           gasLimit: 300000
         });
         const receipt = await tx.wait();
         console.log('Swap tx confirmed:', receipt.transactionHash);
         return receipt.transactionHash;
       } catch (error) {
         if (retryCount < MAX_RETRIES) {
           console.log('Retrying swap (attempt ' + (retryCount + 1) + '): ' + error.message);
           await new Promise(resolve => setTimeout(resolve, 3000));
           return executeSwap(wallet, inputTokenAddress, outputTokenAddress, amountIn, amountOutMin, retryCount + 1);
         }
         throw error;
       }
     }

     // Helper to send fee
     async function sendFee(wallet, userId) {
       const signer = wallet.connect(provider);
       const tx = await signer.sendTransaction({
         to: DEV_WALLET_ADDRESS,
         value: FEE_AMOUNT_ETH,
         gasLimit: 21000
       });
       const receipt = await tx.wait();
       console.log('Fee sent:', receipt.transactionHash);
       const state = getUserState(userId);
       state.feePaidForToken = state.tokenAddress;
       return receipt.transactionHash;
     }

     // Helper to check balance
     async function checkBalance(wallet) {
       const balance = await provider.getBalance(wallet.address);
       console.log('Wallet balance:', ethers.utils.formatEther(balance), 'ETH');
       return balance.gte(MINIMUM_BALANCE_ETH);
     }

     // Run trading cycle
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
           await tgBot.api.sendMessage(userId, 'Insufficient balance. Please fund wallet ' + state.wallet.address + ' with at least ' + ethers.utils.formatEther(MINIMUM_BALANCE_ETH) + ' ETH.');
           return;
         }

         state.currentCycle++;
         await tgBot.api.sendMessage(userId, 'Cycle ' + state.currentCycle + '/' + state.cycles + ': Buying token with ' + ethers.utils.formatEther(state.swapAmountEth) + ' ETH...');
         const buyQuote = await getQuote(WETH_ADDRESS, state.tokenAddress, state.swapAmountEth);
         const buyTx = await executeSwap(state.wallet, WETH_ADDRESS, state.tokenAddress, state.swapAmountEth, buyQuote.minimumOut);
         await new Promise(resolve => setTimeout(resolve, state.delayMs));

         await tgBot.api.sendMessage(userId, 'Cycle ' + state.currentCycle + '/' + state.cycles + ': Selling token for ETH...');
         const sellAmount = buyQuote.outAmount;
         const sellQuote = await getQuote(state.tokenAddress, WETH_ADDRESS, sellAmount);
         const sellTx = await executeSwap(state.wallet, state.tokenAddress, WETH_ADDRESS, sellAmount, sellQuote.minimumOut);
         await new Promise(resolve => setTimeout(resolve, state.delayMs));
       } catch (error) {
         await tgBot.api.sendMessage(userId, 'Error in cycle ' + state.currentCycle + ': ' + error.message);
         console.error('Cycle error:', error.message);
         stopBot(userId);
       }
     }

     function startBot(userId, username) {
       const state = getUserState(userId);
       if (state.isRunning) return 'Bot is already running.';
       if (!state.wallet) return 'Please set up a wallet first using /exportwallet or /importwallet.';
       if (!state.tokenAddress) return 'Please set a token address first using /settoken <address> or the button.';
       const isUserWhitelisted = isWhitelisted(username);
       const needsFee = !isUserWhitelisted && state.feePaidForToken !== state.tokenAddress;

       if (needsFee) {
         return sendFee(state.wallet, userId)
           .then(() => {
             state.isRunning = true;
             state.currentCycle = 0;
             state.intervalId = setInterval(() => runCycle(userId), state.delayMs * 2 + 1000);
             return 'Fee of 0.25 ETH sent for token ' + state.tokenAddress + '. Started Silverbackbot with ' + state.cycles + ' cycles, amount: ' + ethers.utils.formatEther(state.swapAmountEth) + ' ETH.';
           })
           .catch(error => 'Failed to send fee: ' + error.message + '. Bot not started.');
       } else {
         return checkBalance(state.wallet)
           .then(enough => {
             if (!enough) {
               return 'Insufficient balance. Please fund wallet ' + state.wallet.address + ' with at least ' + ethers.utils.formatEther(MINIMUM_BALANCE_ETH) + ' ETH.';
             }
             state.isRunning = true;
             state.currentCycle = 0;
             state.intervalId = setInterval(() => runCycle(userId), state.delayMs * 2 + 1000);
             const feeNote = isUserWhitelisted ? ' (Whitelisted - no fee required)' : 'No new fee needed for token ' + state.tokenAddress + '.';
             return 'Started Silverbackbot with ' + state.cycles + ' cycles, amount: ' + ethers.utils.formatEther(state.swapAmountEth) + ' ETH.' + feeNote;
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
       return 'Stopped Silverbackbot after ' + state.currentCycle + ' cycles.';
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
       await ctx.reply('Welcome to Silverbackbot! A new wallet has been created for you. Set a token address with /settoken to start trading on Base. Choose an option:', { reply_markup: keyboard });
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
       const walletInfo = state.wallet ? 'Wallet: ' + state.wallet.address : 'No wallet set';
       const tokenInfo = state.tokenAddress ? 'Token: ' + state.tokenAddress : 'No token address set';
       const feeInfo = state.feePaidForToken ? 'Fee paid for token: ' + state.feePaidForToken : 'No fee paid yet';
       const whitelistInfo = isUserWhitelisted ? ' (Whitelisted - fees skipped)' : '';
       const status = state.isRunning ? 'Running (cycle ' + state.currentCycle + '/' + state.cycles + '), amount: ' + ethers.utils.formatEther(state.swapAmountEth) + ' ETH' : 'Stopped';
       const timingNote = 'Current swap cycle timing: ' + (state.delayMs / 1000) + ' seconds.';
       await ctx.reply(walletInfo + '\n' + tokenInfo + '\n' + feeInfo + whitelistInfo + '\nStatus: ' + status + '\n' + timingNote);
     });

     tgBot.command('help', async (ctx) => {
       const helpText = '/exportwallet - Export your wallet’s private key\n/importwallet <private_key_hex_or_base58> - Import an existing wallet\n/settoken <address> - Set the token to trade\n/setamount <eth> - Set buy/sell amount\n/setcycles <num> - Set number of cycles\n/setcycletiming <seconds> - Set cycle timing in seconds\n/start - Start the bot (0.25 ETH fee if new token, skipped if whitelisted)\n/stop - Stop the bot\n/status - Check status\n\nAlternatively, use the buttons and send the input directly. Security Note: Never share your private key. Use a test wallet with minimal funds on Base. Whitelisted users (@ridingliquid) skip fees.';
       await ctx.reply(helpText);
     });

     tgBot.command('setamount', async (ctx) => {
       const userId = ctx.chat.id;
       const commandMessageId = ctx.message.message_id;
       const match = ctx.message.text.match(/\/setamount\s+(.+)/);
       if (!match) {
         await ctx.reply('Invalid amount. Use /setamount <number> (e.g., /setamount 0.01)');
         return;
       }
       try {
         const newAmountEth = ethers.utils.parseEther(match[1].trim());
         if (newAmountEth.lte(0)) throw new Error('Amount must be positive');
         const state = getUserState(userId);
         state.swapAmountEth = newAmountEth;
         await ctx.reply('Swap amount updated to ' + ethers.utils.formatEther(newAmountEth) + ' ETH.');
         console.log('Amount set for user ' + userId + ': ' + ethers.utils.formatEther(newAmountEth) + ' ETH');
         await deleteMessages(userId, commandMessageId);
       } catch (error) {
         await ctx.reply('Invalid amount: ' + error.message + '. Use /setamount <number> (e.g., /setamount 0.01).');
         console.error('Invalid amount for user ' + userId + ':', error.message);
       }
     });

     tgBot.command('setcycles', async (ctx) => {
       const userId = ctx.chat.id;
       const commandMessageId = ctx.message.message_id;
       const match = ctx.message.text.match(/\/setcycles\s+(.+)/);
       if (!match) {
         await ctx.reply('Invalid cycles. Use /setcycles <number> (e.g., /setcycles 10)');
         return;
       }
       const newCycles = parseInt(match[1].trim());
       if (isNaN(newCycles) || newCycles <= 0) {
         await ctx.reply('Invalid cycles. Use /setcycles <number> (e.g., /setcycles 10)');
         return;
       }
       const state = getUserState(userId);
       state.cycles = newCycles;
       await ctx.reply('Cycles updated to ' + newCycles + '.');
       console.log('Cycles set for user ' + userId + ': ' + newCycles);
       await deleteMessages(userId, commandMessageId);
     });

     tgBot.command('setcycletiming', async (ctx) => {
       const userId = ctx.chat.id;
       const commandMessageId = ctx.message.message_id;
       const match = ctx.message.text.match(/\/setcycletiming\s+(.+)/);
       if (!match) {
         await ctx.reply('Invalid timing. Use /setcycletiming <seconds> (e.g., /setcycletiming 30)');
         return;
       }
       const newDelaySec = parseInt(match[1].trim());
       if (isNaN(newDelaySec) || newDelaySec <= 0) {
         await ctx.reply('Invalid timing. Use /setcycletiming <seconds> (e.g., /setcycletiming 30)');
         return;
       }
       const state = getUserState(userId);
       state.delayMs = newDelaySec * 1000;
       await ctx.reply('Cycle timing updated to ' + newDelaySec + ' seconds.');
       console.log('Cycle timing set for user ' + userId + ': ' + newDelaySec + ' seconds');
       await deleteMessages(userId, commandMessageId);
     });

     tgBot.command('settoken', async (ctx) => {
       const userId = ctx.chat.id;
       const commandMessageId = ctx.message.message_id;
       const match = ctx.message.text.match(/\/settoken\s+(.+)/);
       if (!match) {
         await ctx.reply('Invalid token address. Use /settoken <address> (e.g., /settoken 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 for USDC on Base)');
         return;
       }
       const newToken = match[1].trim();
       try {
         const { decimals, contract } = await validateToken(newToken);
         let tokenName = 'Unknown Token';
         try {
           tokenName = await contract.symbol();
           console.log('Token symbol fetched:', newToken, tokenName);
         } catch (error) {
           console.warn('Symbol fetch failed for ' + newToken + ':', error.message);
         }
         const state = getUserState(userId);
         state.tokenAddress = newToken;
         const feeNote = isWhitelisted(ctx.from.username) ? ' (Whitelisted - no fee required)' : '. A new 0.25 ETH fee will be required on next /start.';
         await ctx.reply('Token address updated to ' + newToken + ' (Symbol: ' + tokenName + ')' + feeNote);
         console.log('Token set for user ' + userId + ': ' + newToken + ' (' + tokenName + ')');
         await deleteMessages(userId, commandMessageId);
       } catch (error) {
         await ctx.reply('Invalid token address: ' + error.message + '. Use /settoken <address> (e.g., /settoken 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 for USDC on Base).');
         console.error('Invalid token address for user ' + userId + ':', error.message);
       }
     });

     tgBot.command('exportwallet', async (ctx) => {
       const userId = ctx.chat.id;
       const state = getUserState(userId);
       if (!state.wallet) {
         await ctx.reply('No wallet found. Please use /start to create a wallet.');
         return;
       }
       const privateKeyHex = state.wallet.privateKey;
       await ctx.reply('Your private key (KEEP THIS SAFE AND NEVER SHARE):\n' + privateKeyHex + '\n\nStore this securely. Anyone with this key can access your funds.');
       console.log('Wallet exported for user ' + userId + ': ' + state.wallet.address);
     });

     tgBot.command('importwallet', async (ctx) => {
       const userId = ctx.chat.id;
       const commandMessageId = ctx.message.message_id;
       const match = ctx.message.text.match(/\/importwallet\s+(.+)/);
       if (!match) {
         await ctx.reply('Invalid private key. Use /importwallet <private_key_hex_or_base58>');
         return;
       }
       let privateKeyHex = match[1].trim();
       try {
         if (!privateKeyHex.startsWith('0x')) {
           privateKeyHex = '0x' + Buffer.from(bs58Decode(privateKeyHex)).toString('hex');
         }
         const wallet = new ethers.Wallet(privateKeyHex).connect(provider);
         const state = getUserState(userId);
         state.wallet = wallet;
         state.feePaidForToken = null;
         await ctx.reply('Wallet imported successfully! Address: ' + wallet.address);
         console.log('Wallet imported for user ' + userId + ': ' + wallet.address);
         await deleteMessages(userId, commandMessageId);
       } catch (error) {
         await ctx.reply('Invalid private key: ' + error.message);
         console.error('Invalid private key for user ' + userId + ':', error.message);
       }
     });

     // Callback query handler
     tgBot.on('callback_query', async (ctx) => {
       const userId = ctx.chat.id;
       const username = ctx.from.username;
       const data = ctx.callbackQuery.data;
       const state = getUserState(userId);
       const buttonMessageId = ctx.callbackQuery.message.message_id;

       switch (data) {
         case 'exportwallet':
           if (!state.wallet) {
             await ctx.reply('No wallet found. Please use /start to create a wallet.');
             return;
           }
           const privateKeyHex = state.wallet.privateKey;
           await ctx.reply('Your private key (KEEP THIS SAFE AND NEVER SHARE):\n' + privateKeyHex + '\n\nStore this securely. Anyone with this key can access your funds.');
           console.log('Wallet exported for user ' + userId + ': ' + state.wallet.address);
           break;
         case 'importwallet':
           state.waiting_for = 'importwallet';
           state.commandMessageId = buttonMessageId;
           const importMsg = await tgBot.api.sendMessage(userId, 'Please send the private key (hex or base58).');
           state.promptMessageId = importMsg.message_id;
           break;
         case 'settoken':
           state.waiting_for = 'settoken';
           state.commandMessageId = buttonMessageId;
           const tokenMsg = await tgBot.api.sendMessage(userId, 'Please send the token address (e.g., 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 for USDC on Base).');
           state.promptMessageId = tokenMsg.message_id;
           break;
         case 'setamount':
           state.waiting_for = 'setamount';
           state.commandMessageId = buttonMessageId;
           const amountMsg = await tgBot.api.sendMessage(userId, 'Please send the amount in ETH (e.g., 0.01).');
           state.promptMessageId = amountMsg.message_id;
           break;
         case 'setcycles':
           state.waiting_for = 'setcycles';
           state.commandMessageId = buttonMessageId;
           const cyclesMsg = await tgBot.api.sendMessage(userId, 'Please send the number of cycles (e.g., 10).');
           state.promptMessageId = cyclesMsg.message_id;
           break;
         case 'setcycletiming':
           state.waiting_for = 'setcycletiming';
           state.commandMessageId = buttonMessageId;
           const timingMsg = await tgBot.api.sendMessage(userId, 'Please send the cycle timing in seconds (e.g., 30). Current timing: ' + (state.delayMs / 1000) + ' seconds.');
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
           const walletInfo = state.wallet ? 'Wallet: ' + state.wallet.address : 'No wallet set';
           const tokenInfo = state.tokenAddress ? 'Token: ' + state.tokenAddress : 'No token address set';
           const feeInfo = state.feePaidForToken ? 'Fee paid for token: ' + state.feePaidForToken : 'No fee paid yet';
           const whitelistInfo = isUserWhitelisted ? ' (Whitelisted - fees skipped)' : '';
           const status = state.isRunning ? 'Running (cycle ' + state.currentCycle + '/' + state.cycles + '), amount: ' + ethers.utils.formatEther(state.swapAmountEth) + ' ETH' : 'Stopped';
           const timingNote = 'Current swap cycle timing: ' + (state.delayMs / 1000) + ' seconds.';
           await ctx.reply(walletInfo + '\n' + tokenInfo + '\n' + feeInfo + whitelistInfo + '\nStatus: ' + status + '\n' + timingNote);
           break;
       }
       await ctx.answerCallbackQuery();
     });

     // General text handler for waiting_for state
     tgBot.on('message', async (ctx) => {
       const userId = ctx.chat.id;
       const text = ctx.message.text;
       const inputMessageId = ctx.message.message_id;
       const state = getUserState(userId);

       if (!state.waiting_for || text.startsWith('/')) return;

       switch (state.waiting_for) {
         case 'importwallet':
           try {
             let privateKeyHex = text.trim();
             if (!privateKeyHex.startsWith('0x')) {
               privateKeyHex = '0x' + Buffer.from(bs58Decode(privateKeyHex)).toString('hex');
             }
             const wallet = new ethers.Wallet(privateKeyHex).connect(provider);
             state.wallet = wallet;
             state.feePaidForToken = null;
             await ctx.reply('Wallet imported successfully! Address: ' + wallet.address);
             console.log('Wallet imported for user ' + userId + ': ' + wallet.address);
             await deleteMessages(userId, state.commandMessageId, state.promptMessageId, inputMessageId);
           } catch (error) {
             await ctx.reply('Invalid private key: ' + error.message);
             console.error('Invalid private key for user ' + userId + ':', error.message);
           }
           break;
         case 'settoken':
           try {
             const { decimals, contract } = await validateToken(text.trim());
             let tokenName = 'Unknown Token';
             try {
               tokenName = await contract.symbol();
               console.log('Token symbol fetched:', text.trim(), tokenName);
             } catch (error) {
               console.warn('Symbol fetch failed for ' + text.trim() + ':', error.message);
             }
             state.tokenAddress = text.trim();
             const feeNote = isWhitelisted(ctx.from.username) ? ' (Whitelisted - no fee required)' : '. A new 0.25 ETH fee will be required on next /start.';
             await ctx.reply('Token address updated to ' + text.trim() + ' (Symbol: ' + tokenName + ')' + feeNote);
             console.log('Token set for user ' + userId + ': ' + text.trim() + ' (' + tokenName + ')');
             await deleteMessages(userId, state.commandMessageId, state.promptMessageId, inputMessageId);
           } catch (error) {
             await ctx.reply('Invalid token address: ' + error.message + '. Use /settoken <address> (e.g., /settoken 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 for USDC on Base).');
             console.error('Invalid token address for user ' + userId + ':', error.message);
           }
           break;
         case 'setamount':
           try {
             const newAmountEth = ethers.utils.parseEther(text.trim());
             if (newAmountEth.lte(0)) throw new Error('Amount must be positive');
             state.swapAmountEth = newAmountEth;
             await ctx.reply('Swap amount updated to ' + ethers.utils.formatEther(newAmountEth) + ' ETH.');
             console.log('Amount set for user ' + userId + ': ' + ethers.utils.formatEther(newAmountEth) + ' ETH');
             await deleteMessages(userId, state.commandMessageId, state.promptMessageId, inputMessageId);
           } catch (error) {
             await ctx.reply('Invalid amount: ' + error.message + '. Use /setamount <number> (e.g., /setamount 0.01).');
             console.error('Invalid amount for user ' + userId + ':', error.message);
           }
           break;
         case 'setcycles':
           try {
             const newCycles = parseInt(text.trim());
             if (isNaN(newCycles) || newCycles <= 0) throw new Error('Cycles must be a positive integer');
             state.cycles = newCycles;
             await ctx.reply('Cycles updated to ' + newCycles + '.');
             console.log('Cycles set for user ' + userId + ': ' + newCycles);
             await deleteMessages(userId, state.commandMessageId, state.promptMessageId, inputMessageId);
           } catch (error) {
             await ctx.reply('Invalid cycles: ' + error.message + '. Use /setcycles <number> (e.g., /setcycles 10).');
             console.error('Invalid cycles for user ' + userId + ':', error.message);
           }
           break;
         case 'setcycletiming':
           try {
             const newDelaySec = parseInt(text.trim());
             if (isNaN(newDelaySec) || newDelaySec <= 0) throw new Error('Timing must be a positive integer');
             state.delayMs = newDelaySec * 1000;
             await ctx.reply('Cycle timing updated to ' + newDelaySec + ' seconds.');
             console.log('Cycle timing set for user ' + userId + ': ' + newDelaySec + ' seconds');
             await deleteMessages(userId, state.commandMessageId, state.promptMessageId, inputMessageId);
           } catch (error) {
             await ctx.reply('Invalid timing: ' + error.message + '. Use /setcycletiming <seconds> (e.g., /setcycletiming 30).');
             console.error('Invalid cycle timing for user ' + userId + ':', error.message);
           }
           break;
       }
       state.waiting_for = null;
       state.promptMessageId = null;
       state.commandMessageId = null;
     });

     console.log('Silverbackbot is running... Multi-user mode with one-time fee per token and username whitelisting enabled (Base).');

     // Start the bot
     tgBot.start();     