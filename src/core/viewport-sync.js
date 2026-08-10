/**
 * Coalesce high-frequency viewport events (resize / visualViewport.scroll)
 * into at most one real apply per animation frame.
 * When width/height are unchanged, apply is skipped (near-zero work).
 */
export function createViewportSyncController(options = {}) {
  const getBox = typeof options.getBox === 'function'
    ? options.getBox
    : () => ({ width: 0, height: 0 });
  const apply = typeof options.apply === 'function' ? options.apply : () => {};
  const raf = typeof options.raf === 'function'
    ? options.raf
    : (typeof globalThis.requestAnimationFrame === 'function'
      ? globalThis.requestAnimationFrame.bind(globalThis)
      : callback => globalThis.setTimeout(callback, 0));
  const cancelRaf = typeof options.cancelRaf === 'function'
    ? options.cancelRaf
    : (typeof globalThis.cancelAnimationFrame === 'function'
      ? globalThis.cancelAnimationFrame.bind(globalThis)
      : id => globalThis.clearTimeout?.(id));

  let pendingRaf = 0;
  let lastWidth = null;
  let lastHeight = null;
  let applyCount = 0;
  let skippedUnchangedCount = 0;
  let scheduledCount = 0;

  function runApply() {
    pendingRaf = 0;
    const box = getBox() || { width: 0, height: 0 };
    const width = Number(box.width) || 0;
    const height = Number(box.height) || 0;
    if (lastWidth === width && lastHeight === height) {
      skippedUnchangedCount += 1;
      return false;
    }
    lastWidth = width;
    lastHeight = height;
    applyCount += 1;
    apply({ width, height, box });
    return true;
  }

  function requestSync() {
    scheduledCount += 1;
    if (pendingRaf) return false;
    pendingRaf = raf(() => {
      runApply();
    });
    return true;
  }

  function flushNow() {
    if (pendingRaf) {
      cancelRaf(pendingRaf);
      pendingRaf = 0;
    }
    return runApply();
  }

  function reset() {
    if (pendingRaf) {
      cancelRaf(pendingRaf);
      pendingRaf = 0;
    }
    lastWidth = null;
    lastHeight = null;
    applyCount = 0;
    skippedUnchangedCount = 0;
    scheduledCount = 0;
  }

  return {
    requestSync,
    flushNow,
    reset,
    getState: () => ({
      pendingRaf: Boolean(pendingRaf),
      lastWidth,
      lastHeight,
      applyCount,
      skippedUnchangedCount,
      scheduledCount,
    }),
  };
}
