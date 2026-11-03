import { randomUUID } from "node:crypto";
import { parseGitHubRemote } from "@superset/shared/github-remote";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createGitEnvResolver } from "../../../runtime/git";
import { uploadBundle, withStage } from "../../../teleport/bundle";
import { teleportProviderFor } from "../../../teleport/providers";
import { getHostWorkerPool } from "../../../workers/host-worker-pool";
import { gitPushSnapshotTask } from "../../../workers/tasks/git";
import { harnessSessionFileTask } from "../../../workers/tasks/harness";
import { protectedProcedure, router } from "../../index";
import { rethrowEnvironmentalGitError } from "../git/utils/classify-git-error";
import { resolveWorktreePath } from "../git/utils/resolve-worktree";
import { requireChatRuntime } from "../sessions/session-service";
import { resolveDefaultAccountTerminalEnv } from "../usage/default-account";

const BUSY_STATUSES = new Set(["starting", "running", "awaiting_input"]);

export const teleportRouter = router({
	/**
	 * Gets a chat ready to continue in a cloud workspace: its history and its
	 * agent's session files go to the cloud, and the worktree, uncommitted
	 * work included, to a new branch. The client creates the cloud workspace
	 * from both.
	 */
	prepare: protectedProcedure
		.meta({ timeoutMs: 180_000 })
		.input(
			z.object({
				workspaceId: z.string(),
				chatSessionId: z.string().uuid(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const chat = requireChatRuntime(ctx);
			const { session } = chat.commands.getSession({
				sessionId: input.chatSessionId,
			});
			if (!session || session.scopeId !== input.workspaceId) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "This chat is not in this workspace",
				});
			}
			const provider = teleportProviderFor(session.harness);
			const harnessSessionId = session.harnessSessionId;
			if (!provider || !harnessSessionId) {
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message: "This chat's agent cannot move to the cloud yet",
				});
			}
			if (BUSY_STATUSES.has(session.status)) {
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message: "Wait for the agent to finish, or stop it, before moving",
				});
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
					message: "Cloud workspaces need a GitHub repository",
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
			};
		}),
});
