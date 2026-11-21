// vitest 配置：只跑 tests/ 下的测试。
// 十二条判据不经过这里——它们是 `node skill/xxx.mjs` 直跑的零依赖脚本。
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.mjs'],
    reporters: ['default'],
    // 含多轮 git/node 子进程的集成用例在 Windows + Defender 扫描下易超过默认 5000ms
    testTimeout: 30000,
  },
});
