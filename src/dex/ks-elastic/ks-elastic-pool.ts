import _ from 'lodash';
import { Contract } from 'web3-eth-contract';
import { AbiItem } from 'web3-utils';
import { Interface } from '@ethersproject/abi';
import { DeepReadonly } from 'ts-essentials';
import { NumberAsString } from '@paraswap/core';

import { Log, Logger, BlockHeader, Address } from '../../types';
import { bigIntify, catchParseLogError } from '../../utils';
import {
  InitializeStateOptions,
  StatefulEventSubscriber,
} from '../../stateful-event-subscriber';
import { IDexHelper } from '../../dex-helper/idex-helper';
import { ERC20EventSubscriber } from '../../lib/generics-events-subscribers/erc20-event-subscriber';
import { getERC20Subscriber } from '../../lib/generics-events-subscribers/erc20-event-subscriber-factory';
import MultiCallABI from '../../abi/multi-v2.json';
import TicksFeesReaderABI from '../../abi/ks-elastic/TicksFeesReader.json';
import FactoryABI from '../../abi/ks-elastic/IFactory.json';
import PoolABI from '../../abi/ks-elastic/IPool.json';

import { PoolState, TickInfo } from './types';
import { ksElasticMath } from './contract-math/ks-elastic-math';
import {
  OUT_OF_RANGE_ERROR_POSTFIX,
  TickSpacing,
  toFeeTiers,
  ZeroAddress,
} from './constants';
import { KsElasticConfig } from './config';
import { PoolNotFoundError } from './errors';

export class KsElasticEventPool extends StatefulEventSubscriber<PoolState> {
  handlers: {
    [event: string]: (
      event: any,
      pool: PoolState,
      log: Log,
      blockHeader: Readonly<BlockHeader>,
    ) => PoolState;
  } = {};

  logDecoder: (log: Log) => any;

  readonly token0: Address;
  readonly token1: Address;

  private _poolAddress?: Address;
  private _stateRequestCallData?: {
    funcName: string;
    params: unknown[];
  };

  public readonly poolInterface = new Interface(PoolABI);
  public readonly multicallContract: Contract;
  public readonly factoryContract: Contract;
  public readonly ticksFeesReaderContract: Contract;

  public poolContract: Contract = new this.dexHelper.web3Provider.eth.Contract(
    PoolABI as AbiItem[],
  );
  public token0sub: ERC20EventSubscriber;
  public token1sub: ERC20EventSubscriber;

  constructor(
    parentName: string,
    readonly dexHelper: IDexHelper,
    logger: Logger,
    readonly fee: bigint,
    token0: Address,
    token1: Address,
    readonly reinvestLiquidity: bigint,
    mapKey: string = '',
  ) {
    super(
      parentName,
      `${token0}_${token1}_${fee}`,
      dexHelper,
      logger,
      true,
      mapKey,
    );
    this.token0 = token0.toLowerCase();
    this.token1 = token1.toLowerCase();
    this.logDecoder = (log: Log) => this.poolInterface.parseLog(log);
    this.addressesSubscribed = new Array<Address>(1);

    this.multicallContract = new this.dexHelper.web3Provider.eth.Contract(
      MultiCallABI as AbiItem[],
      this.dexHelper.config.data.multicallV2Address,
    );
    this.factoryContract = new this.dexHelper.web3Provider.eth.Contract(
      FactoryABI as AbiItem[],
      KsElasticConfig[parentName][this.dexHelper.config.data.network].factory,
    );
    this.ticksFeesReaderContract = new this.dexHelper.web3Provider.eth.Contract(
      TicksFeesReaderABI as AbiItem[],
      KsElasticConfig[parentName][
        this.dexHelper.config.data.network
      ].ticksFeesReader,
    );

    this.token0sub = getERC20Subscriber(this.dexHelper, this.token0);
    this.token1sub = getERC20Subscriber(this.dexHelper, this.token1);

    // Add handlers
    this.handlers['Swap'] = this.handleSwapEvent.bind(this);
    this.handlers['Burn'] = this.handleBurnEvent.bind(this);
    this.handlers['Mint'] = this.handleMintEvent.bind(this);
  }

  get poolAddress() {
    if (this._poolAddress === undefined) {
      throw new Error(
        `${this.parentName}: First call generateState at least one time before requesting poolAddress`,
      );
    }
    return this._poolAddress;
  }

  set poolAddress(address: Address) {
    this._poolAddress = address.toLowerCase();
  }

  async initialize(
    blockNumber: number,
    options?: InitializeStateOptions<PoolState>,
  ) {
    this._poolAddress = await this.getPoolAddress();
    this.poolContract = new this.dexHelper.web3Provider.eth.Contract(
      PoolABI as AbiItem[],
      this._poolAddress,
    );

    await super.initialize(blockNumber, options);

    const initPromises: any[] = [];
    if (!this.token0sub.isInitialized && !this.dexHelper.config.isSlave) {
      initPromises.push(
        this.token0sub.initialize(blockNumber, {
          state: {},
        }),
      );
    }

    if (!this.token1sub.isInitialized && !this.dexHelper.config.isSlave) {
      initPromises.push(
        this.token1sub.initialize(blockNumber, {
          state: {},
        }),
      );
    }

    await Promise.all(initPromises);

    await Promise.all([
      this.token0sub.subscribeToWalletBalanceChange(
        this.poolAddress,
        blockNumber,
      ),
      this.token1sub.subscribeToWalletBalanceChange(
        this.poolAddress,
        blockNumber,
      ),
    ]);
  }

  protected async processBlockLogs(
    state: DeepReadonly<PoolState>,
    logs: Readonly<Log>[],
    blockHeader: Readonly<BlockHeader>,
  ): Promise<DeepReadonly<PoolState> | null> {
    const newState = await super.processBlockLogs(state, logs, blockHeader);
    if (newState && !newState.isValid) {
      return await this.generateState(blockHeader.number);
    }
    return newState;
  }

  async getPoolAddress(): Promise<Address> {
    try {
      const getPoolData = {
        funcName: 'getPool',
        params: [this.token0, this.token1, Number(this.fee)],
      };
      const poolAddress = await this.factoryContract.methods[
        getPoolData.funcName
      ](...getPoolData.params).call();
      if (poolAddress === ZeroAddress) {
        throw new PoolNotFoundError(this.token0, this.token1, Number(this.fee));
      }
      return poolAddress;
    } catch (error) {
      throw error;
    }
  }

  protected processLog(
    state: DeepReadonly<PoolState>,
    log: Readonly<Log>,
    blockHeader: Readonly<BlockHeader>,
  ): DeepReadonly<PoolState> | null {
    try {
      const event = this.logDecoder(log);
      if (event.name in this.handlers) {
        // Because we have observations in array which is mutable by nature, there is a
        // ts compile error: https://stackoverflow.com/questions/53412934/disable-allowing-assigning-readonly-types-to-non-readonly-types
        // And there is no good workaround, so turn off the type checker for this line
        const _state = _.cloneDeep(state) as PoolState;
        try {
          return this.handlers[event.name](event, _state, log, blockHeader);
        } catch (e) {
          if (
            e instanceof Error &&
            e.message.endsWith(OUT_OF_RANGE_ERROR_POSTFIX)
          ) {
            this.logger.warn(
              `${this.parentName}: Pool ${this.poolAddress} on ${
                this.dexHelper.config.data.network
              } is out of TickBitmap requested range. Re-query the state. ${JSON.stringify(
                event,
              )}`,
              e,
            );
          } else {
            this.logger.error(
              `${this.parentName}: Pool ${this.poolAddress}, ` +
                `network=${this.dexHelper.config.data.network}: Unexpected ` +
                `error while handling event on blockNumber=${blockHeader.number}, ` +
                `blockHash=${blockHeader.hash} and parentHash=${
                  blockHeader.parentHash
                } for KsElastic, ${JSON.stringify(event)}`,
              e,
            );
          }
          _state.isValid = false;
          return _state;
        }
      }
    } catch (e) {
      catchParseLogError(e, this.logger);
    }
    return null; // ignore unrecognized event
  }

  private setTicksMapping(
    ticks: Record<NumberAsString, TickInfo>,
    tickArray: number[],
    tickInfosFromContract: any[],
  ) {
    return tickInfosFromContract.reduce<Record<string, TickInfo>>(
      (acc, element, index) => {
        acc[tickArray[index]] = {
          liquidityGross: bigIntify(element.liquidityGross),
          liquidityNet: bigIntify(element.liquidityNet),
          tickCumulativeOutside: bigIntify(element.feeGrowthOutside),
          secondsPerLiquidityOutsideX128: bigIntify(
            element.secondsPerLiquidityOutside,
          ),
          secondsOutside: bigIntify(
            element.liquidityNet * element.secondsPerLiquidityOutside,
          ),
          initialized: true,
          index: tickArray[index],
        };
        return acc;
      },
      ticks,
    );
  }

  async getAllTicks(poolAddress: string, blockNumber: number) {
    let startTick = -887272;
    let length = 1000;
    let shouldFinish = false;
    let allTicks: number[] = [];
    while (!shouldFinish) {
      let ticks = await this.getTickInRange(
        poolAddress,
        startTick,
        length,
        blockNumber,
      );
      if (ticks.length < length || ticks[length - 1] == 0) {
        shouldFinish = true;
      }
      allTicks = _.concat(allTicks, ticks);
    }
    return _.filter(allTicks, tick => tick != 0);
  }

  async getTickInRange(
    poolAddress: string,
    startTick: number,
    length: number,
    blockNumber: number,
  ) {
    const callRequest = {
      funcName: 'getTicksInRange',
      params: [poolAddress, startTick, length],
    };
    return this.ticksFeesReaderContract.methods[callRequest.funcName](
      ...callRequest.params,
    ).call({}, blockNumber || 'latest');
  }

  getPoolState(blockNumber: number) {
    const callRequest = {
      funcName: 'getPoolState',
      params: [],
    };
    return this.poolContract.methods[callRequest.funcName](
      ...callRequest.params,
    ).call({}, blockNumber || 'latest');
  }

  getLiquidityState(blockNumber: number) {
    return this.poolContract.methods['getLiquidityState']().call(
      {},
      blockNumber || 'latest',
    );
  }

  buildParamsForTicksCall(ticks: Number[]): {
    target: string;
    callData: string;
  }[] {
    return ticks.map(tickIndex => ({
      target: this.poolAddress,
      callData: this.poolInterface.encodeFunctionData('ticks', [tickIndex]),
    }));
  }

  decodeTicksCallResults(multiCallTickResult: []) {
    const result = new Array(multiCallTickResult.length);
    multiCallTickResult.forEach((element, index) => {
      result[index] = this.poolInterface.decodeFunctionResult('ticks', element);
    });
    return result;
  }

  async getTickInfoFromContract(ticks: number[]) {
    const multiCallResult = (
      await this.multicallContract.methods
        .aggregate(this.buildParamsForTicksCall(ticks))
        .call()
    ).returnData;
    return this.decodeTicksCallResults(multiCallResult);
  }

  public async generateState(
    blockNumber: number,
  ): Promise<Readonly<PoolState>> {
    const batchRequestData = [
      this.getAllTicks(this.poolAddress, blockNumber),
      this.getPoolState(blockNumber),
      this.getLiquidityState(blockNumber),
    ];
    const [_ticks, _poolState, _liquidityState] = await Promise.all(
      batchRequestData,
    );
    const ticks = {};
    const newTicks = _.filter(_ticks, tick => tick != 0);
    const tickInfosFromContract = await this.getTickInfoFromContract(newTicks);
    this.setTicksMapping(ticks, newTicks, tickInfosFromContract);

    // Not really a good place to do it, but in order to save RPC requests,
    // put it here
    this.addressesSubscribed[0] = this.poolAddress;

    const currentTick = _poolState.currentTick;
    const tickSpacing = bigIntify(TickSpacing[toFeeTiers(this.fee)]);
    let isValid = false;
    if (_poolState.locked == false || _poolState.locked == undefined) {
      isValid = true;
    }

    return <PoolState>{
      pool: this.poolAddress,
      tickSpacing: tickSpacing,
      fee: this.fee,
      sqrtPriceX96: bigIntify(_poolState.sqrtP),
      liquidity: bigIntify(_liquidityState.baseL),
      ticks: ticks,
      isValid: isValid,
      currentTick: bigIntify(currentTick),
      reinvestLiquidity: bigIntify(_liquidityState.reinvestL),
    };
  }

  handleSwapEvent(
    event: any,
    pool: PoolState,
    log: Log,
    blockHeader: BlockHeader,
  ) {
    const newSqrtPriceX96 = bigIntify(event.args.sqrtPriceX96);
    const amount0 = bigIntify(event.args.amount0);
    const amount1 = bigIntify(event.args.amount1);
    const newTick = bigIntify(event.args.tick);
    const newLiquidity = bigIntify(event.args.liquidity);

    if (amount0 <= 0n && amount1 <= 0n) {
      this.logger.error(
        `${this.parentName}: amount0 <= 0n && amount1 <= 0n for ` +
          `${this.poolAddress} and ${blockHeader.number}. Check why it happened`,
      );
      pool.isValid = false;
      return pool;
    } else {
      const zeroForOne = amount0 > 0n;

      ksElasticMath.swapFromEvent(
        pool,
        newSqrtPriceX96,
        newTick,
        newLiquidity,
        zeroForOne,
      );

      return pool;
    }
  }

  handleBurnEvent(
    event: any,
    pool: PoolState,
    log: Log,
    blockHeader: BlockHeader,
  ) {
    const amount = bigIntify(event.args.amount);
    const tickLower = bigIntify(event.args.tickLower);
    const tickUpper = bigIntify(event.args.tickUpper);

    ksElasticMath._modifyPosition(pool, {
      tickLower,
      tickUpper,
      liquidityDelta: -BigInt.asIntN(128, BigInt.asIntN(256, amount)),
    });

    return pool;
  }

  handleMintEvent(
    event: any,
    pool: PoolState,
    log: Log,
    blockHeader: BlockHeader,
  ) {
    const amount = bigIntify(event.args.amount);
    const tickLower = bigIntify(event.args.tickLower);
    const tickUpper = bigIntify(event.args.tickUpper);

    ksElasticMath._modifyPosition(pool, {
      tickLower,
      tickUpper,
      liquidityDelta: amount,
    });

    return pool;
  }

  public getBalanceToken0(blockNumber: number) {
    return this.token0sub.getBalance(this.poolAddress, blockNumber);
  }

  public getBalanceToken1(blockNumber: number) {
    return this.token1sub.getBalance(this.poolAddress, blockNumber);
  }
}
