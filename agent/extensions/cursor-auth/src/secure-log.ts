import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  openSync,
  writeFileSync,
} from "node:fs";

/** Append only to an owned, private regular file. Never follow a final symlink. */
export function appendPrivateLog(path: string, content: string): void {
  let fd: number | undefined;
  try {
    if (!Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0) {
      throw new Error("Safe debug logging is unsupported on this platform");
    }
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT |
        constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600,
    );
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
      throw new Error("Unsafe debug log destination");
    }
    // Existing files must be private before any sensitive content is appended.
    fchmodSync(fd, 0o600);
    writeFileSync(fd, content, "utf8");
  } catch {
    // Do not expose paths, file content, or filesystem exception details.
    throw new Error("Cannot safely append debug log");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
