// Shared fallback defaults for the buyer SDK. Kept in ONE place so the same number
// never drifts between modules.

// Platform fee fallback (basis points). The RUNTIME source of truth is /api/config.feeBps
// (fetched live per draw); this is only the default used when config hasn't been read yet
// or omits feeBps. Do not read this in place of the live value.
export const DEFAULT_FEE_BPS = 250;

// Minimum on-chain chunk size (USD). Must stay in sync with DEFAULT_REP_KNOBS.chunkFloorUsd.
export const CHUNK_FLOOR = 0.10;
