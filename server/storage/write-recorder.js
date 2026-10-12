// The write hook behind server/storage/fs.js and fs-promises.js.
//
// Field keeps its state as files under the data directory. Every server module
// reaches the filesystem through the storage shim, which calls the registered
// recorder with the absolute path of each successful write under the data root.
// With no recorder registered (the default) nothing is recorded and the shim
// calls node:fs exactly as before.
//
// The recorder is told which path changed and how (`kind` is the fs operation
// name without its Sync suffix, e.g. "writeFile", "rename", "rm"). It is not
// given file contents: a write through an open handle or stream is recorded
// when the file is opened, so anything that copies the data elsewhere must read
// the file from disk after the work that wrote it has finished.
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

let dataRoot = null;
let dataRootPrefix = null;
let recorder = null;

export function setDataRoot(path) {
  if (path === null || path === undefined) {
    dataRoot = null;
    dataRootPrefix = null;
    return;
  }
  dataRoot = resolve(String(path));
  dataRootPrefix = dataRoot.endsWith(sep) ? dataRoot : dataRoot + sep;
}

export function getDataRoot() {
  return dataRoot;
}

// fn(absPath, kind) runs synchronously after each successful write under the
// data root. If it throws, the error reaches the caller of the fs operation
// (thrown, rejected, or passed to the callback), so a lost record is loud.
// Pass null to stop recording.
export function setWriteRecorder(fn) {
  if (fn !== null && fn !== undefined && typeof fn !== "function") {
    throw new TypeError("write recorder must be a function or null");
  }
  recorder = fn || null;
}

export function isRecordingWrites() {
  return recorder !== null && dataRoot !== null;
}

function toAbsolutePath(pathLike) {
  if (typeof pathLike === "string") return resolve(pathLike);
  if (Buffer.isBuffer(pathLike)) return resolve(pathLike.toString());
  if (pathLike instanceof URL) return pathLike.protocol === "file:" ? fileURLToPath(pathLike) : null;
  return null; // a file descriptor or FileHandle: no path to record
}

export function isUnderDataRoot(absPath) {
  return dataRoot !== null && (absPath === dataRoot || absPath.startsWith(dataRootPrefix));
}

export function recordWrite(pathLike, kind) {
  if (!isRecordingWrites()) return;
  const absPath = toAbsolutePath(pathLike);
  if (absPath === null || !isUnderDataRoot(absPath)) return;
  recorder(absPath, kind);
}

// open()/openSync() flags that can create or change the file. `constants` is
// fs.constants, passed in so this module needs no filesystem import.
export function isWriteFlag(flags, constants) {
  if (flags === undefined || flags === null) return false; // default "r"
  if (typeof flags === "number") {
    const { O_WRONLY, O_RDWR, O_APPEND, O_CREAT, O_TRUNC } = constants;
    return (flags & (O_WRONLY | O_RDWR | O_APPEND | O_CREAT | O_TRUNC)) !== 0;
  }
  return /[wa+]/.test(String(flags));
}
