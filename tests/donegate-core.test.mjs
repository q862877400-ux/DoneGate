import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dispatchCommand } from '../runner/donegate.mjs';
import { appendChainEntry, readAndVerifyChain } from '../runner/core/chain.mjs';

describe('DoneGate 0.4.0 核心命令、三色依赖边与防伪哈希链', () => {
  it('append-only 哈希链逐条校验 prevHash 与 seq 连续性', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dg-vitest-'));
    try {
      const a1 = appendChainEntry(dir, { kind: 'freeze', contractId: 'c1', signedBy: '业主' });
      const a2 = appendChainEntry(dir, { kind: 'verify-result', contractId: 'c1', result: 'pass' });
      expect(a1.ok).toBe(true);
      expect(a2.entry.seq).toBe(2);
      expect(readAndVerifyChain(dir).ok).toBe(true);

      const chainPath = join(dir, '.donegate', 'chain.jsonl');
      const lines = readFileSync(chainPath, 'utf8').trim().split('\n');
      const tampered = JSON.parse(lines[0]);
      tampered.signedBy = '冒充者';
      writeFileSync(chainPath, JSON.stringify(tampered) + '\n' + lines[1] + '\n');
      const broken = readAndVerifyChain(dir);
      expect(broken.ok).toBe(false);
      expect(broken.exitCode).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('init / contract new / gaps / graph 三档覆盖率均按规格返回退出码', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dg-vitest2-'));
    try {
      expect(dispatchCommand(['init', '.'], dir).exitCode).toBe(0);
      expect(dispatchCommand(['init', '.'], dir).exitCode).toBe(3);
      expect(dispatchCommand(['contract', 'new', 'c1', '--title', '测试', '--scope', 'src/a.mjs'], dir).exitCode).toBe(0);
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src/a.mjs'), 'export const a = 1;\n');
      writeFileSync(join(dir, 'src/b.mjs'), 'export const b = 2;\n');
      const g2 = dispatchCommand(['graph'], dir);
      expect(g2.exitCode).toBe(0);
      expect(g2.tier).toBe(2);
      const gaps = dispatchCommand(['gaps', '--json'], dir);
      expect(gaps.exitCode).toBe(0);
      expect(JSON.parse(gaps.stdout).length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('三条禁令、虚假隔离声明、三色依赖边与 60 天意图复核门均按规格拦截', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dg-vitest3-'));
    try {
      expect(dispatchCommand(['init', '.'], dir).exitCode).toBe(0);
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src/a.mjs'), 'import "./b.mjs";\nimport "./d.mjs";\nexport const a = 1;\n');
      writeFileSync(join(dir, 'src/b.mjs'), 'export const b = 2;\n');
      writeFileSync(join(dir, 'src/c.mjs'), 'export const c = 3;\n');
      writeFileSync(join(dir, 'src/d.mjs'), 'export const d = 4;\n');
      dispatchCommand(['contract', 'new', 'ca', '--title', 'A', '--scope', 'src/a.mjs', '--depends-on', 'cb,cc'], dir);
      dispatchCommand(['contract', 'new', 'cb', '--title', 'B', '--scope', 'src/b.mjs'], dir);
      dispatchCommand(['contract', 'new', 'cc', '--title', 'C', '--scope', 'src/c.mjs'], dir);
      dispatchCommand(['contract', 'new', 'cd', '--title', 'D', '--scope', 'src/d.mjs'], dir);
      const g = dispatchCommand(['graph'], dir);
      expect(g.exitCode).toBe(0);
      expect(g.edges.solid).toEqual([{ from: 'ca', to: 'cb' }]);
      expect(g.edges.dashed).toEqual([{ from: 'ca', to: 'cc' }]);
      expect(g.edges.red).toEqual([{ from: 'ca', to: 'cd' }]);
      expect(g.stdout).toContain('实线 1 条 | 虚线 1 条 | 红线 1 条');

      const cj = JSON.parse(readFileSync(join(dir, 'contracts/cb/contract.json'), 'utf8'));
      cj.why = 'test';
      cj.obligations = [{
        id: 'ob-ban', kind: 'command', command: 'node -e "process.exit(0)" || true', expect: { exitCode: 0 },
        required: true, claim: 'x', observable: 'y', scope: 'z', inputClasses: ['正常'], servesSuccessCriterion: 's'
      }];
      writeFileSync(join(dir, 'contracts/cb/contract.json'), JSON.stringify(cj, null, 2));
      dispatchCommand(['contract', 'freeze', 'cb', '--by', '业主'], dir);
      expect(dispatchCommand(['check', 'cb', '--allow-dirty'], dir).exitCode).toBe(2);

      cj.obligations[0].command = 'node -e "process.exit(0)"';
      writeFileSync(join(dir, 'contracts/cb/contract.json'), JSON.stringify(cj, null, 2));
      dispatchCommand(['contract', 'freeze', 'cb', '--by', '业主'], dir);
      writeFileSync(join(dir, 'INTENT.md'), readFileSync(join(dir, 'INTENT.md'), 'utf8') + '\n<!-- reviewed: 2020-01-01 by 业主 -->\n');
      const staleIntentRes = dispatchCommand(['check', 'cb', '--allow-dirty'], dir);
      expect(staleIntentRes.exitCode).toBe(1);
      expect(staleIntentRes.stderr).toContain('意图已超过');

      writeFileSync(join(dir, '.donegate/runner.json'), JSON.stringify({
        isolation: 'seccomp', dimensions: { file: true, network: false }
      }));
      const fakeIsoRes = dispatchCommand(['check', 'cb', '--allow-dirty'], dir);
      expect(fakeIsoRes.exitCode).toBe(2);
      expect(fakeIsoRes.stderr).toContain('隔离校验失败');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--help 不落盘执行，布尔标志不吞位置参数，且 --allow-dirty 禁进通过数与复核包', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dg-vitest4-'));
    try {
      const h1 = dispatchCommand(['init', '--help'], dir);
      const h2 = dispatchCommand(['handover', '-h'], dir);
      expect(h1.exitCode).toBe(0);
      expect(h2.exitCode).toBe(0);
      expect(existsSync(join(dir, 'INTENT.md'))).toBe(false);
      expect(existsSync(join(dir, 'HANDOVER.md'))).toBe(false);

      dispatchCommand(['init', '.'], dir);
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src/a.mjs'), 'export const a = 1;\n');
      dispatchCommand(['contract', 'new', 'ca', '--title', 'A', '--scope', 'src/a.mjs'], dir);
      const caPath = join(dir, 'contracts/ca/contract.json');
      const ca = JSON.parse(readFileSync(caPath, 'utf8'));
      ca.why = 'test';
      ca.obligations = [{
        id: 'o1', kind: 'command', command: 'node -e "process.exit(0)"', expect: { exitCode: 0 },
        required: true, claim: 'ok', observable: 'exit 0', scope: 'src/a.mjs', inputClasses: ['正常'], servesSuccessCriterion: 's'
      }];
      writeFileSync(caPath, JSON.stringify(ca, null, 2));
      spawnSync('git', ['-C', dir, 'init', '-q']);
      spawnSync('git', ['-C', dir, 'config', 'user.email', 't@local']);
      spawnSync('git', ['-C', dir, 'config', 'user.name', 'T']);
      spawnSync('git', ['-C', dir, 'add', '.']);
      spawnSync('git', ['-C', dir, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init']);
      dispatchCommand(['contract', 'freeze', 'ca', '--by', '业主'], dir);

      const dirtyCheck = dispatchCommand(['check', '--allow-dirty', 'ca'], dir);
      expect(dirtyCheck.exitCode).toBe(0);
      const st = dispatchCommand(['status'], dir);
      expect(st.stdout).toContain('无法判断 1');
      expect(st.stdout).toContain('通过 0');
      const pk = dispatchCommand(['verify', 'pack', 'ca'], dir);
      expect(pk.exitCode).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
