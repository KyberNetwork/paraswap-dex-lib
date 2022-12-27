import _ from 'lodash';
import { PoolState, TickInfo } from '../types';
import { LiquidityMath } from './LiquidityMath';
import { ONE, ZERO } from '../internal-constants';
import { SqrtPriceMath } from './SqrtPriceMath';
import { SwapMath } from './SwapMath';
import { TickList } from './TickList';
import invariant from 'tiny-invariant';

import { TickMath } from './TickMath';
import { _require } from '../../../utils';
import { DeepReadonly } from 'ts-essentials';
import { NumberAsString, SwapSide } from 'paraswap-core';
import { OUT_OF_RANGE_ERROR_POSTFIX } from '../constants';
import { setImmediatePromise } from '../utils';

type ModifyPositionParams = {
  tickLower: bigint;
  tickUpper: bigint;
  liquidityDelta: bigint;
};

type PriceComputationState = {
  amountSpecifiedRemaining: bigint;
  amountCalculated: bigint;
  sqrtPriceX96: bigint;
  tick: bigint;
  protocolFee: bigint;
  liquidity: bigint;
  isFirstCycleState: boolean;
};

type PriceComputationCache = {
  liquidityStart: bigint;
  // blockTimestamp: bigint;
  feeProtocol: bigint;
  secondsPerLiquidityCumulativeX128: bigint;
  tickCumulative: bigint;
  computedLatestObservation: boolean;
};

class KsElasticMath {
  getOutputAmountProMM(
    poolState: DeepReadonly<PoolState>,
    inputAmount: bigint,
    zeroForOne: boolean,
    sqrtPriceLimitX96?: bigint | 0n,
  ): bigint {
    return this.swapProMM(
      poolState,
      zeroForOne,
      inputAmount,
      sqrtPriceLimitX96,
    );
    // return -amountOut;
  }

  private swapProMM(
    poolState: PoolState,
    zeroForOne: boolean,
    amountSpecified: bigint,
    sqrtPriceLimitX96?: bigint | 0n,
  ): bigint {
    const tickList = initTickList(poolState.ticks);
    //zeroForOne . as long as swaping token 0->1, X96 of token 0 come to 0, then MIN_SQRT_RATIO is the limit
    //!zeroForOne . as long as swaping token 0->1, X96 of token 0 come to infinity, then MAX_SQRT_RATIO is the limit
    if (
      !sqrtPriceLimitX96 ||
      sqrtPriceLimitX96 == 0n ||
      sqrtPriceLimitX96 == undefined
    )
      sqrtPriceLimitX96 = zeroForOne
        ? TickMath.MIN_SQRT_RATIO + ONE
        : TickMath.MAX_SQRT_RATIO - ONE;
    if (zeroForOne) {
      invariant(sqrtPriceLimitX96 > TickMath.MIN_SQRT_RATIO, 'RATIO_MIN');
      invariant(sqrtPriceLimitX96 < poolState.sqrtPriceX96, 'RATIO_CURRENT');
    } else {
      invariant(sqrtPriceLimitX96 < TickMath.MAX_SQRT_RATIO, 'RATIO_MAX');
      invariant(sqrtPriceLimitX96 > poolState.sqrtPriceX96, 'RATIO_CURRENT');
    }
    const exactInput = amountSpecified >= ZERO;

    const state = {
      amountSpecifiedRemaining: amountSpecified,
      amountCalculated: ZERO,
      baseL: poolState.liquidity,
      reinvestL: poolState.reinvestLiquidity,
      sqrtPriceX96: poolState.sqrtPriceX96,
      tick: poolState.currentTick,
    };
    while (
      state.amountSpecifiedRemaining != ZERO &&
      state.sqrtPriceX96 != sqrtPriceLimitX96
    ) {
      const step = {
        sqrtPriceStartX96: 0n,
        tickNext: 0n,
        initialized: false,
        sqrtPriceNextX96: 0n,
        amountIn: 0n,
        amountOut: 0n,
        feeAmount: 0n,
        deltaL: 0n,
      };
      step.sqrtPriceStartX96 = state.sqrtPriceX96;
      let ticketNext;
      let initialized;
      try {
        [ticketNext, initialized] =
          TickList.nextInitializedTickWithinFixedDistance(
            tickList,
            Number(state.tick),
            zeroForOne,
            480,
          );
        step.tickNext = BigInt(ticketNext);
        step.initialized = initialized;
      } catch (e) {
        if (
          e instanceof Error &&
          e.message.endsWith(OUT_OF_RANGE_ERROR_POSTFIX)
        ) {
          state.amountSpecifiedRemaining = 0n;
          state.amountCalculated = 0n;
          break;
        }
        throw e;
      }

      if (step.tickNext < TickMath.MIN_TICK) {
        step.tickNext = TickMath.MIN_TICK;
      } else if (step.tickNext > TickMath.MAX_TICK) {
        step.tickNext = TickMath.MAX_TICK;
      }

      step.sqrtPriceNextX96 = TickMath.getSqrtRatioAtTick(step.tickNext);
      [state.sqrtPriceX96, step.amountIn, step.amountOut, step.deltaL] =
        SwapMath.computeSwapStepPromm(
          state.sqrtPriceX96,
          (
            zeroForOne
              ? step.sqrtPriceNextX96 < sqrtPriceLimitX96
              : step.sqrtPriceNextX96 > sqrtPriceLimitX96
          )
            ? sqrtPriceLimitX96
            : step.sqrtPriceNextX96,
          state.baseL + state.reinvestL,
          state.amountSpecifiedRemaining,
          poolState.fee,
          exactInput,
          zeroForOne,
        );

      state.reinvestL += step.deltaL;
      if (exactInput) {
        state.amountSpecifiedRemaining -= step.amountIn;
        state.amountCalculated += step.amountOut;
      } else {
        state.amountSpecifiedRemaining += step.amountOut;
        state.amountCalculated =
          state.amountCalculated + step.amountIn + step.feeAmount;
      }

      if (state.sqrtPriceX96 == step.sqrtPriceNextX96) {
        if (step.initialized) {
          let tick = TickList.getTick(tickList, Number(step.tickNext));
          let liquidityNet = tick.liquidityNet;

          liquidityNet = zeroForOne ? -liquidityNet : liquidityNet;
          state.baseL = LiquidityMath.addDelta(state.baseL, liquidityNet);
        }
        state.tick = zeroForOne ? step.tickNext - 1n : step.tickNext;
      } else {
        state.tick = TickMath.getTickAtSqrtRatio(state.sqrtPriceX96);
      }
    }
    return state.amountCalculated;
  }

  swapFromEvent(
    poolState: PoolState,
    amountSpecified: bigint,
    newSqrtPriceX96: bigint,
    newTick: bigint,
    newLiquidity: bigint,
    zeroForOne: boolean,
  ): bigint {
    const tickList = initTickList(poolState.ticks);
    const cache = {
      liquidityStart: poolState.liquidity,
      feeProtocol: 0n,
      secondsPerLiquidityCumulativeX128: 0n,
      tickCumulative: 0n,
      computedLatestObservation: false,
    };

    const state = {
      // Because I don't have the exact amount user used, set this number to MAX_NUMBER to proceed
      // with calculations. I think it is not a problem since in loop I don't rely on this value
      amountSpecifiedRemaining: amountSpecified,
      amountCalculated: 0n,
      sqrtPriceX96: poolState.sqrtPriceX96,
      tick: poolState.currentTick,
      protocolFee: 0n,
      liquidity: cache.liquidityStart,
      reinvestL: poolState.reinvestLiquidity,
      fee: poolState.fee,
      tickList: tickList,
    };
    const exactInput = amountSpecified >= ZERO;

    // Because I didn't have all variables, adapted loop stop with state.tick !== newTick
    // condition. This cycle need only to calculate Tick.cross() function values
    // It means that we are interested in cycling only if state.tick !== newTick
    // When they become equivalent, we proceed with state updating part as normal
    // And if assumptions regarding this cycle are correct, we don't need to process
    // the last cycle when state.tick === newTick
    while (state.tick !== newTick && state.sqrtPriceX96 !== newSqrtPriceX96) {
      const step = {
        sqrtPriceStartX96: 0n,
        tickNext: 0n,
        initialized: false,
        sqrtPriceNextX96: 0n,
        amountIn: 0n,
        amountOut: 0n,
        feeAmount: 0n,
        deltaL: 0n,
      };

      step.sqrtPriceStartX96 = state.sqrtPriceX96;

      const result = TickList.nextInitializedTickWithinFixedDistance(
        state.tickList,
        Number(state.tick),
        zeroForOne,
        480,
      );

      step.tickNext = BigInt(result[0]);
      step.initialized = result[1];

      if (step.tickNext < TickMath.MIN_TICK) {
        step.tickNext = TickMath.MIN_TICK;
      } else if (step.tickNext > TickMath.MAX_TICK) {
        step.tickNext = TickMath.MAX_TICK;
      }

      step.sqrtPriceNextX96 = TickMath.getSqrtRatioAtTick(step.tickNext);

      [state.sqrtPriceX96, step.amountIn, step.amountOut, step.deltaL] =
        SwapMath.computeSwapStepPromm(
          state.sqrtPriceX96,
          (
            zeroForOne
              ? step.sqrtPriceNextX96 < newSqrtPriceX96
              : step.sqrtPriceNextX96 > newSqrtPriceX96
          )
            ? newSqrtPriceX96
            : step.sqrtPriceNextX96,
          state.liquidity + state.reinvestL,
          state.amountSpecifiedRemaining,
          poolState.fee,
          exactInput,
          zeroForOne,
        );
      state.amountSpecifiedRemaining =
        state.amountSpecifiedRemaining - step.amountIn;
      state.amountCalculated = state.amountCalculated + step.amountOut;
      state.reinvestL = state.reinvestL + step.deltaL;
      if (state.sqrtPriceX96 == step.sqrtPriceNextX96) {
        if (step.initialized) {
          let liquidityNet = TickList.getTick(
            state.tickList,
            Number(step.tickNext),
          ).liquidityNet;
          if (zeroForOne) liquidityNet = -liquidityNet;
          state.liquidity = LiquidityMath.addDelta(
            state.liquidity,
            liquidityNet,
          );
        }

        state.tick = zeroForOne ? step.tickNext - 1n : step.tickNext;
      } else if (state.sqrtPriceX96 != step.sqrtPriceStartX96) {
        state.tick = TickMath.getTickAtSqrtRatio(state.sqrtPriceX96);
      }
    }

    if (poolState.currentTick !== newTick) {
      [poolState.sqrtPriceX96, poolState.currentTick] = [
        newSqrtPriceX96,
        newTick,
      ];
    } else {
      poolState.sqrtPriceX96 = newSqrtPriceX96;
    }

    if (poolState.liquidity !== newLiquidity)
      poolState.liquidity = newLiquidity;
    return state.amountCalculated;
  }

  _modifyPosition(
    state: PoolState,
    params: ModifyPositionParams,
  ): [bigint, bigint] {
    this.checkTicks(params.tickLower, params.tickUpper);

    let amount0 = 0n;
    let amount1 = 0n;
    if (params.liquidityDelta !== 0n) {
      if (state.currentTick < params.tickLower) {
        amount0 = SqrtPriceMath._getAmount0DeltaO(
          TickMath.getSqrtRatioAtTick(params.tickLower),
          TickMath.getSqrtRatioAtTick(params.tickUpper),
          params.liquidityDelta,
        );
      } else if (state.currentTick < params.tickUpper) {
        const liquidityBefore = state.liquidity;

        amount0 = SqrtPriceMath._getAmount0DeltaO(
          state.sqrtPriceX96,
          TickMath.getSqrtRatioAtTick(params.tickUpper),
          params.liquidityDelta,
        );
        amount1 = SqrtPriceMath._getAmount1DeltaO(
          TickMath.getSqrtRatioAtTick(params.tickLower),
          state.sqrtPriceX96,
          params.liquidityDelta,
        );

        state.liquidity = LiquidityMath.addDelta(
          liquidityBefore,
          params.liquidityDelta,
        );
      } else {
        amount1 = SqrtPriceMath._getAmount1DeltaO(
          TickMath.getSqrtRatioAtTick(params.tickLower),
          TickMath.getSqrtRatioAtTick(params.tickUpper),
          params.liquidityDelta,
        );
      }
    }
    return [amount0, amount1];
  }

  private checkTicks(tickLower: bigint, tickUpper: bigint) {
    _require(
      tickLower < tickUpper,
      'TLU',
      { tickLower, tickUpper },
      'tickLower < tickUpper',
    );
    _require(
      tickLower >= TickMath.MIN_TICK,
      'TLM',
      { tickLower },
      'tickLower >= TickMath.MIN_TICK',
    );
    _require(
      tickUpper <= TickMath.MAX_TICK,
      'TUM',
      { tickUpper },
      'tickUpper <= TickMath.MAX_TICK',
    );
  }
}

function initTickList(ticks: Record<NumberAsString, TickInfo>): TickInfo[] {
  return Object.keys(ticks)
    .map(function (tickIndex) {
      let tickInfo = ticks[tickIndex];
      return tickInfo;
    })
    .sort((tick1, tick2) => tick1.index - tick2.index);
}
export const ksElasticMath = new KsElasticMath();
