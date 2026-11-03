import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { MAX_ATTACHMENT_BYTES } from "@superset/shared/attachment-limits";
import { TRPCError } from "@trpc/server";
import { downloadAttachment } from "../../trpc/router/attachments/download";
import type { ApiClient } from "../../types";
import type { BundleManifest } from "../providers";

const execFileAsync = promisify(execFile);
const MANIFEST = "manifest.json";

/** A scratch directory removed once `run` settles. */
export async function withStage<T>(
	run: (stageDir: string) => Promise<T>,
): Promise<T> {
	const stageDir = await mkdtemp(join(tmpdir(), "superset-teleport-"));
	try {
		return await run(stageDir);
	} finally {
		await rm(stageDir, { recursive: true, force: true });
	}
}

/** Packs a staged session and uploads it as the chat's newest bundle. */
export async function uploadBundle(args: {
	api: ApiClient;
	chatSessionId: string;
	harness: string;
	manifest: BundleManifest;
	stageDir: string;
}): Promise<string> {
	await writeFile(
		join(args.stageDir, MANIFEST),
		JSON.stringify(args.manifest),
	);
	const archive = `${args.stageDir}.tar.gz`;
	try {
		await execFileAsync("tar", ["-czf", archive, "-C", args.stageDir, "."]);
		const { size } = await stat(archive);
		if (size > MAX_ATTACHMENT_BYTES) {
			throw new TRPCError({
				code: "PAYLOAD_TOO_LARGE",
				message: "This conversation is too large to move to the cloud",
			});
		}
		const bytes = await readFile(archive);
		const { transcriptId, upload } =
			await args.api.chatHistory.createTranscriptUpload.mutate({
				sessionId: args.chatSessionId,
				harness: args.harness,
				harnessSessionId: args.manifest.harnessSessionId,
				sourceCwd: args.manifest.sourceCwd,
				sizeBytes: size,
				sha256: createHash("sha256").update(bytes).digest("hex"),
			});
		const response = await fetch(upload.url, {
			method: "PUT",
			headers: upload.headers,
			body: bytes,
		});
		if (!response.ok) {
			throw new TRPCError({
				code: "BAD_GATEWAY",
				message: `Could not upload the conversation (${response.status})`,
			});
		}
		await args.api.chatHistory.completeTranscriptUpload.mutate({
			transcriptId,
		});
		return transcriptId;
	} finally {
		await rm(archive, { force: true });
	}
}

/** Downloads a chat's newest bundle into `stageDir`, or returns null when it has none. */
export async function downloadBundle(args: {
	api: ApiClient;
	chatSessionId: string;
	stageDir: string;
}): Promise<BundleManifest | null> {
	const bundle = await args.api.chatHistory.resolveTranscript.mutate({
		sessionId: args.chatSessionId,
	});
	if (!bundle) return null;
	const archive = `${args.stageDir}.tar.gz`;
	try {
		await downloadAttachment(
			{
				fileId: bundle.id,
				name: `${bundle.harnessSessionId}.tar.gz`,
				contentType: "application/gzip",
				sizeBytes: bundle.byteLength,
				url: bundle.url,
			},
			archive,
		);
		const bytes = await readFile(archive);
		if (createHash("sha256").update(bytes).digest("hex") !== bundle.sha256) {
			throw new Error("The downloaded session bundle is damaged");
		}
		await execFileAsync("tar", ["-xzf", archive, "-C", args.stageDir]);
		return JSON.parse(
			await readFile(join(args.stageDir, MANIFEST), "utf8"),
		) as BundleManifest;
	} finally {
		await rm(archive, { force: true });
	}
}
