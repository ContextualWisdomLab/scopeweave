// Validate the browser file-picker result at the platform boundary before
// application code treats it as durable file-write authority. A cancelled
// picker still propagates its native AbortError unchanged; malformed handles
// fail closed and are handled by ScopeWeave's existing connection error path.
(() => {
  const nativeShowSaveFilePicker = window.showSaveFilePicker;
  if (typeof nativeShowSaveFilePicker !== 'function') {
    return;
  }

  window.showSaveFilePicker = async (...args) => {
    const handle = await nativeShowSaveFilePicker.apply(window, args);
    if (!handle || typeof handle.createWritable !== 'function') {
      throw new TypeError('File picker returned an unusable file handle.');
    }
    return handle;
  };
})();
