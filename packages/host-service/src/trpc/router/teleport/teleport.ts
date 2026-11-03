import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { ChatRuntime } from "@superset/chat-runtime";
import { parseGitHubRemote } from "@superset/shared/github-remote";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createGitEnvResolver } from "../../../runtime/git";
import { uploadBundle, withStage } from "../../../teleport/bundle";
import { continueMovedChat } from "../../../teleport/continueMovedChat";
import { teleportProviderFor } from "../../../teleport/providers";
import { getHostWorkerPool } from "../../../workers/host-worker-pool";
import { gitPushSnapshotTask } from "../../../workers/tasks/git";
import { harnessSessionFileTask } from "../../../workers/tasks/harness";
import { machineOnlyProcedure, protectedProcedure, router } from "../../index";
import { rethrowEnvironmentalGitError } from "../git/utils/classify-git-error";
import { resolveWorktreePath } from "../git/utils/resolve-worktree";
import { requireChatRuntime } from "../sessions/session-service";
import { resolveDefaultAccountTerminalEnv } from "../usage/default-account";
import {
	requireLocalProject,
	requireProjectRepoPath,
} from "../workspace-creation/shared/local-project";

const execFileAsync = promisify(execFile);
const BUSY_STATUSES = new Set(["starting", "running", "awaiting_input"]);
const STOP_TIMEOUT_MS = 20_000;
const STOP_POLL_MS = 200;

function requireChat(
	chat: ChatRuntime,
	workspaceId: string,
	sessionId: string,
) {
	const { session } = chat.commands.getSession({ sessionId });
	if (!session || session.scopeId !== workspaceId) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "This chat is not in this workspace",
		});
	}
	return session;
}

/** Cancels the running turn and waits until the chat is idle. */
async function stopRunningTurn(chat: ChatRuntime, sessionId: string) {
	const outline = chat.commands.getOutline({ sessionId });
	const running = outline.ok
		? outline.outline.turns.find((turn) => turn.status === "running")
		: undefined;
	if (running) {
		chat.commands.cancelTurn({
			commandId: randomUUID(),
			sessionId,
			turnId: running.id,
		});
	}
	const deadline = Date.now() + STOP_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const status = chat.commands.getSession({ sessionId }).session?.status;
		if (!status || !BUSY_STATUSES.has(status)) return;
		await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS));
	}
	throw new TRPCError({
		code: "TIMEOUT",
		message: "The agent did not stop in time; try again",
	});
}

export const teleportRouter = router({
	/**
	 * Gets a chat ready to continue on another host: the worktree, uncommitted
	 * work included, goes to a new branch, and the chat's history and its
	 * agent's session files to the cloud. The caller starts the other side
	 * from all three.
	 */
	prepare: protectedProcedure
		.meta({ timeoutMs: 180_000 })
		.input(
			z.object({
				workspaceId: z.string(),
				chatSessionId: z.string().uuid(),
				stopIfBusy: z.boolean().optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const chat = requireChatRuntime(ctx);
			const session = requireChat(chat, input.workspaceId, input.chatSessionId);
			const provider = teleportProviderFor(session.harness);
			const harnessSessionId = session.harnessSessionId;
			if (!provider || !harnessSessionId) {
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message: "This chat's agent cannot move yet",
				});
			}
			if (BUSY_STATUSES.has(session.status)) {
				if (!input.stopIfBusy) {
					throw new TRPCError({
						code: "PRECONDITION_FAILED",
						message: "Wait for the agent to finish, or stop it, before moving",
					});
				}
				await stopRunningTurn(chat, input.chatSessionId);
			}
			const chatSync = ctx.runtime.chatSync;
			if (!chatSync) {
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message: "Chat sync is not available on this host",
				});
			}

			const worktreePath = resolveWorktreePath(ctx, input.workspaceId);
			const env = resolveDefaultAccountTerminalEnv(ctx.db);
			const pool = getHostWorkerPool();

			const branch = `superset/teleport-${randomUUID().slice(0, 8)}`;
			const gitEnv = await createGitEnvResolver(ctx.credentials)(worktreePath);
			const { remoteUrl } = await pool
				.run(
					gitPushSnapshotTask,
					{ worktreePath, branch, gitEnv },
					{ timeoutMs: 150_000 },
				)
				.catch((error: unknown) => {
					rethrowEnvironmentalGitError(error);
					throw error;
				});
			const repository = parseGitHubRemote(remoteUrl);
			if (!repository) {
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message: "Moving a chat needs a GitHub repository",
				});
			}

			await chatSync.syncSession(input.chatSessionId);
			await withStage(async (stageDir) => {
				const manifest = await provider.collect({
					harnessSessionId,
					worktreePath,
					env,
					stageDir,
					locate: () =>
						pool.run(harnessSessionFileTask, {
							ref: {
								agentId: "claude",
								sessionId: harnessSessionId,
								worktreePath,
								env,
							},
						}),
				});
				await uploadBundle({
					api: ctx.api,
					chatSessionId: input.chatSessionId,
					harness: session.harness,
					manifest,
					stageDir,
				});
			});

			return {
				branch,
				repositoryFullName: `${repository.owner}/${repository.name}`,
				harnessSessionId,
				title: session.title,
			};
		}),

	/** Stops the copy left behind and says in it where the chat went. */
	markMoved: protectedProcedure
		.input(
			z.object({
				workspaceId: z.string(),
				chatSessionId: z.string().uuid(),
				destination: z.enum(["cloud", "computer"]),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const chat = requireChatRuntime(ctx);
			requireChat(chat, input.workspaceId, input.chatSessionId);
			if (chat.live.get(input.chatSessionId)) {
				await chat.commands.closeSession({ sessionId: input.chatSessionId });
			}
			chat.journal.append(input.chatSessionId, {
				type: "item",
				turnId: `moved-${randomUUID()}`,
				item: {
					id: `moved-${randomUUID()}`,
					kind: "notice",
					noticeKind: "info",
					text:
						input.destination === "cloud"
							? "This chat moved to a cloud workspace and continues there."
							: "This chat moved to a computer and continues there.",
					startedAtMs: Date.now(),
				},
			});
			return { ok: true };
		}),

	/** Makes a branch another host pushed available to create a worktree from. */
	fetchBranch: machineOnlyProcedure
		.meta({ timeoutMs: 120_000 })
		.input(z.object({ projectId: z.string(), branch: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			const repoPath = requireProjectRepoPath(
				requireLocalProject(ctx, input.projectId),
			);
			const gitEnv = await createGitEnvResolver(ctx.credentials)(repoPath);
			await execFileAsync(
				"git",
				[
					"-C",
					repoPath,
					"fetch",
					"origin",
					`+refs/heads/${input.branch}:refs/remotes/origin/${input.branch}`,
				],
				{ env: { ...process.env, ...gitEnv } },
			).catch((error: unknown) => {
				rethrowEnvironmentalGitError(error);
				throw error;
			});
			return { branch: input.branch };
		}),

	/**
	 * Continues a chat from a cloud workspace in a workspace on this computer:
	 * the chat moves here, and its history and session files replace this
	 * host's copy.
	 */
	receive: machineOnlyProcedure
		.meta({ timeoutMs: 180_000 })
		.input(
			z.object({
				workspaceId: z.string(),
				chatSessionId: z.string().uuid(),
				harnessSessionId: z.string().min(1),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const worktreePath = resolveWorktreePath(ctx, input.workspaceId);
			await ctx.api.chatHistory.moveTo.mutate({
				sessionId: input.chatSessionId,
				workspaceId: input.workspaceId,
			});
			return continueMovedChat(ctx, {
				workspaceId: input.workspaceId,
				worktreePath,
				chatSessionId: input.chatSessionId,
				harnessSessionId: input.harnessSessionId,
			});
		}),
});
