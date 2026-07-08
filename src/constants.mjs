// Shared fallback defaults for the buyer SDK. Kept in ONE place so the same number
// never drifts between modules.

// Platform fee fallback (basis points). The RUNTIME source of truth is /api/config.feeBps
// (fetched live per draw); this is only the default used when config hasn't been read yet
// or omits feeBps. Do not read this in place of the live value.
export const DEFAULT_FEE_BPS = 250;

// Smallest positive USDC amount the draw contract can move: one 6-decimal USDC atomic.
export const MIN_DRAW_USD = 0.000001;

// Conservative fallback cap for a first draw when reputation is unavailable.
export const RECOMMENDED_FIRST_DRAW_USD = 0.10;
