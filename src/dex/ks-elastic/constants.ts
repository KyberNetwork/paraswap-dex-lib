export const KS_ELASTIC_FUNCTION_CALL_GAS_COST = 21_000; // Ceiled
export const KS_ELASTIC_TICK_GAS_COST = 24_000; // Ceiled
export const KS_ELASTIC_QUOTE_GASLIMIT = 24_000; // Ceiled

export const MAX_PRICING_COMPUTATION_STEPS_ALLOWED = 128;

export const KS_ELASTIC_SUBGRAPH_URL =
  'https://api.thegraph.com/subgraphs/name/kybernetwork/kyberswap-elastic-mainnet';

export const KS_ELASTIC_EFFICIENCY_FACTOR = 5;

export const ZERO_TICK_INFO = {
  liquidityGross: 0n,
  liquidityNet: 0n,
  tickCumulativeOutside: 0n,
  secondsPerLiquidityOutsideX128: 0n,
  secondsOutside: 0n,
  initialized: false,
  index: 0,
};

export const OUT_OF_RANGE_ERROR_POSTFIX = `INVALID_TICK_BIT_MAP_RANGES`;
export enum FeeTiers {
  STABLE = 8,
  LOWEST = 10,
  LOW = 40,
  MEDIUM = 300,
  HIGH = 1000,
}

export const FEE_UNITS = 100000n;
export const TWO_FEE_UNITS = FEE_UNITS + FEE_UNITS;

export function toFeeTiers(fee: number | bigint): FeeTiers {
  switch (Number(fee)) {
    case 8:
      return FeeTiers.STABLE;
    case 10:
      return FeeTiers.LOWEST;
    case 40:
      return FeeTiers.LOW;
    case 300:
      return FeeTiers.MEDIUM;
    case 1000:
      return FeeTiers.HIGH;
    default:
      throw Error('fee is not supported');
  }
}

const TICK_SPACING = {
  [FeeTiers.LOWEST]: 1,
  [FeeTiers.STABLE]: 1,
  [FeeTiers.LOW]: 8,
  [FeeTiers.MEDIUM]: 60,
  [FeeTiers.HIGH]: 200,
};

export const TickSpacing = TICK_SPACING;

export const ZeroAddress = '0x0000000000000000000000000000000000000000';
