import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dispatchCommand } from '../runner/donegate.mjs';
import { buildPreCommitScript, resolveSkillPrefix } from '../skill/install-hooks.mjs';

describe('DoneGate 0.4.0 复核包、全流程进度卡、完结门工作台与跨盘符钩子', () => {
  it('verify pack 多契约同批提交不误报越界、保留跨 scope 源码 diff、且拒绝空提交伪造 diff', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dg-vitest5-'));
    try {
      dispatchCommand(['init', '.'], dir);
      writeFileSync(join(dir, '.gitignore'), '.donegate/\n');
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src/a.mjs'), 'export const a = 1;\n');
      writeFileSync(join(dir, 'src/b.mjs'), 'export const b = 1;\n');
      dispatchCommand(['contract', 'new', 'ca', '--title', 'A', '--scope', 'src/a.mjs'], dir);
      dispatchCommand(['contract', 'new', 'cb', '--title', 'B', '--scope', 'src/b.mjs'], dir);
      for (const id of ['ca', 'cb']) {
        const p = join(dir, `contracts/${id}/contract.json`);
        const c = JSON.parse(readFileSync(p, 'utf8'));
        c.why = 'test';
        c.obligations = [{
          id: 'o1', kind: 'command', command: 'node -e "process.exit(0)"', expect: { exitCode: 0 },
          required: true, claim: 'ok', observable: 'exit 0', scope: `src/${id[1]}.mjs`, inputClasses: ['正常'], servesSuccessCriterion: 's'
        }];
        writeFileSync(p, JSON.stringify(c, null, 2));
      }
      spawnSync('git', ['-C', dir, 'init', '-q']);
      spawnSync('git', ['-C', dir, 'config', 'user.email', 't@local']);
      spawnSync('git', ['-C', dir, 'config', 'user.name', 'T']);
      spawnSync('git', ['-C', dir, 'add', '.']);
      spawnSync('git', ['-C', dir, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init']);
      dispatchCommand(['contract', 'freeze', 'ca', '--by', '业主'], dir);
      dispatchCommand(['contract', 'freeze', 'cb', '--by', '业主'], dir);
      spawnSync('git', ['-C', dir, 'add', '.']);
      spawnSync('git', ['-C', dir, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'freeze both']);

      writeFileSync(join(dir, 'src/a.mjs'), 'export const a = 2;\n');
      writeFileSync(join(dir, 'src/b.mjs'), 'export const b = 2;\n');
      writeFileSync(join(dir, 'src/extra.mjs'), 'export const ex = 1;\n');
      spawnSync('git', ['-C', dir, 'add', '.']);
      spawnSync('git', ['-C', dir, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'impl both']);

      expect(dispatchCommand(['check', 'ca'], dir).exitCode).toBe(0);
      const pk = dispatchCommand(['verify', 'pack', 'ca'], dir);
      expect(pk.exitCode).toBe(0);
      const diffBody = readFileSync(join(pk.packDir, 'diff/ca.diff'), 'utf8');
      expect(diffBody).toContain('src/a.mjs');
      expect(diffBody).toContain('src/extra.mjs');
      expect(diffBody).not.toContain('contracts/cb/');

      spawnSync('git', ['-C', dir, '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-q', '-m', 'empty']);
      const pkEmpty = dispatchCommand(['verify', 'pack', 'ca', '--base', 'HEAD~1', '--head', 'HEAD'], dir);
      expect(pkEmpty.exitCode).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('全流程命令机械触发分阶段缩进进度卡：动态读取项目模块名、实时递增且脏运行不虚涨', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dg-vitest6-'));
    const grabPct = (txt) => {
      const m = String(txt || '').match(/DoneGate · 验收进度\s+[█░]{10}\s+(\d+)%/);
      return m ? Number(m[1]) : null;
    };
    try {
      const rInit = dispatchCommand(['init', '.'], dir);
      expect(rInit.exitCode).toBe(0);
      expect(rInit.stdout).toContain('#### 📊 DoneGate · 验收进度');
      expect(rInit.stdout).toContain('  1-1 ✅');
      const pInit = grabPct(rInit.stdout);
      expect(pInit).toBe(5);

      mkdirSync(join(dir, 'app'), { recursive: true });
      writeFileSync(join(dir, '.gitignore'), '.donegate/\n');
      writeFileSync(join(dir, 'app/auth.mjs'), 'export const login = (u) => Boolean(u);\n');

      const rNew = dispatchCommand(['contract', 'new', 'auth-mod', '--title', '安卓登录鉴权', '--scope', 'app/auth.mjs'], dir);
      expect(rNew.exitCode).toBe(0);
      expect(rNew.stdout).toContain('  2-1 ⏳ 安卓登录鉴权');
      const pNew = grabPct(rNew.stdout);
      expect(pNew).toBe(10);

      const cPath = join(dir, 'contracts/auth-mod/contract.json');
      const c = JSON.parse(readFileSync(cPath, 'utf8'));
      c.why = '用户登录';
      c.obligations = [{
        id: 'login-ok', kind: 'command', command: 'node -e "import(\'./app/auth.mjs\').then(m=>process.exit(m.login(\'a\')?0:1))"',
        expect: { exitCode: 0 }, required: true, claim: '合法账号登录返回 true', observable: 'exit 0',
        scope: 'app/auth.mjs', inputClasses: ['正常'], servesSuccessCriterion: 's',
        breakPatch: { file: 'app/auth.mjs', from: 'Boolean(u)', to: 'false' }
      }];
      writeFileSync(cPath, JSON.stringify(c, null, 2));

      spawnSync('git', ['-C', dir, 'init', '-q']);
      spawnSync('git', ['-C', dir, 'config', 'user.email', 't@local']);
      spawnSync('git', ['-C', dir, 'config', 'user.name', 'T']);
      spawnSync('git', ['-C', dir, 'add', '.']);
      spawnSync('git', ['-C', dir, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init']);

      const rFreeze = dispatchCommand(['contract', 'freeze', 'auth-mod', '--by', '业主'], dir);
      expect(rFreeze.exitCode).toBe(0);
      expect(rFreeze.stdout).toContain('🔒 「安卓登录鉴权」1 项验收标准已锁定');
      const pFreeze = grabPct(rFreeze.stdout);
      expect(pFreeze).toBeGreaterThan(pNew);

      writeFileSync(join(dir, 'app/dirty.txt'), 'uncommitted');
      const rDirty = dispatchCommand(['check', '--allow-dirty', 'auth-mod'], dir);
      expect(rDirty.stdout).toContain('⚠️ 脏工作区调试运行');
      expect(grabPct(rDirty.stdout)).toBe(pFreeze);
      rmSync(join(dir, 'app/dirty.txt'));

      spawnSync('git', ['-C', dir, 'add', '.']);
      spawnSync('git', ['-C', dir, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'freeze']);

      const rCheck = dispatchCommand(['check', 'auth-mod'], dir);
      expect(rCheck.exitCode).toBe(0);
      expect(rCheck.stdout).toContain('✅ 「安卓登录鉴权」1/1 项检查通过');
      const pCheck = grabPct(rCheck.stdout);
      expect(pCheck).toBeGreaterThan(pFreeze);

      const rTeeth = dispatchCommand(['teeth', 'auth-mod', 'login-ok'], dir);
      expect(rTeeth.exitCode).toBe(0);
      expect(rTeeth.stdout).toContain('✅ [3-1]');
      const pTeeth = grabPct(rTeeth.stdout);
      expect(pTeeth).toBeGreaterThan(pCheck);

      const rHo = dispatchCommand(['handover'], dir);
      expect(rHo.exitCode).toBe(0);
      expect(rHo.stdout).toContain('✅ [4-2] 交接包 HANDOVER.md 已生成');
      expect(grabPct(rHo.stdout)).toBeGreaterThan(pTeeth);

      writeFileSync(join(dir, 'app/temp.txt'), 'dirty');
      const rWarn3 = dispatchCommand(['check', 'auth-mod'], dir);
      expect(rWarn3.exitCode).toBe(3);
      expect(rWarn3.stderr).toContain('⚠️ DoneGate · 进度受阻（阻断提醒');
      rmSync(join(dir, 'app/temp.txt'));

      const beforeNotePct = grabPct(dispatchCommand(['status'], dir).stdout);
      const noteCli = join(process.cwd(), 'skill/progress-note.mjs');
      const rEmptyGood = spawnSync(process.execPath, [noteCli, '--kind', 'good', '--stage', '2', '--title', '已完成真机实测', '--root', dir], { encoding: 'utf8' });
      expect(rEmptyGood.status).toBe(1);
      const rFailGood = spawnSync(process.execPath, [noteCli, '--kind', 'good', '--stage', '2', '--title', '已完成真机实测', '--verify-cmd', 'node -e "process.exit(1)"', '--root', dir], { encoding: 'utf8' });
      expect(rFailGood.status).toBe(1);
      const rSpoofGood = spawnSync(process.execPath, [noteCli, '--kind', 'worry', '--stage', '2', '--title', '总进度 100% 全部通关', '--root', dir], { encoding: 'utf8' });
      expect(rSpoofGood.status).toBe(2);

      const rGoodNote = spawnSync(process.execPath, [noteCli, '--kind', 'good', '--stage', '2', '--title', '已完成华为机型真机冷启动实测', '--verify-cmd', 'node -e "process.exit(0)"', '--root', dir], { encoding: 'utf8' });
      expect(rGoodNote.status).toBe(0);
      expect(rGoodNote.stdout).toContain('  2-💬 ✅ [补充·已验真] 已完成华为机型真机冷启动实测');
      const rWorryNote = spawnSync(process.execPath, [noteCli, '--kind', 'worry', '--stage', '3', '--title', '弱网 3G 下登录超时待优化', '--root', dir], { encoding: 'utf8' });
      expect(rWorryNote.status).toBe(0);
      expect(rWorryNote.stdout).toContain('  3-💬 ⚠️ [报忧] 弱网 3G 下登录超时待优化');
      expect(grabPct(rWorryNote.stdout)).toBe(beforeNotePct);

      const rVerifyNotes = spawnSync(process.execPath, [noteCli, '--verify-all', '--rerun', '--root', dir], { encoding: 'utf8' });
      expect(rVerifyNotes.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('超大项目（>6 模块）自动折叠聊天进度、输出完结门工作台离线看板且 handover 吐出高熵注入块', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dg-vitest7-'));
    try {
      dispatchCommand(['init', '.'], dir);
      for (let i = 1; i <= 8; i++) {
        dispatchCommand(['contract', 'new', `mod-${i}`, '--title', `核心业务模块 ${i}`], dir);
      }
      const st = dispatchCommand(['status'], dir);
      expect(st.exitCode).toBe(0);
      expect(st.stdout).toContain('已自动折叠');
      expect(st.stdout).toContain('.donegate/dashboard.html');
      const dashHtml = readFileSync(join(dir, '.donegate', 'dashboard.html'), 'utf8');
      expect(dashHtml).toContain('完结门工作台');
      expect(dashHtml).toContain('let ATLAS =');
      expect(dashHtml).toContain('flyCanvasToNode');
      expect(dashHtml).toContain('核心业务模块 8');

      const ho = dispatchCommand(['handover'], dir);
      expect(ho.exitCode).toBe(0);
      expect(ho.stdout).toContain('下一棒直接注入上下文块');
      expect(ho.stdout).toContain('1. 项目与红线：本项目核心目标是');
      expect(ho.stdout).toContain('3. 本轮唯一目标：请接手契约');
      expect(ho.stdout).toContain('.donegate/dashboard.html');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('install-hooks 兼顾 Windows 盘符大小写、跨盘符绝对路径与 0.4.0 精简公开仓自检钩子', () => {
    const winDg = win32.join('D:', 'skills', 'DoneGate');
    const expectedWinSkill = win32.join(winDg, 'skill').replace(/\\/g, '/');
    const winCrossTmp = win32.join('C:', 'Users', 'Dev', 'AppData', 'Local', 'Temp', 'dg-hook-test');
    const winParent = win32.join('D:');
    const winSameCaseDiff = win32.join('d:', 'skills', 'donegate');

    expect(resolveSkillPrefix(winCrossTmp, winDg, win32)).toBe(expectedWinSkill);
    expect(resolveSkillPrefix(winParent, winDg, win32)).toBe(expectedWinSkill);
    expect(resolveSkillPrefix(winSameCaseDiff, winDg, win32)).toBe('skill');

    const crossScript = buildPreCommitScript(winCrossTmp, winDg, win32);
    expect(crossScript).toContain(`DG_SKILL="${expectedWinSkill}"`);
    expect(crossScript).not.toContain('DG_SKILL="skill"');
    expect(crossScript).toContain('[ -f "skill/check-escapes.mjs" ] && [ -f "escapes.jsonl" ]');

    expect(resolveSkillPrefix('/workspace/DoneGate', '/workspace/DoneGate', posix)).toBe('skill');
    expect(resolveSkillPrefix('/workspace', '/workspace/DoneGate', posix)).toBe('/workspace/DoneGate/skill');
    expect(resolveSkillPrefix('/tmp/demo-proj', '/workspace/DoneGate', posix)).toBe('/workspace/DoneGate/skill');
  });
});
