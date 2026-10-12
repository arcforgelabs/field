// The node:fs/promises half of Field's storage shim (see ./fs.js). Everything
// passes straight through; operations that create, change or remove a path
// record it with the write recorder once they resolve. Until a recorder is
// registered each wrapper returns node:fs/promises' own promise.
//
// A FileHandle from open() is recorded when it is opened for writing; writes
// made through the handle afterwards are not recorded again.
import * as nodeFsPromises from "node:fs/promises";
import { isRecordingWrites, isWriteFlag, recordWrite } from "./write-recorder.js";

export * from "node:fs/promises";

const target = (index) => (args) => [args[index]];
const sourceAndTarget = (args) => [args[0], args[1]];
const created = (_args, result) => [result];
const openedForWrite = (args) => (isWriteFlag(args[1], nodeFsPromises.constants) ? [args[0]] : []);

function wrapAsync(raw, kind, pathsOf) {
  return function (...args) {
    if (!isRecordingWrites()) return raw(...args);
    return raw(...args).then((result) => {
      for (const path of pathsOf(args, result)) recordWrite(path, kind);
      return result;
    });
  };
}

export const writeFile = wrapAsync(nodeFsPromises.writeFile, "writeFile", target(0));
export const appendFile = wrapAsync(nodeFsPromises.appendFile, "appendFile", target(0));
export const rename = wrapAsync(nodeFsPromises.rename, "rename", sourceAndTarget);
export const rm = wrapAsync(nodeFsPromises.rm, "rm", target(0));
export const rmdir = wrapAsync(nodeFsPromises.rmdir, "rmdir", target(0));
export const unlink = wrapAsync(nodeFsPromises.unlink, "unlink", target(0));
export const mkdir = wrapAsync(nodeFsPromises.mkdir, "mkdir", target(0));
export const mkdtemp = wrapAsync(nodeFsPromises.mkdtemp, "mkdtemp", created);
export const copyFile = wrapAsync(nodeFsPromises.copyFile, "copyFile", target(1));
export const cp = wrapAsync(nodeFsPromises.cp, "cp", target(1));
export const open = wrapAsync(nodeFsPromises.open, "open", openedForWrite);
export const truncate = wrapAsync(nodeFsPromises.truncate, "truncate", target(0));
export const symlink = wrapAsync(nodeFsPromises.symlink, "symlink", target(1));
export const link = wrapAsync(nodeFsPromises.link, "link", target(1));
export const utimes = wrapAsync(nodeFsPromises.utimes, "utimes", target(0));
export const lutimes = wrapAsync(nodeFsPromises.lutimes, "lutimes", target(0));
export const chmod = wrapAsync(nodeFsPromises.chmod, "chmod", target(0));
export const lchmod = wrapAsync(nodeFsPromises.lchmod, "lchmod", target(0));
export const chown = wrapAsync(nodeFsPromises.chown, "chown", target(0));
export const lchown = wrapAsync(nodeFsPromises.lchown, "lchown", target(0));

export default {
  ...nodeFsPromises.default,
  writeFile, appendFile, rename, rm, rmdir, unlink, mkdir, mkdtemp, copyFile,
  cp, open, truncate, symlink, link, utimes, lutimes, chmod, lchmod, chown, lchown,
};
