import { DexConfigMap } from '../../types';
import { DexParams } from './types';

export function getKsElasticDexKey(KsElasticConfig: DexConfigMap<DexParams>) {
  const KsElasticKeys = Object.keys(KsElasticConfig);
  if (KsElasticKeys.length !== 1) {
    throw new Error(
      `KsElastic key in KsElasticConfig is not unique. Update relevant places (optimizer) or fix config issue. Received: ${JSON.stringify(
        KsElasticConfig,
        (_0, value) => (typeof value === 'bigint' ? value.toString() : value),
      )}`,
    );
  }

  return KsElasticKeys[0].toLowerCase();
}

export function setImmediatePromise() {
  return new Promise<void>(resolve => {
    setImmediate(() => {
      resolve();
    });
  });
}
