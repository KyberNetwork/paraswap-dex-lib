import _ from 'lodash';
import { NumberAsString, SwapSide } from 'paraswap-core';
import { DeepReadonly } from 'ts-essentials';

import { BI_MAX_INT } from '../../../bigint-constants';
import { _require } from '../../../utils';
import { PoolState, TickInfo, OutputResult } from '../types';
import { ONE, ZERO } from '../internal-constants';
import { OUT_OF_RANGE_ERROR_POSTFIX } from '../constants';

import { LiquidityMath } from './LiquidityMath';
import { SqrtPriceMath } from './SqrtPriceMath';
import { SwapMath } from './SwapMath';
import { TickList } from './TickList';
import { TickMath } from './TickMath';

type ModifyPositionParams = {
  tickLower: bigint;
  tickUpper: bigint;
  liquidityDelta: bigint;
};

class KsElasticMath {
  queryOutputs(
    poolState: DeepReadonly<PoolState>,
    inputAmounts: bigint[],
    zeroForOne: boolean,
    side: SwapSide,
  ): OutputResult {
    let outputResult: OutputResult = {
      outputs: [],
      tickCounts: [],
    };
    const isSell = side === SwapSide.SELL;

    inputAmounts.map(inputAmount => {
      let swapResults = this.swap(
        poolState,
        zeroForOne,
        (inputAmount = isSell
          ? BigInt.asIntN(256, inputAmount)
          : -BigInt.asIntN(256, inputAmount)),
      );
      outputResult.outputs.push(swapResults.output);
      outputResult.tickCounts.push(swapResults.tickCount);
    });

    return outputResult;
  }

  private swap(
    poolState: PoolState,
    zeroForOne: boolean,
    amountSpecified: bigint,
  ): {
    output: bigint;
    tickCount: number;
  } {
    const tickList = initTickList(poolState.ticks);
    const sqrtPriceLimitX96 = zeroForOne
      ? TickMath.MIN_SQRT_RATIO + 1n
      : TickMath.MAX_SQRT_RATIO - 1n;

    _require(
      zeroForOne
        ? sqrtPriceLimitX96 < poolState.sqrtPriceX96 &&
            sqrtPriceLimitX96 > TickMath.MIN_SQRT_RATIO
        : sqrtPriceLimitX96 > poolState.sqrtPriceX96 &&
            sqrtPriceLimitX96 < TickMath.MAX_SQRT_RATIO,
      'SPL',
      { zeroForOne, sqrtPriceLimitX96, poolState },
      'zeroForOne ? sqrtPriceLimitX96 < slot0Start.sqrtPriceX96 && sqrtPriceLimitX96 > TickMath.MIN_SQRT_RATIO : sqrtPriceLimitX96 > slot0Start.sqrtPriceX96 && sqrtPriceLimitX96 < TickMath.MAX_SQRT_RATIO',
    );

    const exactInput = amountSpecified >= ZERO;

    const state = {
      amountSpecifiedRemaining: amountSpecified,
      amountCalculated: ZERO,
      baseL: poolState.liquidity,
      reinvestL: poolState.reinvestLiquidity,
      sqrtPriceX96: poolState.sqrtPriceX96,
      tick: poolState.currentTick,
    };
    let tickCount = 0;

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

      let nextTick: number;
      let initialized: boolean;
      try {
        [nextTick, initialized] =
          TickList.nextInitializedTickWithinFixedDistance(
            tickList,
            Number(state.tick),
            zeroForOne,
            480,
          );
        step.tickNext = BigInt(nextTick);
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
      let stateAfterSwapping = SwapMath.computeSwapStep(
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
        BigInt(poolState.fee),
      );

      state.sqrtPriceX96 = stateAfterSwapping.sqrtRatioNextX96;
      step.amountIn = stateAfterSwapping.amountIn;
      step.amountOut = stateAfterSwapping.amountOut;
      step.deltaL = stateAfterSwapping.deltaL;

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
      tickCount++;
    }
    return { output: state.amountCalculated, tickCount: tickCount };
  }

  swapFromEvent(
    poolState: PoolState,
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
      amountSpecifiedRemaining: BI_MAX_INT,
      amountCalculated: 0n,
      sqrtPriceX96: poolState.sqrtPriceX96,
      tick: poolState.currentTick,
      protocolFee: 0n,
      liquidity: cache.liquidityStart,
      reinvestL: poolState.reinvestLiquidity,
      fee: poolState.fee,
      tickList: tickList,
    };

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
      let stateAfterSwapping = SwapMath.computeSwapStep(
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
      );

      state.sqrtPriceX96 = stateAfterSwapping.sqrtRatioNextX96;
      step.amountIn = stateAfterSwapping.amountIn;
      step.amountOut = stateAfterSwapping.amountOut;
      step.deltaL = stateAfterSwapping.deltaL;
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
