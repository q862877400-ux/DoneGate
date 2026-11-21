// skill/hash.mjs 的 vitest 测试：给变异测试（Stryker）提供完备断言覆盖。
import { describe, it, expect } from 'vitest';
import { sha256, sha256Short, frozenHashOf, sortKeysDeep, materialFingerprintOf } from '../skill/hash.mjs';

describe('sha256：整文件字节的标准实现', () => {
  it('空串的 SHA-256 是 e3b0c442...', () => {
    expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
  it('"abc" 的 SHA-256 是 ba7816bf...', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('不同输入给不同输出', () => {
    expect(sha256('a')).not.toBe(sha256('b'));
  });
  it('null / undefined 按空串处理', () => {
    expect(sha256(null)).toBe(sha256(''));
    expect(sha256(undefined)).toBe(sha256(''));
  });
});

describe('sha256Short：默认截 12 位', () => {
  it('默认长度是 12 位十六进制', () => {
    const s = sha256Short('abc');
    expect(s).toHaveLength(12);
    expect(s).toBe(sha256('abc').slice(0, 12));
  });
  it('长度可指定，且截的是前 len 位（含 0 边界）', () => {
    expect(sha256Short('abc', 8)).toBe(sha256('abc').slice(0, 8));
    expect(sha256Short('abc', 8)).toHaveLength(8);
    expect(sha256Short('abc', 0)).toBe('');
  });
  it('不同输入给不同短哈希', () => {
    expect(sha256Short('a')).not.toBe(sha256Short('b'));
  });
});

describe('sortKeysDeep：键名递归排序、数组保序、原始值与 null 安全', () => {
  it('嵌套对象的键序被打平', () => {
    const a = sortKeysDeep({ b: 1, a: { d: 2, c: 3 } });
    expect(JSON.stringify(a)).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
  it('数组保持原序且内部对象递归排序', () => {
    const a = sortKeysDeep({ list: [3, 1, 2], objs: [{ z: 1, a: 2 }] });
    expect(JSON.stringify(a)).toBe('{"list":[3,1,2],"objs":[{"a":2,"z":1}]}');
  });
  it('null / undefined / 原始类型原样返回不抛异常', () => {
    expect(sortKeysDeep(null)).toBe(null);
    expect(sortKeysDeep(undefined)).toBe(undefined);
    expect(sortKeysDeep(42)).toBe(42);
    expect(sortKeysDeep('plain')).toBe('plain');
    expect(sortKeysDeep(false)).toBe(false);
  });
});

describe('frozenHashOf：契约冻结哈希精确口径', () => {
  const base = { id: 'c01', claim: 'x', scope: 'y', required: true };

  it('键序不同、哈希相同', () => {
    const a = { ...base, claim: 'x', scope: 'y' };
    const b = { scope: 'y', claim: 'x', id: 'c01', required: true };
    expect(frozenHashOf(a)).toBe(frozenHashOf(b));
  });
  it('排除 frozenHash / teeth / signedBy 三个字段', () => {
    const withMeta = { ...base, frozenHash: 'abc', teeth: { status: 'killed' }, signedBy: '业主' };
    expect(frozenHashOf(withMeta)).toBe(frozenHashOf(base));
  });
  it('保留了 scopeAck（参与哈希）', () => {
    const withAck = { ...base, scopeAck: { by: '业主', at: '2026-11-19' } };
    expect(frozenHashOf(withAck)).not.toBe(frozenHashOf(base));
  });
  it('判据内容改一个字，哈希就变；空输入退化为空对象哈希不报错', () => {
    expect(frozenHashOf({ ...base, claim: 'x!' })).not.toBe(frozenHashOf(base));
    expect(frozenHashOf(null)).toBe(frozenHashOf({}));
    expect(frozenHashOf(undefined)).toBe(frozenHashOf({}));
  });
});

describe('materialFingerprintOf：D01 统一材料指纹归一化', () => {
  const h1 = 'a'.repeat(64);
  const h2 = 'b'.repeat(64);

  it('多层反斜杠、数组乱序、带 sha256: 前缀与大写，输出完全一致', () => {
    const f1 = materialFingerprintOf([
      { path: 'src\\sub\\b.mjs', sha256: 'SHA256:' + h2.toUpperCase() },
      { path: 'src/sub/a.mjs', hash: h1 }
    ]);
    const f2 = materialFingerprintOf({
      'src/sub/a.mjs': h1,
      'src\\sub\\b.mjs': 'SHA256:' + h2.toUpperCase()
    });
    expect(f1).toBe(f2);
    expect(f1).toBe(materialFingerprintOf([{ path: 'src/sub/a.mjs', sha256: h1 }, { path: 'src/sub/b.mjs', sha256: h2 }]));
    expect(f1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('缺字段或空输入安全兜底为确定性 64 位小写 hex', () => {
    const emptyArr = materialFingerprintOf([]);
    const emptyNull = materialFingerprintOf(null);
    const emptyUndef = materialFingerprintOf(undefined);
    expect(emptyArr).toBe(emptyNull);
    expect(emptyArr).toBe(emptyUndef);
    expect(materialFingerprintOf([null, { path: 'x.mjs' }])).not.toBe(emptyArr);
    expect(materialFingerprintOf([{ sha256: h1 }])).toBe(materialFingerprintOf([{ path: '', sha256: h1 }]));
    expect(materialFingerprintOf({ 'x.mjs': null })).toBe(materialFingerprintOf([{ path: 'x.mjs', sha256: '' }]));
    expect(materialFingerprintOf([{ path: 'x.mjs', sha256: 'sha256:sha256:' + h1 }])).not.toBe(materialFingerprintOf([{ path: 'x.mjs', sha256: h1 }]));
    expect(materialFingerprintOf({ 'x.mjs': 'sha256:sha256:' + h1 })).not.toBe(materialFingerprintOf({ 'x.mjs': h1 }));
  });

  it('路径或哈希任一变化，指纹必变', () => {
    const baseFp = materialFingerprintOf([{ path: 'a.mjs', sha256: h1 }]);
    expect(materialFingerprintOf([{ path: 'b.mjs', sha256: h1 }])).not.toBe(baseFp);
    expect(materialFingerprintOf([{ path: 'a.mjs', sha256: h2 }])).not.toBe(baseFp);
  });
});
