// Field's only door to node:fs. Server modules import from here (or from
// ./fs-promises.js) instead of node:fs, so every write under the data root can
// be recorded through the hook in ./write-recorder.js (the data
// directory is mirrored to durable storage on hosts that discard local files).
//
// Everything node:fs exports passes straight through. The operations below that
// create, change or remove a path are wrapped: after one succeeds, the path is
// handed to the write recorder if it is under the data root. Until a recorder
// is registered each wrapper calls node:fs with the caller's own arguments and
// returns its result untouched.
//
// Not recorded: writes through a file descriptor (write, writev, ftruncate,
// fchmod, ...), whose path is recorded when the descriptor is opened for
// writing, WriteStream constructed directly with `new`, and
// mkdtempDisposable(Sync), which Field does not use.
import * as nodeFs from "node:fs";
import * as promises from "./fs-promises.js";
import { isRecordingWrites, isWriteFlag, recordWrite } from "./write-recorder.js";

export * from "node:fs";
export { promises };
export { setDataRoot, setWriteRecorder, getDataRoot } from "./write-recorder.js";

const target = (index) => (args) => [args[index]];
const sourceAndTarget = (args) => [args[0], args[1]];
const created = (_args, result) => [result];
const openedForWrite = (args) => (isWriteFlag(typeof args[1] === "function" ? undefined : args[1], nodeFs.constants) ? [args[0]] : []);

function recordAll(paths, kind) {
  for (const path of paths) recordWrite(path, kind);
}

function wrapSync(raw, kind, pathsOf) {
  return function (...args) {
    if (!isRecordingWrites()) return raw(...args);
    const result = raw(...args);
    recordAll(pathsOf(args, result), kind);
    return result;
  };
}

function wrapCallback(raw, kind, pathsOf) {
  return function (...args) {
    const callback = args[args.length - 1];
    if (!isRecordingWrites() || typeof callback !== "function") return raw(...args);
    const callArgs = args.slice(0, -1);
    return raw(...callArgs, function (error, result) {
      if (error) return callback.apply(this, arguments);
      try {
        recordAll(pathsOf(callArgs, result), kind);
      } catch (recordError) {
        return callback(recordError);
      }
      return callback.apply(this, arguments);
    });
  };
}

export const writeFileSync = wrapSync(nodeFs.writeFileSync, "writeFile", target(0));
export const writeFile = wrapCallback(nodeFs.writeFile, "writeFile", target(0));
export const appendFileSync = wrapSync(nodeFs.appendFileSync, "appendFile", target(0));
export const appendFile = wrapCallback(nodeFs.appendFile, "appendFile", target(0));
export const renameSync = wrapSync(nodeFs.renameSync, "rename", sourceAndTarget);
export const rename = wrapCallback(nodeFs.rename, "rename", sourceAndTarget);
export const rmSync = wrapSync(nodeFs.rmSync, "rm", target(0));
export const rm = wrapCallback(nodeFs.rm, "rm", target(0));
export const rmdirSync = wrapSync(nodeFs.rmdirSync, "rmdir", target(0));
export const rmdir = wrapCallback(nodeFs.rmdir, "rmdir", target(0));
export const unlinkSync = wrapSync(nodeFs.unlinkSync, "unlink", target(0));
export const unlink = wrapCallback(nodeFs.unlink, "unlink", target(0));
export const mkdirSync = wrapSync(nodeFs.mkdirSync, "mkdir", target(0));
export const mkdir = wrapCallback(nodeFs.mkdir, "mkdir", target(0));
export const mkdtempSync = wrapSync(nodeFs.mkdtempSync, "mkdtemp", created);
export const mkdtemp = wrapCallback(nodeFs.mkdtemp, "mkdtemp", created);
export const copyFileSync = wrapSync(nodeFs.copyFileSync, "copyFile", target(1));
export const copyFile = wrapCallback(nodeFs.copyFile, "copyFile", target(1));
export const cpSync = wrapSync(nodeFs.cpSync, "cp", target(1));
export const cp = wrapCallback(nodeFs.cp, "cp", target(1));
export const openSync = wrapSync(nodeFs.openSync, "open", openedForWrite);
export const open = wrapCallback(nodeFs.open, "open", openedForWrite);
export const truncateSync = wrapSync(nodeFs.truncateSync, "truncate", target(0));
export const truncate = wrapCallback(nodeFs.truncate, "truncate", target(0));
export const symlinkSync = wrapSync(nodeFs.symlinkSync, "symlink", target(1));
export const symlink = wrapCallback(nodeFs.symlink, "symlink", target(1));
export const linkSync = wrapSync(nodeFs.linkSync, "link", target(1));
export const link = wrapCallback(nodeFs.link, "link", target(1));
export const utimesSync = wrapSync(nodeFs.utimesSync, "utimes", target(0));
export const utimes = wrapCallback(nodeFs.utimes, "utimes", target(0));
export const lutimesSync = wrapSync(nodeFs.lutimesSync, "lutimes", target(0));
export const lutimes = wrapCallback(nodeFs.lutimes, "lutimes", target(0));
export const chmodSync = wrapSync(nodeFs.chmodSync, "chmod", target(0));
export const chmod = wrapCallback(nodeFs.chmod, "chmod", target(0));
export const chownSync = wrapSync(nodeFs.chownSync, "chown", target(0));
export const chown = wrapCallback(nodeFs.chown, "chown", target(0));
export const lchownSync = wrapSync(nodeFs.lchownSync, "lchown", target(0));
export const lchown = wrapCallback(nodeFs.lchown, "lchown", target(0));

// The file is recorded once the stream has opened it (created or truncated).
// A recorder error destroys the stream, which surfaces as its "error" event.
export function createWriteStream(path, options) {
  const stream = nodeFs.createWriteStream(path, options);
  if (!isRecordingWrites()) return stream;
  stream.once("open", () => {
    try {
      recordWrite(path, "createWriteStream");
    } catch (error) {
      stream.destroy(error);
    }
  });
  return stream;
}

export default {
  ...nodeFs.default,
  writeFileSync, writeFile, appendFileSync, appendFile, renameSync, rename,
  rmSync, rm, rmdirSync, rmdir, unlinkSync, unlink, mkdirSync, mkdir,
  mkdtempSync, mkdtemp, copyFileSync, copyFile, cpSync, cp, openSync, open,
  truncateSync, truncate, symlinkSync, symlink, linkSync, link,
  utimesSync, utimes, lutimesSync, lutimes, chmodSync, chmod,
  chownSync, chown, lchownSync, lchown, createWriteStream,
  promises,
};
