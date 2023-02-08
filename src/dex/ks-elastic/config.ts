import { DexConfigMap, AdapterMappings } from '../../types';
import { Network, SwapSide } from '../../constants';
import { Address } from '../../types';
import { DexParams } from './types';
import { FeeTiers } from './constants';

// const SUPPORTED_FEES = [FeeTiers.HIGH, FeeTiers.MEDIUM, FeeTiers.LOW, FeeTiers.STABLE, FeeTiers.LOWEST];
const SUPPORTED_FEES = [FeeTiers.MEDIUM];

// Pools tha will be initialized on app startup
// They are added for testing
export const PoolsToPreload: DexConfigMap<
  { token0: Address; token1: Address }[]
> = {
  KsElastic: {
    [Network.POLYGON]: [
      {
        token0: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270'.toLowerCase(),
        token1: '0x2791bca1f2de4661ed88a30c99a7a9449aa84174'.toLowerCase(),
      },
      {
        token0: '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619'.toLowerCase(),
        token1: '0x2791bca1f2de4661ed88a30c99a7a9449aa84174'.toLowerCase(),
      },
    ],
    [Network.MAINNET]: [
      {
        token0: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'.toLowerCase(),
        token1: '0xdac17f958d2ee523a2206206994597c13d831ec7'.toLowerCase(),
      },
    ],
  },
};

export const KsElasticConfig: DexConfigMap<DexParams> = {
  KsElastic: {
    [Network.MAINNET]: {
      factory: '0x5F1dddbf348aC2fbe22a163e30F99F9ECE3DD50a',
      router: '0xC1e7dFE73E1598E3910EF4C7845B68A9Ab6F4c83',
      supportedFees: SUPPORTED_FEES,
      ticksFeesReader: '0x165c68077ac06c83800d19200e6E2B08D02dE75D',
      quoter: '0x0D125c15D54cA1F8a813C74A81aEe34ebB508C1f',
      chunksCount: 10,
    },
    [Network.POLYGON]: {
      factory: '0x5F1dddbf348aC2fbe22a163e30F99F9ECE3DD50a',
      router: '0xC1e7dFE73E1598E3910EF4C7845B68A9Ab6F4c83',
      supportedFees: SUPPORTED_FEES,
      ticksFeesReader: '0x165c68077ac06c83800d19200e6E2B08D02dE75D',
      quoter: '0x0D125c15D54cA1F8a813C74A81aEe34ebB508C1f',
      chunksCount: 10,
    },
    [Network.ARBITRUM]: {
      factory: '0x5F1dddbf348aC2fbe22a163e30F99F9ECE3DD50a',
      router: '0xC1e7dFE73E1598E3910EF4C7845B68A9Ab6F4c83',
      supportedFees: SUPPORTED_FEES,
      ticksFeesReader: '0x165c68077ac06c83800d19200e6E2B08D02dE75D',
      quoter: '0x0D125c15D54cA1F8a813C74A81aEe34ebB508C1f',
      chunksCount: 10,
    },
    [Network.OPTIMISM]: {
      factory: '0x5F1dddbf348aC2fbe22a163e30F99F9ECE3DD50a',
      router: '0xC1e7dFE73E1598E3910EF4C7845B68A9Ab6F4c83',
      supportedFees: SUPPORTED_FEES,
      ticksFeesReader: '0x165c68077ac06c83800d19200e6E2B08D02dE75D',
      quoter: '0x0D125c15D54cA1F8a813C74A81aEe34ebB508C1f',
      chunksCount: 10,
    },
  },
};

export const Adapters: Record<number, AdapterMappings> = {
  [Network.MAINNET]: {
    [SwapSide.SELL]: [{ name: 'Adapter01', index: 6 }],
    [SwapSide.BUY]: [{ name: 'BuyAdapter', index: 2 }],
  },
  [Network.POLYGON]: {
    [SwapSide.SELL]: [{ name: 'PolygonAdapter01', index: 13 }],
    [SwapSide.BUY]: [{ name: 'PolygonBuyAdapter', index: 2 }],
  },
  [Network.ARBITRUM]: {
    [SwapSide.SELL]: [{ name: 'ArbitrumAdapter01', index: 3 }],
    [SwapSide.BUY]: [{ name: 'ArbitrumBuyAdapter', index: 2 }],
  },
  [Network.OPTIMISM]: {
    [SwapSide.SELL]: [{ name: 'OptimismAdapter01', index: 3 }],
    [SwapSide.BUY]: [{ name: 'OptimismBuyAdapter', index: 2 }],
  },
};
