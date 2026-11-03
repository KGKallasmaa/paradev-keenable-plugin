import type { DurableEvent } from "@superset/chat/protocol";
import { resolveDefaultAccountTerminalEnv } from "../../trpc/router/usage/default-account";
import type { HostServiceContext } from "../../types";
import { downloadBundle, withStage } from "../bundle";
import { teleportProviderFor } from "../providers";

type MoveContext = Pick<HostServiceContext, "api" | "db" | "runtime">;

/**
 * Continues a chat moved from another host under its own id: its history
 * replaces whatever this host had of it, its agent's session files go where
 * the agent looks, and the agent resumes without replaying the history.
 */
export async function continueMovedChat(
	ctx: MoveContext,
	target: {
		workspaceId: string;
		worktreePath: string;
		chatSessionId: string;
		harnessSessionId: string;
	},
): Promise<{ sessionId: string; terminalId: string }> {
	const chat = ctx.runtime.chat?.();
	if (!chat) throw new Error("Chat is not available on this host");
	const history = await pullChatHistory(ctx, target.chatSessionId);
	const provider = teleportProviderFor(history.session.harness ?? "");
	if (!provider || !history.session.epoch) {
		throw new Error("This host cannot resume the moved chat's agent");
	}
	await withStage(async (stageDir) => {
		const manifest = await downloadBundle({
			api: ctx.api,
			chatSessionId: target.chatSessionId,
			stageDir,
		});
		if (!manifest) throw new Error("The moved chat has no session files");
		await provider.place({
			manifest,
			worktreePath: target.worktreePath,
			env: resolveDefaultAccountTerminalEnv(ctx.db),
			stageDir,
		});
	});
	if (chat.live.get(target.chatSessionId)) {
		await chat.commands.closeSession({ sessionId: target.chatSessionId });
	}
	chat.journal.importSession({
		session: {
			sessionId: target.chatSessionId,
			scopeId: target.workspaceId,
			harness: history.session.harness ?? "",
			harnessSessionId: target.harnessSessionId,
			title: history.session.title ?? undefined,
			status: "idle",
			epoch: history.session.epoch,
			lastSeq: history.session.lastSeq,
		},
		events: history.events,
		replace: true,
	});
	ctx.runtime.chatSync?.markPushed(
		target.chatSessionId,
		history.session.epoch,
		history.session.lastSeq,
	);
	chat.commands.continueSession({
		sessionId: target.chatSessionId,
		cwd: target.worktreePath,
		harnessSessionId: target.harnessSessionId,
		terminalId: target.chatSessionId,
	});
	return {
		sessionId: target.chatSessionId,
		terminalId:
			chat.live.get(target.chatSessionId)?.terminalId ?? target.chatSessionId,
	};
}

async function pullChatHistory(ctx: MoveContext, sessionId: string) {
	const events: { seq: number; event: DurableEvent }[] = [];
	let afterFirstSeq = 0;
	for (;;) {
		const page = await ctx.api.chatHistory.pull.mutate({
			sessionId,
			afterFirstSeq,
		});
		events.push(
			...page.events.map((row) => ({ seq: row.firstSeq, event: row.event })),
		);
		if (page.nextAfterFirstSeq === null) {
			return { session: page.session, events };
		}
		afterFirstSeq = page.nextAfterFirstSeq;
	}
}
