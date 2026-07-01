import { ERC20, ETH_GAS_RESERVE, round6Usd } from './protocol.mjs';
import { DEFAULT_FEE_BPS } from './constants.mjs';

export async function walletBalances(client) {
  const [usdc, eth] = await Promise.all([
    client.pub.readContract({ address: client.usdc, abi: ERC20, functionName: 'balanceOf', args: [client.account.address] }),
    client.pub.getBalance({ address: client.account.address }),
  ]);
  return { usdc, eth };
}

export async function ensureFundedFor(client, budget, { feeBps = DEFAULT_FEE_BPS } = {}) {
  const usdcNeed = round6Usd(Number(budget) * (1 + (Number(feeBps) || 0) / 10000));
  const ethNeed = ETH_GAS_RESERVE;
  const bal = await client._walletBalances();
  const haveUsdc = Number(bal.usdc) / 1e6;
  const haveEth = Number(bal.eth) / 1e18;
  const shortUsdc = round6Usd(Math.max(0, usdcNeed - haveUsdc));
  const shortEth = Math.max(0, ethNeed - haveEth);
  const ok = shortUsdc <= 0 && shortEth <= 1e-9;
  const address = client.account.address;
  const explorerBase = client.chainId === 8453 ? 'https://basescan.org' : 'https://sepolia.basescan.org';
  const message = ok ? null
    : `Send ${shortUsdc} USDC + ~${shortEth.toFixed(4)} ETH to ${address} on Base (chain ${client.chainId}).`;
  return {
    ok, address, chainId: client.chainId,
    need: { usdc: usdcNeed, eth: ethNeed },
    have: { usdc: round6Usd(haveUsdc), eth: haveEth },
    shortfall: { usdc: shortUsdc, eth: shortEth },
    message, explorerUrl: `${explorerBase}/address/${address}`,
  };
}
