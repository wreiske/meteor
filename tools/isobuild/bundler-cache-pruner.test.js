// Unit tests for tools/isobuild/bundler-cache-pruner.js
//
// These tests operate on a real temporary directory rather than mocking fs,
// so they exercise the same code paths used during a real build.

const fs = require('fs');
const os = require('os');
const path = require('path');

const pruner = require('./bundler-cache-pruner');

function mkTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bundler-cache-test-'));
}

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch (e) {
    // ignore
  }
}

function writeFile(p, contents, mtimeSecondsAgo) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, contents);
  if (mtimeSecondsAgo !== undefined) {
    const t = new Date(Date.now() - mtimeSecondsAgo * 1000);
    fs.utimesSync(p, t, t);
  }
}

describe('bundler-cache-pruner', () => {
  let tmp;

  beforeEach(() => {
    tmp = mkTempDir();
    pruner._resetForTests();
    // Make sure no environment overrides leak between tests.
    delete process.env.METEOR_BUNDLER_CACHE_DISABLE_PRUNE;
    delete process.env.METEOR_BUNDLER_CACHE_QUIET;
    delete process.env.METEOR_BUNDLER_CACHE_MAX_BYTES;
    delete process.env.METEOR_BUNDLER_CACHE_MAX_AGE_DAYS;
    delete process.env.METEOR_BUNDLER_CACHE_PRUNE_INTERVAL_MS;
    delete process.env.METEOR_BUNDLER_CACHE_WARN_BYTES;
  });

  afterEach(() => {
    rmrf(tmp);
  });

  describe('getDirectorySize', () => {
    test('returns 0 for missing directories', () => {
      expect(pruner.getDirectorySize(path.join(tmp, 'does-not-exist'))).toBe(0);
    });

    test('sums sizes recursively', () => {
      writeFile(path.join(tmp, 'a.cache'), 'x'.repeat(100));
      writeFile(path.join(tmp, 'sub', 'b.cache'), 'y'.repeat(50));
      writeFile(path.join(tmp, 'sub', 'nested', 'c.cache'), 'z'.repeat(25));
      expect(pruner.getDirectorySize(tmp)).toBe(175);
    });
  });

  describe('touchFile', () => {
    test('updates mtime', () => {
      const p = path.join(tmp, 'x.cache');
      writeFile(p, 'hi', /* mtime */ 60 * 60 * 24);
      const before = fs.statSync(p).mtimeMs;
      pruner.touchFile(p);
      const after = fs.statSync(p).mtimeMs;
      expect(after).toBeGreaterThan(before);
    });

    test('silently ignores missing files', () => {
      expect(() => pruner.touchFile(path.join(tmp, 'nope'))).not.toThrow();
    });
  });

  describe('pruneSync - TTL eviction', () => {
    test('removes files older than maxAge', () => {
      const scannerDir = path.join(tmp, 'scanner', 'web.browser');
      writeFile(path.join(scannerDir, 'reify-old.js'),
        'old', /* 40 days */ 40 * 24 * 60 * 60);
      writeFile(path.join(scannerDir, 'reify-fresh.js'),
        'fresh', /* 1 day */ 24 * 60 * 60);

      const summary = pruner.pruneSync({
        bundlerCacheDir: tmp,
        maxAgeMs: 30 * 24 * 60 * 60 * 1000,
        maxBytes: 1024 * 1024,
      });

      expect(fs.existsSync(path.join(scannerDir, 'reify-old.js'))).toBe(false);
      expect(fs.existsSync(path.join(scannerDir, 'reify-fresh.js'))).toBe(true);
      expect(summary.removed).toBe(1);
    });
  });

  describe('pruneSync - size cap', () => {
    test('evicts oldest files until under cap', () => {
      const scannerDir = path.join(tmp, 'scanner', 'web.browser');
      writeFile(path.join(scannerDir, 'reify-a.js'),
        'a'.repeat(400), /* oldest */ 1000);
      writeFile(path.join(scannerDir, 'reify-b.js'),
        'b'.repeat(400), 500);
      writeFile(path.join(scannerDir, 'reify-c.js'),
        'c'.repeat(400), 1);

      const summary = pruner.pruneSync({
        bundlerCacheDir: tmp,
        maxAgeMs: 0, // disable TTL
        maxBytes: 500,
      });

      // Need to drop from 1200 to ≤500; evict oldest a (1200→800), then b
      // (800→400). c (newest) remains.
      expect(fs.existsSync(path.join(scannerDir, 'reify-a.js'))).toBe(false);
      expect(fs.existsSync(path.join(scannerDir, 'reify-b.js'))).toBe(false);
      expect(fs.existsSync(path.join(scannerDir, 'reify-c.js'))).toBe(true);
      expect(summary.removed).toBe(2);
      expect(summary.bytesAfter).toBeLessThanOrEqual(500);
    });

    test('no-op when under cap', () => {
      writeFile(path.join(tmp, 'scanner', 'web.browser', 'reify-a.js'),
        'small', 1);
      const summary = pruner.pruneSync({
        bundlerCacheDir: tmp,
        maxAgeMs: 0,
        maxBytes: 1024 * 1024,
      });
      expect(summary.removed).toBe(0);
    });
  });

  describe('pruneSync - orphan linker cleanup', () => {
    test('removes linker entries whose prefix is not active and which are >1d old', () => {
      const linkerDir = path.join(tmp, 'linker');
      writeFile(path.join(linkerDir, 'aaa_111.cache'),
        'orphan', /* 2 days */ 2 * 24 * 60 * 60);
      writeFile(path.join(linkerDir, 'bbb_222.cache'),
        'active', /* 2 days */ 2 * 24 * 60 * 60);
      writeFile(path.join(linkerDir, 'ccc_333.cache'),
        'orphan-but-fresh', /* 1 hour */ 60 * 60);

      const summary = pruner.pruneSync({
        bundlerCacheDir: tmp,
        activeLinkerPrefixes: new Set(['bbb']),
        maxAgeMs: 0,
        maxBytes: 0,
      });

      expect(fs.existsSync(path.join(linkerDir, 'aaa_111.cache'))).toBe(false);
      expect(fs.existsSync(path.join(linkerDir, 'bbb_222.cache'))).toBe(true);
      expect(fs.existsSync(path.join(linkerDir, 'ccc_333.cache'))).toBe(true);
      expect(summary.removed).toBe(1);
    });

    test('does nothing without an active prefix set', () => {
      const linkerDir = path.join(tmp, 'linker');
      writeFile(path.join(linkerDir, 'aaa_111.cache'), 'x',
        2 * 24 * 60 * 60);
      const summary = pruner.pruneSync({
        bundlerCacheDir: tmp,
        maxAgeMs: 0,
        maxBytes: 0,
      });
      expect(fs.existsSync(path.join(linkerDir, 'aaa_111.cache'))).toBe(true);
      expect(summary.removed).toBe(0);
    });
  });

  describe('maybePruneBundlerCache', () => {
    test('returns null when disabled by env var', async () => {
      process.env.METEOR_BUNDLER_CACHE_DISABLE_PRUNE = '1';
      writeFile(path.join(tmp, 'linker', 'a_b.cache'), 'x',
        40 * 24 * 60 * 60);
      const result = await pruner.maybePruneBundlerCache({
        bundlerCacheDir: tmp,
      });
      expect(result).toBeNull();
      expect(fs.existsSync(path.join(tmp, 'linker', 'a_b.cache'))).toBe(true);
    });

    test('honors cooldown', async () => {
      process.env.METEOR_BUNDLER_CACHE_MAX_AGE_DAYS = '30';
      writeFile(path.join(tmp, 'linker', 'a_b.cache'), 'x',
        40 * 24 * 60 * 60);
      const first = await pruner.maybePruneBundlerCache({
        bundlerCacheDir: tmp,
      });
      expect(first).not.toBeNull();
      const second = await pruner.maybePruneBundlerCache({
        bundlerCacheDir: tmp,
      });
      expect(second).toBeNull();
    });

    test('does nothing when bundlerCacheDir is missing', async () => {
      const result = await pruner.maybePruneBundlerCache({});
      expect(result).toBeNull();
    });
  });

  describe('shouldWarnAboutSize', () => {
    test('triggers above threshold, only once', () => {
      process.env.METEOR_BUNDLER_CACHE_WARN_BYTES = '1000';
      expect(pruner.shouldWarnAboutSize(2000)).toBe(true);
      expect(pruner.shouldWarnAboutSize(2000)).toBe(false);
    });

    test('respects METEOR_BUNDLER_CACHE_QUIET', () => {
      process.env.METEOR_BUNDLER_CACHE_QUIET = '1';
      process.env.METEOR_BUNDLER_CACHE_WARN_BYTES = '1000';
      expect(pruner.shouldWarnAboutSize(2000)).toBe(false);
    });

    test('does not trigger below threshold', () => {
      process.env.METEOR_BUNDLER_CACHE_WARN_BYTES = '1000000';
      expect(pruner.shouldWarnAboutSize(100)).toBe(false);
    });
  });

  describe('formatBytes', () => {
    test('formats in human-readable units', () => {
      expect(pruner.formatBytes(0)).toBe('0 B');
      expect(pruner.formatBytes(512)).toBe('512 B');
      expect(pruner.formatBytes(1024)).toBe('1.0 KiB');
      expect(pruner.formatBytes(5 * 1024 * 1024 * 1024)).toBe('5.0 GiB');
    });
  });
});
