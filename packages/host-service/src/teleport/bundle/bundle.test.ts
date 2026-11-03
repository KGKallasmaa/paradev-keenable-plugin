import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { gunzipBounded } from "./bundle";

describe("gunzipBounded", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "teleport-bundle-"));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	test("unzips within the bound and fails past it", async () => {
		const archive = join(root, "a.gz");
		writeFileSync(archive, gzipSync(Buffer.alloc(10_000)));

		await gunzipBounded(archive, join(root, "ok.tar"), 10_000);
		expect(readFileSync(join(root, "ok.tar")).length).toBe(10_000);

		await expect(
			gunzipBounded(archive, join(root, "big.tar"), 1_000),
		).rejects.toThrow("too large");
	});
});
