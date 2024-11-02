import {
  BigNumberish,
  Liquidity,
  LIQUIDITY_STATE_LAYOUT_V4,
  LiquidityPoolKeys,
  LiquidityStateV4,
  MARKET_STATE_LAYOUT_V3,
  MarketStateV3,
  Token,
  TokenAmount,
} from '@raydium-io/raydium-sdk';
import {
  AccountLayout,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
  getMint,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  Keypair,
  Connection,
  PublicKey,
  ComputeBudgetProgram,
  KeyedAccountInfo,
  TransactionMessage,
  VersionedTransaction,
  Commitment,
} from '@solana/web3.js';
import {
  retry,
  getTokenAccounts,
  RAYDIUM_LIQUIDITY_PROGRAM_ID_V4,
  OPENBOOK_PROGRAM_ID,
  createPoolKeys,
  retrieveEnvVariable,
  retrieveTokenValueByAddress,
  calculateMarketCap,
} from './core/tokens';
import { getMinimalMarketV3, MinimalMarketLayoutV3, getRugCheck } from './core/tokens';
import bs58 from 'bs58';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from './core/logger';

const network = 'mainnet-beta';
const RPC_ENDPOINT = retrieveEnvVariable('RPC_ENDPOINT', logger);
const RPC_WEBSOCKET = retrieveEnvVariable('RPC_WEBSOCKET', logger);

const solanaConnection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET,
});

export type MinimalTokenAccountData = {
  mint: PublicKey;
  address: PublicKey;
  buyValue?: number;
  poolKeys?: LiquidityPoolKeys;
  market?: MinimalMarketLayoutV3;
};

let existingLiquidityPools: Set<string> = new Set<string>();
let existingOpenBookMarkets: Set<string> = new Set<string>();
let existingTokenAccounts: Map<string, MinimalTokenAccountData> = new Map<string, MinimalTokenAccountData>();

let wallet: Keypair;
let quoteToken: Token;
let quoteTokenAssociatedAddress: PublicKey;
let quoteAmount: TokenAmount;
let quoteMinPoolSizeAmount: TokenAmount;
let quoteMaxPoolSizeAmount: TokenAmount;
let commitment: Commitment = retrieveEnvVariable('COMMITMENT_LEVEL', logger) as Commitment;
const ENABLE_BUY = retrieveEnvVariable('ENABLE_BUY', logger) === 'true';
const TAKE_PROFIT = Number(retrieveEnvVariable('TAKE_PROFIT', logger));
const STOP_LOSS = Number(retrieveEnvVariable('STOP_LOSS', logger));
const MINT_IS_RENOUNCED = retrieveEnvVariable('MINT_IS_RENOUNCED', logger) === 'true';
const TOKEN_FREEZE = retrieveEnvVariable('TOKEN_FREEZE', logger) === 'false';
const USE_SNIPEDLIST = retrieveEnvVariable('USE_SNIPEDLIST', logger) === 'true';
const SNIPE_LIST_REFRESH_INTERVAL = Number(retrieveEnvVariable('SNIPE_LIST_REFRESH_INTERVAL', logger));
const AUTO_SELL = retrieveEnvVariable('AUTO_SELL', logger) === 'true';
const MAX_SELL_RETRIES = Number(retrieveEnvVariable('MAX_SELL_RETRIES', logger));
const MIN_POOL_SIZE = retrieveEnvVariable('MIN_POOL_SIZE', logger);
const MAX_POOL_SIZE = retrieveEnvVariable('MAX_POOL_SIZE', logger);
const MAX_MARKET_CAP = Number(retrieveEnvVariable('MAX_MARKET_CAP', logger));

let snipeList: string[] = [];

async function init(): Promise<void> {
  logger.info(`

                                    EARLY ACCESS - USE AT YOUR OWN RISK


             _____/\\\\\\\\\\\_________/\\\\\__________/\\\\\\\\\_______/\\\\\\\\\_____        
              ___/\\\/////////\\\_____/\\\///\\\______/\\\\\\\\\\\\\___/\\\///////\\\___       
               __\//\\\______\///____/\\\/__\///\\\___/\\\/////////\\\_\/\\\_____\/\\\___      
                ___\////\\\__________/\\\______\//\\\_\/\\\_______\/\\\_\/\\\\\\\\\\\/____     
                 ______\////\\\______\/\\\_______\/\\\_\/\\\\\\\\\\\\\\\_\/\\\//////\\\____    
                  _________\////\\\___\//\\\______/\\\__\/\\\/////////\\\_\/\\\____\//\\\___   
                   __/\\\______\//\\\___\///\\\__/\\\____\/\\\_______\/\\\_\/\\\_____\//\\\__  
                    _\///\\\\\\\\\\\/______\///\\\\\/_____\/\\\_______\/\\\_\/\\\______\//\\\_ 
                     ___\///////////__________\/////_______\///________\///__\///________\///__
                                   

                                            SoaR v.1.0.0

                              -------- RUNNING | CTRL+C TO STOP IT --------
  `);

  const MY_PRIVATE_KEY = retrieveEnvVariable('MY_PRIVATE_KEY', logger);
  wallet = Keypair.fromSecretKey(bs58.decode(MY_PRIVATE_KEY));

  logger.info(`CONNECTED @ ${RPC_ENDPOINT}`);
  logger.info('----------------------------------------------------------');
  logger.info(`Wallet Address: ${wallet.publicKey}`);

  const TOKEN_SYMB = retrieveEnvVariable('TOKEN_SYMB', logger);
  const BUY_AMOUNT = retrieveEnvVariable('BUY_AMOUNT', logger);
  switch (TOKEN_SYMB) {
    case 'WSOL': {
      quoteToken = Token.WSOL;
      quoteAmount = new TokenAmount(Token.WSOL, BUY_AMOUNT, false);
      quoteMinPoolSizeAmount = new TokenAmount(quoteToken, MIN_POOL_SIZE, false);
      quoteMaxPoolSizeAmount = new TokenAmount(quoteToken, MAX_POOL_SIZE, false);
      break;
    }
    case 'USDC': {
      quoteToken = new Token(
        TOKEN_PROGRAM_ID,
        new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
        6,
        'USDC',
        'USDC',
      );
      quoteAmount = new TokenAmount(quoteToken, BUY_AMOUNT, false);
      break;
    }
    default: {
      throw new Error(`Unsupported "${TOKEN_SYMB}"! ONLY USDC or WSOL`);
    }
  }

  logger.info(`Snipelist: ${USE_SNIPEDLIST}`);
  logger.info(`Mint renounced: ${MINT_IS_RENOUNCED}`);
  logger.info(`Auto sell: ${AUTO_SELL}`);
  logger.info(`T/P: ${TAKE_PROFIT}%`);
  logger.info(`S/L: ${STOP_LOSS}%`);
  logger.info(
    `Pool size min >: ${quoteMinPoolSizeAmount.isZero() ? 'false' : quoteMinPoolSizeAmount.toFixed()} ${quoteToken.symbol}`,
  );
  logger.info(
    `Pool size max <: ${quoteMaxPoolSizeAmount.isZero() ? 'false' : quoteMaxPoolSizeAmount.toFixed()} ${quoteToken.symbol}`,
  );
  logger.info(`Buy amount: ${quoteAmount.toFixed()} ${quoteToken.symbol}`);

  const tokenAccounts = await getTokenAccounts(solanaConnection, wallet.publicKey, commitment);

  for (const ta of tokenAccounts) {
    existingTokenAccounts.set(ta.accountInfo.mint.toString(), <MinimalTokenAccountData>{
      mint: ta.accountInfo.mint,
      address: ta.pubkey,
    });
  }

  const tokenAccount = tokenAccounts.find((acc) => acc.accountInfo.mint.toString() === quoteToken.mint.toString())!;

  if (ENABLE_BUY)
    if (!tokenAccount) {
      logger.error(`---> Put SOL in your wallet and swap SOL to WSOL at https://jup.ag/ <---`);
      throw new Error(`No ${quoteToken.symbol} token account found in wallet: ${wallet.publicKey}`);
    }

  if (ENABLE_BUY) quoteTokenAssociatedAddress = tokenAccount.pubkey;
  else quoteTokenAssociatedAddress = new PublicKey('FHiVp58tS6adC2E9uG75Nc6zEMJGtTfgMg4yRuGYCYBy');

  loadSnipedList();
}

function saveTokenAccount(mint: PublicKey, accountData: MinimalMarketLayoutV3) {
  const ata = getAssociatedTokenAddressSync(mint, wallet.publicKey);
  const tokenAccount = <MinimalTokenAccountData>{
    address: ata,
    mint: mint,
    market: <MinimalMarketLayoutV3>{
      bids: accountData.bids,
      asks: accountData.asks,
      eventQueue: accountData.eventQueue,
    },
  };
  existingTokenAccounts.set(mint.toString(), tokenAccount);
  return tokenAccount;
}

export async function processRaydiumPool(id: PublicKey, poolState: LiquidityStateV4) {
  let rugRiskDanger = false;

  if (!shouldBuy(poolState.baseMint.toString())) {
    return;
  }

  // rug check
  await getRugCheck(poolState.baseMint.toString()).then((risk) => {
    rugRiskDanger = risk;
  });

  if (rugRiskDanger) {
    logger.warn(`------------------- POOL RUGGED | (${quoteToken.symbol}) ------------------- `);
    return;
  }

  const poolSize = new TokenAmount(quoteToken, poolState.swapQuoteInAmount, true);

  // Check pool size
  if (!quoteMinPoolSizeAmount.isZero()) {
    // const poolTokenAddress = poolState.baseMint.toString();

    if (poolSize.lt(quoteMinPoolSizeAmount)) {
      logger.warn(`
        Skipping pool, < ${quoteMinPoolSizeAmount.toFixed()} ${quoteToken.programId}
        Swap amount: ${poolSize.toFixed()}
      `);
      return;
    }
  }

  // Check pool size
  if (!quoteMaxPoolSizeAmount.isZero()) {
    if (poolSize.gt(quoteMaxPoolSizeAmount)) {
      logger.warn(
        {
          mint: poolState.baseMint,
          pooled: `${poolSize.toFixed()} ${quoteToken.symbol}`,
        },
        `Skipping pool, > ${quoteMaxPoolSizeAmount.toFixed()} ${quoteToken.programId}`,
        `Swap amount: ${poolSize.toFixed()}`,
      );
      logger.info(`---------------------------------------- \n`);
      return;
    }
  }

  // Check token extensions
  const errMsg = await checkTokenExtensions(poolState.baseMint);

  if (errMsg) {
    logger.warn(errMsg);
    return;
  }

  // Check market cap
  const marketCap = await calculateMarketCap(poolState.baseMint, solanaConnection);
  if (marketCap && marketCap > MAX_MARKET_CAP) {
    logger.info(`Skipping pool: Market Cap > ${MAX_MARKET_CAP} ${quoteToken.programId}`);
    return;
  }

  logger.info(`Pool link: https://dexscreener.com/solana/${id.toString()}`);
  logger.info(`Pool Open Time: ${new Date(parseInt(poolState.poolOpenTime.toString()) * 1000).toLocaleString()}`);
  logger.info(`--------------------- `);

  logger.info(`Pool ID: ${id.toString()}`);
  logger.info(`Pool link: https://dexscreener.com/solana/${id.toString()}`);
  logger.info(`Pool SOL size: ${poolSize.toFixed()} ${quoteToken.symbol}`);
  logger.info(`Base Mint: ${poolState.baseMint}`);
  logger.info(`Pool Status: ${poolState.status}`);

  if (ENABLE_BUY) {
    await buy(id, poolState);
  } else {
    logger.info(`--------------- END OF SCRIPT ---------------- \n`);
  }
}

export async function checkTokenExtensions(vault: PublicKey): Promise<any> {
  const mintAccountInfo = await getMint(solanaConnection, vault);
  if (MINT_IS_RENOUNCED)
    if (mintAccountInfo.mintAuthority === null) {
      return `Skipping, owner can mint tokens! ${quoteToken.programId}`;
    }
  if (TOKEN_FREEZE)
    if (mintAccountInfo.freezeAuthority !== null) {
      return `Skipping, owner can freeze tokens! ${quoteToken.programId}`;
    }
  return null;
}

export async function processOpenBookMarket(updatedAccountInfo: KeyedAccountInfo) {
  let accountData: MarketStateV3 | undefined;
  try {
    accountData = MARKET_STATE_LAYOUT_V3.decode(updatedAccountInfo.accountInfo.data);

    if (existingTokenAccounts.has(accountData.baseMint.toString())) {
      return;
    }

    saveTokenAccount(accountData.baseMint, accountData);
  } catch (e) {
    logger.debug(e);
    logger.error({ mint: accountData?.baseMint }, `Market process failed`);
  }
}

async function buy(accountId: PublicKey, accountData: LiquidityStateV4): Promise<void> {
  try {
    let tokenAccount = existingTokenAccounts.get(accountData.baseMint.toString());

    if (!tokenAccount) {
      const market = await getMinimalMarketV3(solanaConnection, accountData.marketId, commitment);
      tokenAccount = saveTokenAccount(accountData.baseMint, market);
    }

    tokenAccount.poolKeys = createPoolKeys(accountId, accountData, tokenAccount.market!);
    const { innerTransaction } = Liquidity.makeSwapFixedInInstruction(
      {
        poolKeys: tokenAccount.poolKeys,
        userKeys: {
          tokenAccountIn: quoteTokenAssociatedAddress,
          tokenAccountOut: tokenAccount.address,
          owner: wallet.publicKey,
        },
        amountIn: quoteAmount.raw,
        minAmountOut: 0,
      },
      tokenAccount.poolKeys.version,
    );

    const latestBlockhash = await solanaConnection.getLatestBlockhash({
      commitment: commitment,
    });
    const messageV0 = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 421197 }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 101337 }),
        createAssociatedTokenAccountIdempotentInstruction(
          wallet.publicKey,
          tokenAccount.address,
          wallet.publicKey,
          accountData.baseMint,
        ),
        ...innerTransaction.instructions,
      ],
    }).compileToV0Message();
    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([wallet, ...innerTransaction.signers]);
    const rawTransaction = transaction.serialize();
    const signature = await retry(
      () =>
        solanaConnection.sendRawTransaction(rawTransaction, {
          skipPreflight: true,
        }),
      { retryIntervalMs: 10, retries: 50 },
    );
    logger.info({ mint: accountData.baseMint, signature }, `Sent buy tx`);
    const confirmation = await solanaConnection.confirmTransaction(
      {
        signature,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        blockhash: latestBlockhash.blockhash,
      },
      commitment,
    );
    const basePromise = solanaConnection.getTokenAccountBalance(accountData.baseVault, commitment);
    const quotePromise = solanaConnection.getTokenAccountBalance(accountData.quoteVault, commitment);

    await Promise.all([basePromise, quotePromise]);

    const baseValue = await basePromise;
    const quoteValue = await quotePromise;

    if (baseValue?.value?.uiAmount && quoteValue?.value?.uiAmount)
      tokenAccount.buyValue = quoteValue?.value?.uiAmount / baseValue?.value?.uiAmount;
    if (!confirmation.value.err) {
      logger.info(
        {
          signature,
          url: `https://solscan.io/tx/${signature}?cluster=${network}`,
          dex: `https://dexscreener.com/solana/${accountData.baseMint}?maker=${wallet.publicKey}`,
        },
        `Confirmed buy tx... @: ${tokenAccount.buyValue} SOL`,
      );
    } else {
      logger.debug(confirmation.value.err);
      logger.info({ mint: accountData.baseMint, signature }, `Error confirming buy tx`);
    }
  } catch (e) {
    logger.debug(e);
    logger.error({ mint: accountData.baseMint }, `Failed to buy token`);
  }
}

async function sell(accountId: PublicKey, mint: PublicKey, amount: BigNumberish, value: number): Promise<boolean> {
  let retries = 0;

  do {
    try {
      const tokenAccount = existingTokenAccounts.get(mint.toString());
      if (!tokenAccount) {
        return true;
      }

      if (!tokenAccount.poolKeys) {
        logger.warn({ mint }, 'No pool keys found');
        continue;
      }

      if (amount === 0) {
        logger.info(
          {
            mint: tokenAccount.mint,
          },
          `Empty balance, can't sell`,
        );
        return true;
      }

      if (tokenAccount.buyValue === undefined) return true;

      const netChange = (value - tokenAccount.buyValue) / tokenAccount.buyValue;
      if (netChange > STOP_LOSS && netChange < TAKE_PROFIT) return false;

      const { innerTransaction } = Liquidity.makeSwapFixedInInstruction(
        {
          poolKeys: tokenAccount.poolKeys!,
          userKeys: {
            tokenAccountOut: quoteTokenAssociatedAddress,
            tokenAccountIn: tokenAccount.address,
            owner: wallet.publicKey,
          },
          amountIn: amount,
          minAmountOut: 0,
        },
        tokenAccount.poolKeys!.version,
      );

      const latestBlockhash = await solanaConnection.getLatestBlockhash({
        commitment: commitment,
      });
      const messageV0 = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions: [
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 400000 }),
          ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }),
          ...innerTransaction.instructions,
          createCloseAccountInstruction(tokenAccount.address, wallet.publicKey, wallet.publicKey),
        ],
      }).compileToV0Message();

      const transaction = new VersionedTransaction(messageV0);
      transaction.sign([wallet, ...innerTransaction.signers]);
      const signature = await solanaConnection.sendRawTransaction(transaction.serialize(), {
        preflightCommitment: commitment,
      });
      logger.info({ mint, signature }, `Sent SELL TX...`);
      const confirmation = await solanaConnection.confirmTransaction(
        {
          signature,
          lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
          blockhash: latestBlockhash.blockhash,
        },
        commitment,
      );
      if (confirmation.value.err) {
        logger.debug(confirmation.value.err);
        logger.info({ mint, signature }, `Error confirming sell tx`);
        continue;
      }

      logger.info(
        {
          mint,
          signature,
          url: `https://solscan.io/tx/${signature}?cluster=${network}`,
          dex: `https://dexscreener.com/solana/${mint}?maker=${wallet.publicKey}`,
        },
        `Confirmed sell tx... Sold at: ${value}\tNet Profit: ${netChange * 100}%`,
      );
      return true;
    } catch (e: any) {
      retries++;
      logger.debug(e);
      logger.error({ mint }, `Failed to sell token, retry: ${retries}/${MAX_SELL_RETRIES}`);
    }
  } while (retries < MAX_SELL_RETRIES);
  return true;
}

function loadSnipedList() {
  if (!USE_SNIPEDLIST) {
    return;
  }

  const count = snipeList.length;
  const data = fs.readFileSync(path.join(__dirname, 'snipedlist.txt'), 'utf-8');
  snipeList = data
    .split('\n')
    .map((a) => a.trim())
    .filter((a) => a);

  if (snipeList.length != count) {
    logger.info(`Loaded snipe list: ${snipeList.length}`);
  }
}

function shouldBuy(key: string): boolean {
  return USE_SNIPEDLIST ? snipeList.includes(key) : true;
}

const runListener = async () => {
  await init();
  const runTimestamp = Math.floor(new Date().getTime() / 1000);
  const raydiumSubscriptionId = solanaConnection.onProgramAccountChange(
    RAYDIUM_LIQUIDITY_PROGRAM_ID_V4,
    async (updatedAccountInfo) => {
      const key = updatedAccountInfo.accountId.toString();
      const poolState = LIQUIDITY_STATE_LAYOUT_V4.decode(updatedAccountInfo.accountInfo.data);
      const poolOpenTime = parseInt(poolState.poolOpenTime.toString());
      const existing = existingLiquidityPools.has(key);

      if (poolOpenTime > runTimestamp && !existing) {
        existingLiquidityPools.add(key);
        const _ = processRaydiumPool(updatedAccountInfo.accountId, poolState);
      }
    },
    commitment,
    [
      { dataSize: LIQUIDITY_STATE_LAYOUT_V4.span },
      {
        memcmp: {
          offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('quoteMint'),
          bytes: quoteToken.mint.toBase58(),
        },
      },
      {
        memcmp: {
          offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('marketProgramId'),
          bytes: OPENBOOK_PROGRAM_ID.toBase58(),
        },
      },
      {
        memcmp: {
          offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('status'),
          bytes: bs58.encode([6, 0, 0, 0, 0, 0, 0, 0]),
        },
      },
    ],
  );

  const openBookSubscriptionId = solanaConnection.onProgramAccountChange(
    OPENBOOK_PROGRAM_ID,
    async (updatedAccountInfo) => {
      const key = updatedAccountInfo.accountId.toString();
      const existing = existingOpenBookMarkets.has(key);
      if (!existing) {
        existingOpenBookMarkets.add(key);
        const _ = processOpenBookMarket(updatedAccountInfo);
      }
    },
    commitment,
    [
      { dataSize: MARKET_STATE_LAYOUT_V3.span },
      {
        memcmp: {
          offset: MARKET_STATE_LAYOUT_V3.offsetOf('quoteMint'),
          bytes: quoteToken.mint.toBase58(),
        },
      },
    ],
  );

  if (AUTO_SELL) {
    const walletSubscriptionId = solanaConnection.onProgramAccountChange(
      TOKEN_PROGRAM_ID,
      async (updatedAccountInfo) => {
        const accountData = AccountLayout.decode(updatedAccountInfo.accountInfo!.data);
        if (updatedAccountInfo.accountId.equals(quoteTokenAssociatedAddress)) {
          return;
        }
        let completed = false;
        let retries = 0;
        const maxRetries = 5; // Set the maximum number of retries
        const baseDelay = 1000; // Base delay in milliseconds

        while (!completed && retries < maxRetries) {
          const delay = baseDelay * Math.pow(2, retries); // Exponential backoff
          setTimeout(() => {}, delay);

          const currValue = await retrieveTokenValueByAddress(accountData.mint.toBase58());
          if (currValue) {
            logger.info(accountData.mint, `Current Price: ${currValue} SOL`);

            // SELL
            completed = await sell(updatedAccountInfo.accountId, accountData.mint, accountData.amount, currValue);
          }

          if (!completed) {
            retries++;
            logger.warn(`Retry ${retries}/${maxRetries} for token ${accountData.mint.toBase58()}`);
          }
        }

        if (!completed) {
          logger.error(`Failed to sell token ${accountData.mint.toBase58()} after ${maxRetries} retries`);
        }
      },
      commitment,
      [
        {
          dataSize: 165,
        },
        {
          memcmp: {
            offset: 32,
            bytes: wallet.publicKey.toBase58(),
          },
        },
      ],
    );
  }

  logger.info('-------------------- SEARCH NEW POOLS --------------------');

  if (USE_SNIPEDLIST) {
    setInterval(loadSnipedList, SNIPE_LIST_REFRESH_INTERVAL);
  }
};

runListener();
