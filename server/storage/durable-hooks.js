// The calls the rest of the server makes into durable storage, kept in
// a module with no imports so that anything may use them without loading the
// database driver. server/storage/durable-store.js installs the running store
// here at boot when FIELD_STORAGE=postgres. Until then (and always when
// FIELD_STORAGE is unset) every function is a no-op and Field behaves exactly
// as it did before durable storage existed.
//
//   await flushDurableStorage({ reason })   commit point: make what this
//       request (or, outside a request, the background work) has written so far
//       durable before going on. Throws if it could not be stored.
//   flushDurableStorageQuietly({ reason })  same, but logs a failure instead of
//       throwing; the writes stay pending and are retried by the next flush.
//   registerSqliteImage(name, getHandle)    keep a SQLite database durable as a
//       whole-database image; `name` is its path relative to the data
//       directory, `getHandle()` returns the open better-sqlite3 handle or null.

let activeStore = null;
const pendingImages = new Map();

export function installDurableStore(store) {
  activeStore = store;
  if (store) {
    for (const [name, getHandle] of pendingImages) store.registerSqliteImage(name, getHandle);
  }
}

export function getActiveDurableStore() {
  return activeStore;
}

export function isDurableStorageActive() {
  return activeStore !== null;
}

export async function flushDurableStorage({ reason = "flush" } = {}) {
  if (!activeStore) return null;
  return activeStore.flushCurrent({ reason });
}

export async function flushDurableStorageQuietly({ reason = "flush", logger = console } = {}) {
  if (!activeStore) return null;
  try {
    return await activeStore.flushCurrent({ reason });
  } catch (error) {
    logger.error?.(`[storage] ${reason}: could not store changes durably yet (will retry): ${error.message}`);
    return null;
  }
}

// Registration is remembered even before the store starts, so module order at
// boot does not matter.
export function registerSqliteImage(name, getHandle) {
  pendingImages.set(name, getHandle);
  activeStore?.registerSqliteImage(name, getHandle);
}
