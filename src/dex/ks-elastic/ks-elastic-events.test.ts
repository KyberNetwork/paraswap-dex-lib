import dotenv from 'dotenv';
dotenv.config();

import _ from 'lodash';
import { KsElasticEventPool } from './ks-elastic-pool';
import { KsElasticConfig } from './config';
import { Network } from '../../constants';
import { DummyDexHelper } from '../../dex-helper/index';
import { testEventSubscriber } from '../../../tests/utils-events';
import { PoolState } from './types';

jest.setTimeout(300 * 1000);
const dexKey = 'KsElastic';
const network = Network.MAINNET;
const config = KsElasticConfig[dexKey][network];

async function fetchPoolStateFromContract(
  ksElasticPool: KsElasticEventPool,
  blockNumber: number,
  poolAddress: string,
): Promise<PoolState> {
  const message = `KsElastic: ${poolAddress} blockNumber ${blockNumber}`;
  console.log(`Fetching state ${message}`);
  // Be careful to not request state prior to contract deployment
  // Otherwise need to use manual state sourcing from multicall
  // We had that mechanism, but removed it with this commit
  // You can restore it, but better just to find block after state multicall
  // deployment
  const state = ksElasticPool.generateState(blockNumber);
  console.log(`Done ${message}`);
  return state;
}

describe('KsElastic Event', function () {
  const poolAddress = '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640';
  const poolFeeCode = 500n;
  const token0 = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
  const token1 = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';

  const blockNumbers: { [eventName: string]: number[] } = {
    // topic0 - 0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67
    ['Swap']: [
      15846349, 15846351, 15846352, 15846353, 15846355, 15846357, 15846358,
      15846360, 15846360, 15846361, 15846362, 15846364, 15846365, 15846366,
      15846367, 15846368, 15846369, 15846370, 15846372, 15846373, 15846374,
      15846375, 15846376, 15846381, 15846382, 15846383, 15846386, 15846387,
      15846388, 15846390, 15846391, 15846392, 15846393, 15846398, 15846400,
      15846403, 15846405, 15846407, 15846408, 15846411, 15846412, 15846413,
      15846415,
    ],
    // topic0 - 0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c
    ['Burn']: [
      15845483, 15845493, 15845539, 15845573, 15845650, 15845679, 15845680,
      15845758, 15845850, 15845865, 15845874, 15845980, 15846159, 15846217,
      15846263, 15846279, 15846297, 15846309, 15846351, 15846394, 15846398,
    ],
    // topic0 - 0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde
    ['Mint']: [
      15845479, 15845540, 15845624, 15845650, 15845655, 15845679, 15845680,
      15845758, 15845814, 15845867, 15845939, 15845946, 15845964, 15845980,
      15846000, 15846020, 15846044, 15846138, 15846159, 15846181, 15846217,
      15846229, 15846263, 15846279, 15846336, 15846351, 15846405,
    ],
  };

  describe('KsElasticEventPool', function () {
    Object.keys(blockNumbers).forEach((event: string) => {
      blockNumbers[event].forEach((blockNumber: number) => {
        it(`${event}:${blockNumber} - should return correct state`, async function () {
          const dexHelper = new DummyDexHelper(network);
          // await dexHelper.init();

          const logger = dexHelper.getLogger(dexKey);

          const ksElasticPool = new KsElasticEventPool(
            dexKey,
            dexHelper,
            logger,
            poolFeeCode,
            token0,
            token1,
            0n,
            '',
          );

          // It is done in generateState. But here have to make it manually
          ksElasticPool.poolAddress = poolAddress.toLowerCase();
          ksElasticPool.addressesSubscribed[0] = poolAddress;

          await testEventSubscriber(
            ksElasticPool,
            ksElasticPool.addressesSubscribed,
            (_blockNumber: number) =>
              fetchPoolStateFromContract(
                ksElasticPool,
                _blockNumber,
                poolAddress,
              ),
            blockNumber,
            `${dexKey}_${poolAddress}`,
            dexHelper.provider,
          );
        });
      });
    });
  });

  // We had issue with this event. Test to tackle that special case
  it('Special event case for Mint', async () => {
    const _poolAddress =
      '0x64750f4098A7F98352f7CD5797f421cEb8D94f64'.toLowerCase();
    const _feeCode = 100n;
    const _token0 = '0x4200000000000000000000000000000000000006';
    const _token1 = '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58';
    const blockNumber = 32203881;

    const dexHelper = new DummyDexHelper(Network.OPTIMISM);
    // await dexHelper.init();

    const logger = dexHelper.getLogger(dexKey);

    const _config = KsElasticConfig[dexKey][Network.OPTIMISM];

    const ksElasticPool = new KsElasticEventPool(
      dexKey,
      dexHelper,
      logger,
      _feeCode,
      _token0,
      _token1,
      0n,
      '',
    );

    // It is done in generateState. But here have to make it manually
    ksElasticPool.poolAddress = _poolAddress.toLowerCase();
    ksElasticPool.addressesSubscribed[0] = _poolAddress;

    await testEventSubscriber(
      ksElasticPool,
      ksElasticPool.addressesSubscribed,
      (_blockNumber: number) =>
        fetchPoolStateFromContract(ksElasticPool, _blockNumber, _poolAddress),
      blockNumber,
      `${dexKey}_${_poolAddress}`,
      dexHelper.provider,
    );
  });
});
