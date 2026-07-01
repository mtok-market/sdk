import crypto from 'node:crypto';
import { parseAbi } from 'viem';

export function stable(v) {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') return Object.keys(v).sort().reduce((o, k) => ((o[k] = stable(v[k])), o), {});
  return v;
}

export const canonicalIntent = (intent) => JSON.stringify(stable(intent));
export const signIntent = (intent, privKey) => crypto.sign(null, Buffer.from(canonicalIntent(intent)), privKey).toString('base64url');
export const legNonce = (base, label) => '0x' + crypto.createHash('sha256').update(Buffer.from(String(base).replace(/^0x/, ''), 'hex')).update(String(label)).digest('hex');
export const usdToAtomic = (u) => BigInt(Math.round(Number(u) * 1e6));
export const round6Usd = (n) => Math.round(n * 1e6) / 1e6;

export const configuredFeeUsd = ({ amountUsd, feeAddress, feeBps }) => {
  const amount = Number(amountUsd) || 0;
  const bps = Math.trunc(Number(feeBps) || 0);
  if (!feeAddress || bps <= 0 || amount <= 0) return 0;
  return round6Usd(amount * bps / 10000);
};

export const requiresFeeLeg = ({ amountUsd, feeAddress, feeBps, dustThresholdUsd = 0.001 }) => {
  const amount = Number(amountUsd) || 0;
  const bps = Number(feeBps) || 0;
  const dust = Number(dustThresholdUsd) || 0.001;
  return Boolean(feeAddress) && bps > 0 && amount >= dust && amount * bps / 10000 > 0;
};

export const ETH_GAS_RESERVE = 0.0005; // enough native gas for several Base txns

export const ERC20 = parseAbi([
  'function transfer(address,uint256) returns (bool)',
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function name() view returns (string)',
  'function version() view returns (string)',
]);
export const TWA = parseAbi(['function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)']);
export const META = parseAbi(['function authorizationState(address authorizer, bytes32 nonce) view returns (bool)', 'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)']);
export const DRIP_LEDGER = parseAbi([
  'function agentKeyFor(string agentId) view returns (bytes32)',
  'function agentWallet(bytes32 agentKey) view returns (address)',
  'function bindNonces(bytes32 agentKey) view returns (uint256)',
  'function bindAgent(string agentId,address wallet,uint256 deadline,bytes signature)',
  'function payDraw((string buyerAgentId,string sellerAgentId,string bookingId,string offerId,string model,uint32 n,uint256 sellerUsdAtomic,uint256 feeUsdAtomic,uint256 inputPricePerMTokAtomic,uint256 outputPricePerMTokAtomic,bytes32 requestHash,uint256 deadline)) returns (bytes32)',
  'function drawIdFor((string buyerAgentId,string sellerAgentId,string bookingId,string offerId,string model,uint32 n,uint256 sellerUsdAtomic,uint256 feeUsdAtomic,uint256 inputPricePerMTokAtomic,uint256 outputPricePerMTokAtomic,bytes32 requestHash,uint256 deadline)) view returns (bytes32)',
  'function affirmDraw(bytes32 drawId,uint256 inputTokens,uint256 outputTokens,uint256 deliveredUsdAtomic,bytes32 responseHash)',
  'function disputeDraw(bytes32 drawId,bytes32 reasonHash)',
]);

export const PINNED_FEE_ADDRESSES = {
  8453: '0x6B5FED4aca54Ca89d95b822fD64c8545D34B673b',
  84532: '0x25EFcbfD32C3f769690aA1181d48565f69c855E1',
};

export function meterUsd(usage, offer) {
  const inTok = Number(usage?.prompt_tokens ?? usage?.input_tokens ?? 0) || 0;
  const outTok = Number(usage?.completion_tokens ?? usage?.output_tokens ?? 0) || 0;
  return (inTok * (Number(offer.inputPricePerMTok) || 0) + outTok * (Number(offer.outputPricePerMTok) || 0)) / 1e6;
}
