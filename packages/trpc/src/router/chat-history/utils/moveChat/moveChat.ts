import { db } from "@superset/db/client";
import { chatSessions, chatTranscripts, files } from "@superset/db/schema";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";

/** A chat can move once its history and its agent's session bundle are stored. */
export async function assertChatCanMove(args: {
	chatSessionId: string;
	harnessSessionId: string;
	organizationId: string;
	userId: string;
}): Promise<void> {
	const session = await db.query.chatSessions.findFirst({
		where: and(
			eq(chatSessions.id, args.chatSessionId),
			eq(chatSessions.organizationId, args.organizationId),
			eq(chatSessions.createdBy, args.userId),
		),
		columns: { id: true },
	});
	if (!session) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "The chat to move was not synced first",
		});
	}
	const [bundle] = await db
		.select({ id: chatTranscripts.id })
		.from(chatTranscripts)
		.innerJoin(files, eq(files.id, chatTranscripts.fileId))
		.where(
			and(
				eq(chatTranscripts.sessionId, args.chatSessionId),
				eq(chatTranscripts.harnessSessionId, args.harnessSessionId),
				eq(files.status, "ready"),
			),
		)
		.limit(1);
	if (!bundle) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: "The chat's session files were not uploaded first",
		});
	}
}

/** From here on only the new workspace may write the chat. */
export async function moveChat(chatSessionId: string, workspaceId: string) {
	await db
		.update(chatSessions)
		.set({ v2WorkspaceId: workspaceId, lastActiveAt: new Date() })
		.where(eq(chatSessions.id, chatSessionId));
}
