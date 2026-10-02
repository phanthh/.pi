import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;

export interface MirrorStorage {
  directory: string;
  path: string;
  read(): string;
  write(text: string): void;
  reject(text: string): string;
  writeRevisions(text: string): string;
  release(): void;
}

/** The lock belongs to one extension runtime, including multiple runtimes in one process. */
export function openMirror(sessionFile: string): MirrorStorage {
  const directory = `${sessionFile}.context`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) {
    throw new Error(`Live context sidecar is not a regular directory: ${directory}`);
  }
  const lock = join(directory, "writer.lock");
  const token = randomUUID();
  const claim = JSON.stringify({ pid: process.pid, token });
  let fd: number;
  try {
    fd = openSync(lock, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Live context already has a writer: ${lock}. If its process exited, remove the stale lock before enabling again.`);
    }
    throw error;
  }
  try {
    writeFileSync(fd, claim, "utf8");
  } catch (error) {
    unlinkSync(lock);
    throw error;
  } finally {
    closeSync(fd);
  }
  const path = join(directory, "live.md");
  let released = false;
  const assertOwner = () => {
    if (released || readRegular(lock) !== claim) throw new Error("Live context writer ownership changed; no file was updated.");
  };
  return {
    directory,
    path,
    read: () => { assertOwner(); return readRegular(path); },
    write: (text) => { assertOwner(); atomicWrite(path, text); },
    reject: (text) => {
      assertOwner();
      const rejected = join(directory, "rejected.md");
      atomicWrite(rejected, text);
      return rejected;
    },
    writeRevisions: (text) => {
      assertOwner();
      const revisions = join(directory, "revisions.md");
      atomicWrite(revisions, text);
      return revisions;
    },
    release: () => {
      if (released) return;
      try {
        if (readRegular(lock) === claim) unlinkSync(lock);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      } finally {
        released = true;
      }
    },
  };
}

function readRegular(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`Live context path is not a regular file: ${path}`);
    if (stat.size > MAX_DOCUMENT_BYTES) throw new Error(`Live context file exceeds ${MAX_DOCUMENT_BYTES} bytes.`);
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

function atomicWrite(path: string, text: string): void {
  if (Buffer.byteLength(text, "utf8") > MAX_DOCUMENT_BYTES) throw new Error(`Live context file exceeds ${MAX_DOCUMENT_BYTES} bytes.`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
