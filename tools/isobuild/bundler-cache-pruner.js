// Manage the on-disk size of `APP/.meteor/local/bundler-cache`.
//
// The bundler cache has two main subdirectories that grow without bound:
//
//   * bundler-cache/scanner/<arch>/reify-<file.hash>.js
//       Reify-compiled copies of every JS/MJS file the import scanner has
//       ever seen from node_modules. Because the filename is keyed by the
//       file content hash, each npm install / version bump leaves a stale
//       entry behind that never gets cleaned up.
//
//   * bundler-cache/linker/<cacheKeyPrefix>_<suffix>.cache
//       Linker output cache. The existing in-place cleanup (via
//       `rm_recursive_deferred(prefix_*.cache)` in compiler-plugin.js)
//       only removes prior entries with the *same* prefix. When the set of
//       source files or `linkerOptions` changes (renames, new packages,
//       arch additions, salt bumps, etc.) the old prefix is orphaned and
//       never reclaimed.
//
// This module sweeps both directories using a simple LRU+TTL policy plus
// optional orphan removal driven by the set of cache key prefixes that are
// actually in use during the current bundle.
//
// All work is best-effort and non-blocking. Failures must never break the
// build.
//
// Tunable via environment variables (mirrors the style of
// METEOR_LINKER_CACHE_SIZE etc.):
//
//   METEOR_BUNDLER_CACHE_MAX_BYTES      total size cap (default 2 GiB)
//   METEOR_BUNDLER_CACHE_MAX_AGE_DAYS   evict files not touched in N days
//                                       (default 30)
//   METEOR_BUNDLER_CACHE_DISABLE_PRUNE  set to "1" to disable entirely
//   METEOR_BUNDLER_CACHE_PRUNE_INTERVAL_MS
//                                       minimum interval between prune
//                                       sweeps in this process
//                                       (default 5 minutes)
//   METEOR_BUNDLER_CACHE_DEBUG          set to "1" to log pruning activity
//   METEOR_BUNDLER_CACHE_QUIET          set to "1" to suppress the
//                                       "cache is large" warning
//   METEOR_BUNDLER_CACHE_WARN_BYTES     warn threshold (default 5 GiB)

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB
const DEFAULT_MAX_AGE_DAYS = 30;
const DEFAULT_PRUNE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_WARN_BYTES = 5 * 1024 * 1024 * 1024; // 5 GiB

function parsePositiveInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function isDisabled() {
  const v = process.env.METEOR_BUNDLER_CACHE_DISABLE_PRUNE;
  return v === '1' || v === 'true';
}

function isDebug() {
  const v = process.env.METEOR_BUNDLER_CACHE_DEBUG;
  return v === '1' || v === 'true';
}

function debugLog(...args) {
  if (isDebug()) {
    // eslint-disable-next-line no-console
    console.log('[bundler-cache-pruner]', ...args);
  }
}

// Recursively enumerate regular files under `dir`. Returns an array of
// objects { path, size, mtimeMs }. Errors are swallowed.
function listFilesRecursive(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        const child = listFilesRecursive(full);
        for (const f of child) out.push(f);
      } else if (entry.isFile()) {
        const st = fs.statSync(full);
        out.push({
          path: full,
          size: st.size,
          mtimeMs: st.mtimeMs,
        });
      }
    } catch (e) {
      // File may have been removed concurrently. Skip.
    }
  }
  return out;
}

// Public: return the total size in bytes of every regular file under `dir`,
// or 0 if the directory is missing/unreadable. Cheap enough to call once per
// bundle but not on every file event.
function getDirectorySize(dir) {
  if (!dir) return 0;
  let total = 0;
  for (const f of listFilesRecursive(dir)) {
    total += f.size;
  }
  return total;
}

// Public: update mtime/atime to "now" so that LRU eviction reflects real use.
// Best-effort: silently swallows ENOENT and other errors.
function touchFile(filePath) {
  if (!filePath) return;
  const now = new Date();
  try {
    fs.utimesSync(filePath, now, now);
  } catch (e) {
    // ignore
  }
}

function isLinkerCacheBasename(name) {
  return name.endsWith('.cache');
}

// Extract the cacheKeyPrefix from a linker cache filename.
// Filenames look like "<prefix>_<suffix>.cache".
function linkerPrefixOf(basename) {
  const stripped = basename.replace(/\.cache$/, '');
  const idx = stripped.indexOf('_');
  if (idx < 0) return null;
  return stripped.slice(0, idx);
}

// Track whether a prune is currently scheduled / when we last pruned in this
// process so we don't spam the disk on every rebuild during `meteor run`.
let lastPruneAtMs = 0;
let prunePending = false;

function pruneIntervalMs() {
  return parsePositiveInt(
    process.env.METEOR_BUNDLER_CACHE_PRUNE_INTERVAL_MS,
    DEFAULT_PRUNE_INTERVAL_MS,
  );
}

// Public: schedule a best-effort prune of the bundler cache. Returns a
// Promise that resolves to the prune summary (or null if skipped). The
// caller is free to ignore the return value; failures never throw.
//
// Options:
//   bundlerCacheDir       - the root bundler-cache dir; required.
//   activeLinkerPrefixes  - optional Set/array of cacheKeyPrefix strings
//                           seen during the current bundle. Linker entries
//                           with a prefix outside this set and older than
//                           one day are treated as orphans and removed
//                           regardless of the size cap.
//   force                 - if true, ignore the cooldown.
function maybePruneBundlerCache(options) {
  const opts = options || {};
  if (isDisabled()) {
    debugLog('disabled via METEOR_BUNDLER_CACHE_DISABLE_PRUNE');
    return Promise.resolve(null);
  }
  const bundlerCacheDir = opts.bundlerCacheDir;
  if (!bundlerCacheDir) return Promise.resolve(null);

  const now = Date.now();
  if (!opts.force && (now - lastPruneAtMs) < pruneIntervalMs()) {
    return Promise.resolve(null);
  }
  if (prunePending) return Promise.resolve(null);
  prunePending = true;
  lastPruneAtMs = now;

  // Defer to next tick so callers are never blocked.
  return new Promise((resolve) => {
    setImmediate(() => {
      let result = null;
      try {
        result = pruneSync({
          bundlerCacheDir,
          activeLinkerPrefixes: normalizePrefixes(opts.activeLinkerPrefixes),
          maxBytes: parsePositiveInt(
            process.env.METEOR_BUNDLER_CACHE_MAX_BYTES,
            DEFAULT_MAX_BYTES,
          ),
          maxAgeMs: parsePositiveInt(
            process.env.METEOR_BUNDLER_CACHE_MAX_AGE_DAYS,
            DEFAULT_MAX_AGE_DAYS,
          ) * 24 * 60 * 60 * 1000,
        });
      } catch (e) {
        debugLog('prune failed:', e && e.message);
      } finally {
        prunePending = false;
        resolve(result);
      }
    });
  });
}

function normalizePrefixes(prefixes) {
  if (!prefixes) return null;
  if (prefixes instanceof Set) return prefixes;
  if (Array.isArray(prefixes)) return new Set(prefixes);
  return null;
}

// Synchronous prune implementation, exported for testing. Returns a
// summary object: { scanned, removed, bytesBefore, bytesAfter }.
function pruneSync({
  bundlerCacheDir,
  activeLinkerPrefixes = null,
  maxBytes = DEFAULT_MAX_BYTES,
  maxAgeMs = DEFAULT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000,
  now = Date.now(),
} = {}) {
  if (!bundlerCacheDir) {
    return { scanned: 0, removed: 0, bytesBefore: 0, bytesAfter: 0 };
  }

  const scannerDir = path.join(bundlerCacheDir, 'scanner');
  const linkerDir = path.join(bundlerCacheDir, 'linker');

  const scannerFiles = listFilesRecursive(scannerDir);
  const linkerFiles = listFilesRecursive(linkerDir);

  // Tag each entry with what it is so we can use prefix-based orphan
  // detection only on linker entries.
  for (const f of scannerFiles) f.kind = 'scanner';
  for (const f of linkerFiles) f.kind = 'linker';

  const all = scannerFiles.concat(linkerFiles);
  const bytesBefore = all.reduce((s, f) => s + f.size, 0);

  const removedPaths = new Set();
  const removeOne = (f, reason) => {
    if (removedPaths.has(f.path)) return false;
    try {
      fs.unlinkSync(f.path);
      removedPaths.add(f.path);
      debugLog('removed', reason, f.path, '(' + f.size + ' bytes)');
      return true;
    } catch (e) {
      if (e && e.code !== 'ENOENT') {
        debugLog('failed to remove', f.path, e.message);
      }
      // Mark as removed for accounting so we don't try again this pass.
      removedPaths.add(f.path);
      return true;
    }
  };

  // Pass 1: orphan linker entries (prefix not in active set, > 1 day old).
  // This is opt-in: only runs when the caller supplied the active prefix set.
  const ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000; // 1 day
  if (activeLinkerPrefixes && activeLinkerPrefixes.size > 0) {
    for (const f of linkerFiles) {
      const basename = path.basename(f.path);
      if (!isLinkerCacheBasename(basename)) continue;
      const prefix = linkerPrefixOf(basename);
      if (prefix === null) continue;
      if (activeLinkerPrefixes.has(prefix)) continue;
      if ((now - f.mtimeMs) < ORPHAN_MIN_AGE_MS) continue;
      removeOne(f, 'orphan');
    }
  }

  // Pass 2: TTL eviction. Anything older than maxAgeMs goes.
  if (maxAgeMs > 0) {
    const cutoff = now - maxAgeMs;
    for (const f of all) {
      if (f.mtimeMs < cutoff) removeOne(f, 'expired');
    }
  }

  // Pass 3: LRU eviction down to maxBytes.
  let remainingBytes = 0;
  const remaining = [];
  for (const f of all) {
    if (removedPaths.has(f.path)) continue;
    remainingBytes += f.size;
    remaining.push(f);
  }
  if (maxBytes > 0 && remainingBytes > maxBytes) {
    // Oldest mtime first.
    remaining.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const f of remaining) {
      if (remainingBytes <= maxBytes) break;
      if (removeOne(f, 'size-cap')) {
        remainingBytes -= f.size;
      }
    }
  }

  const summary = {
    scanned: all.length,
    removed: removedPaths.size,
    bytesBefore,
    bytesAfter: remainingBytes,
  };

  if (summary.removed > 0) {
    debugLog('pruned', summary);
  }

  return summary;
}

// Public helper: returns true the first time it's called in this process,
// after that returns false (used to throttle the "cache is large" warning
// to once per session).
let warnShown = false;
function shouldWarnAboutSize(bytes) {
  if (warnShown) return false;
  const v = process.env.METEOR_BUNDLER_CACHE_QUIET;
  if (v === '1' || v === 'true') return false;
  const threshold = parsePositiveInt(
    process.env.METEOR_BUNDLER_CACHE_WARN_BYTES,
    DEFAULT_WARN_BYTES,
  );
  if (threshold > 0 && bytes >= threshold) {
    warnShown = true;
    return true;
  }
  return false;
}

function formatBytes(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u += 1;
  }
  const fixed = (u === 0) ? n.toFixed(0) : n.toFixed(1);
  return fixed + ' ' + units[u];
}

// Reset internal state. Test-only.
function _resetForTests() {
  lastPruneAtMs = 0;
  prunePending = false;
  warnShown = false;
}

module.exports = {
  maybePruneBundlerCache,
  pruneSync,
  getDirectorySize,
  touchFile,
  shouldWarnAboutSize,
  formatBytes,
  // Test helpers
  _resetForTests,
  _DEFAULT_MAX_BYTES: DEFAULT_MAX_BYTES,
  _DEFAULT_MAX_AGE_DAYS: DEFAULT_MAX_AGE_DAYS,
  _DEFAULT_WARN_BYTES: DEFAULT_WARN_BYTES,
};
