// File store for the user-memory plugin. One memory file per agent and person, with a lock so
// concurrent appends do not lose notes, and a size cap that drops the oldest notes first.

import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/** Hard cap per (agent, user) memory file unless the plugin config overrides it. */
export const DEFAULT_MAX_BYTES = 16 * 1024;

const LOCK_RETRIES = 100;
const LOCK_RETRY_MS = 20;
const LOCK_STALE_MS = 30_000;

/**
 * Encodes a key so the mapping is injective even on a case-insensitive filesystem: only lowercase
 * letters, digits, "-", "_" and "." pass through, every other byte (uppercase included) becomes %XX,
 * nothing is trimmed, and a leading "." is encoded so no segment can ever be "." or "..".
 */
function encodeKey(value: string, label: string): string {
  if (!value.trim()) {
    throw new Error(`user memory: empty ${label}`);
  }
  let out = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const char = String.fromCharCode(byte);
    const literal = /[a-z0-9_-]/.test(char) || (char === "." && out.length > 0);
    out += literal ? char : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** One file per agent and user, both segments encoded so a key can never escape the root or collide. */
export function memoryFilePath(rootDir: string, agentId: string, user: string): string {
  return path.join(rootDir, encodeKey(agentId, "agent id"), `${encodeKey(user, "user")}.md`);
}

/** Returns the stored notes, or an empty string when the user has none yet. */
export async function readMemory(file: string): Promise<string> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw err;
  }
}

function formatEntry(note: string, now: Date): string {
  const oneLine = note.replace(/\s+/g, " ").trim();
  if (!oneLine) {
    throw new Error("user memory: empty note");
  }
  return `- ${now.toISOString().slice(0, 10)}: ${oneLine}`;
}

/** Drops the oldest lines until the text fits the cap. Returns the kept text and how many were dropped. */
export function trimToCap(lines: string[], maxBytes: number): { lines: string[]; dropped: number } {
  const kept = [...lines];
  let dropped = 0;
  while (kept.length > 0 && Buffer.byteLength(kept.join("\n") + "\n", "utf8") > maxBytes) {
    kept.shift();
    dropped += 1;
  }
  return { lines: kept, dropped };
}

async function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${file}.lock`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(lockPath, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
      const stat = await fs.stat(lockPath).catch(() => undefined);
      if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        // Reclaim through an atomic rename so only one contender can take a stale lock away, and a lock
        // freshly acquired by someone else can never be unlinked from under them.
        const stale = `${lockPath}.stale.${process.pid}.${randomBytes(4).toString("hex")}`;
        const reclaimed = await fs.rename(lockPath, stale).then(() => true, () => false);
        if (reclaimed) {
          await fs.unlink(stale).catch(() => undefined);
        }
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
      continue;
    }
    try {
      return await fn();
    } finally {
      try {
        await handle.close();
      } finally {
        await fs.unlink(lockPath).catch(() => undefined);
      }
    }
  }
  throw new Error(`user memory: could not lock ${path.basename(file)} after ${LOCK_RETRIES} attempts`);
}

async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tmp, text, "utf8");
  await fs.rename(tmp, file);
}

export type AppendResult = { entries: number; bytes: number; dropped: number };

/**
 * Appends one note and rewrites the file under the cap, oldest entries first out.
 * A note that cannot fit on its own is refused rather than silently truncated.
 */
export async function appendMemory(
  file: string,
  note: string,
  opts: { maxBytes: number; now?: Date },
): Promise<AppendResult> {
  const entry = formatEntry(note, opts.now ?? new Date());
  if (Buffer.byteLength(entry + "\n", "utf8") > opts.maxBytes) {
    throw new Error(`user memory: note is larger than the ${opts.maxBytes} byte cap`);
  }
  return withFileLock(file, async () => {
    const existing = (await readMemory(file)).split("\n").filter((line) => line.length > 0);
    const { lines, dropped } = trimToCap([...existing, entry], opts.maxBytes);
    const text = lines.join("\n") + "\n";
    await writeAtomic(file, text);
    return { entries: lines.length, bytes: Buffer.byteLength(text, "utf8"), dropped };
  });
}
