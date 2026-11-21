// Stryker 配置：把「判据有没有牙」从人工改坏变成机器读数。
// 只变异一个纯函数靶子（skill/hash.mjs）作为快速高信噪比核验。
export default {
  mutate: ['skill/hash.mjs'],
  testRunner: 'vitest',
  vitest: { configFile: 'vitest.config.mjs' },
  coverageAnalysis: 'perTest',
  reporters: ['clear-text', 'json'],
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  tempDirName: '.stryker-tmp',
  cleanTempDir: true,
  thresholds: { high: 90, low: 70, break: 70 },
  timeoutMS: 20000,
  concurrency: 4,
};
