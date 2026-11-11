// Vitest suite for store.ts, the user-memory file store: appends, the size cap, the lock and keeping
// two people's files apart. It uses a temporary folder only.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendMemory, memoryFilePath, readMemory, trimToCap } from "./store.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "user-memory-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("store", () => {
  it("keeps two users of the same agent apart in both directions", async () => {
    const dana = memoryFilePath(root, "sales", "dana.whitfield@northwind.example");
    const marcus = memoryFilePath(root, "sales", "marcus.oyelaran@northwind.example");

    await appendMemory(dana, "territory is west", { maxBytes: 16384 });
    expect(await readMemory(marcus)).toBe("");
    expect(await readMemory(dana)).toContain("territory is west");

    await appendMemory(marcus, "territory is east", { maxBytes: 16384 });
    expect(await readMemory(dana)).not.toContain("east");
    expect(await readMemory(marcus)).not.toContain("west");
    expect(await readMemory(marcus)).toContain("territory is east");
  });

  it("keeps the same user apart across agents", async () => {
    const sales = memoryFilePath(root, "sales", "dana.whitfield@northwind.example");
    const ads = memoryFilePath(root, "ads", "dana.whitfield@northwind.example");
    await appendMemory(sales, "prefers email", { maxBytes: 16384 });
    expect(await readMemory(ads)).toBe("");
  });

  it("never lets a key escape the root", () => {
    const file = memoryFilePath(root, "../sales", "../../etc/passwd");
    expect(file.startsWith(root + path.sep)).toBe(true);
    expect(path.relative(root, file).split(path.sep)).not.toContain("..");
    expect(() => memoryFilePath(root, "sales", "   ")).toThrow(/empty user/);
  });

  it("gives distinct principals distinct files on disk, case, whitespace and unicode included", async () => {
    const users = ["A@example.com", "a@example.com", " a@example.com ", "alex+sales@example.com", "alex_sales@example.com", "李@example.com", "王@example.com"];
    const files = users.map((user) => memoryFilePath(root, "sales", user));
    expect(new Set(files).size).toBe(users.length);
    for (const [i, file] of files.entries()) {
      expect(file.startsWith(root + path.sep)).toBe(true);
      expect(path.basename(file)).toMatch(/^(?:[a-z0-9._-]|%[0-9A-F]{2})+\.md$/);
      await appendMemory(file, `note ${i}`, { maxBytes: 16384 });
    }
    // On a case-insensitive filesystem two names that differ only by case would land in one file.
    expect(await fs.readdir(path.dirname(files[0]))).toHaveLength(users.length);
  });

  it("never yields a dot segment for an agent id or user made of dots", () => {
    for (const key of [".", "..", "..."]) {
      const file = memoryFilePath(root, key, key);
      expect(path.relative(root, file).split(path.sep)).not.toContain("..");
      expect(path.relative(root, file).split(path.sep)).not.toContain(".");
      expect(file.startsWith(root + path.sep)).toBe(true);
    }
  });

  it("keeps every note under twenty concurrent appends", async () => {
    const file = memoryFilePath(root, "sales", "dana.whitfield@northwind.example");
    await Promise.all(Array.from({ length: 20 }, (_, i) => appendMemory(file, `note ${i}`, { maxBytes: 16384 })));
    const lines = (await readMemory(file)).split("\n").filter(Boolean);
    expect(lines).toHaveLength(20);
    expect(await fs.readdir(path.dirname(file))).toEqual([path.basename(file)]);
  });

  it("stays at or under the cap and drops the oldest first", async () => {
    const file = memoryFilePath(root, "sales", "dana.whitfield@northwind.example");
    const maxBytes = 16 * 1024;
    const note = "x".repeat(900);
    for (let i = 0; i < 40; i += 1) {
      await appendMemory(file, `${i} ${note}`, { maxBytes });
    }
    const text = await readMemory(file);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(maxBytes);
    expect(text).toContain(": 39 x");
    expect(text).not.toContain(": 0 x");
    const stat = await fs.stat(file);
    expect(stat.size).toBeLessThanOrEqual(maxBytes);
  });

  it("refuses a single note larger than the cap instead of truncating it", async () => {
    const file = memoryFilePath(root, "sales", "dana.whitfield@northwind.example");
    await expect(appendMemory(file, "y".repeat(2000), { maxBytes: 1024 })).rejects.toThrow(/larger than the 1024 byte cap/);
    expect(await readMemory(file)).toBe("");
  });

  it("leaves no temp or lock files behind", async () => {
    const file = memoryFilePath(root, "sales", "dana.whitfield@northwind.example");
    await appendMemory(file, "one", { maxBytes: 16384 });
    await appendMemory(file, "two", { maxBytes: 16384 });
    const names = await fs.readdir(path.dirname(file));
    expect(names).toEqual([path.basename(file)]);
  });

  it("trimToCap drops from the front only", () => {
    const { lines, dropped } = trimToCap(["a".repeat(10), "b".repeat(10), "c".repeat(10)], 24);
    expect(lines).toEqual(["b".repeat(10), "c".repeat(10)]);
    expect(dropped).toBe(1);
  });
});
