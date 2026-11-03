import type { DurableEvent, Item, Turn } from "@superset/chat/protocol";
import { db, dbWs } from "@superset/db/client";
import {
	chatItems,
	chatSessions,
	chatTranscripts,
	chatTurns,
	files,
} from "@superset/db/schema";
import { fileOriginalKey } from "@superset/shared/usercontent";
import type { TRPCRouterRecord } from "@trpc/server";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { anchorAttachments } from "../../lib/attachments";
import { presignedGetUrl, presignedPutUrl } from "../../lib/r2";
import { protectedProcedure, userError } from "../../trpc";
import { requireActiveOrgMembership } from "../utils/active-org";
import {
	createTranscriptUploadInputSchema,
	pullInputSchema,
	pushInputSchema,
	searchInputSchema,
	sessionInputSchema,
	transcriptInputSchema,
} from "./schema";
import {
	assertBoxWorkspace,
	type ChatHistoryCaller,
	canAccess,
	loadAccessibleSession,
} from "./utils/access";
import { foldEvents } from "./utils/foldEvents";
import { searchChats } from "./utils/searchChats";

type ProtectedCtx = Parameters<typeof requireActiveOrgMembership>[0] & {
	sandboxCaller: ChatHistoryCaller["sandbox"];
};

async function callerOf(ctx: ProtectedCtx): Promise<ChatHistoryCaller> {
	return {
		userId: ctx.session.user.id,
		organizationId: await requireActiveOrgMembership(ctx),
		sandbox: ctx.sandboxCaller,
	};
}

function movedAway(): TRPCError {
	return new TRPCError({
		code: "CONFLICT",
		message: "This chat moved to another workspace",
	});
}

/**
 * Chats kept off the machine they run on: the latest state of each item and
 * turn, and the agent's own session files. A host pushes as it goes; a chat
 * that moves is pulled into the new host's journal, and its session bundle
 * is placed where the agent looks for it.
 */
export const chatHistoryRouter = {
	push: protectedProcedure
		.input(pushInputSchema)
		.mutation(async ({ ctx, input }) => {
			const caller = await callerOf(ctx);
			assertBoxWorkspace(caller, input.workspaceId);
			const folded = foldEvents(input.events);
			const sessionState = folded.session?.state;

			await dbWs.transaction(async (tx) => {
				const [existing] = await tx
					.select()
					.from(chatSessions)
					.where(eq(chatSessions.id, input.sessionId))
					.for("update");

				if (!existing) {
					await tx.insert(chatSessions).values({
						id: input.sessionId,
						organizationId: caller.organizationId,
						createdBy: caller.userId,
						v2WorkspaceId: input.workspaceId,
						harness: input.harness,
						harnessSessionId: input.harnessSessionId,
						epoch: input.epoch,
						lastSeq: 0,
					});
				} else {
					if (!canAccess(caller, existing)) {
						throw userError({
							code: "NOT_FOUND",
							message: "Chat session not found",
							i18nKey: "serverError.chat.chatSessionNotFound",
						});
					}
					if (existing.v2WorkspaceId !== input.workspaceId) throw movedAway();
					if (existing.epoch !== input.epoch) {
						await tx
							.delete(chatItems)
							.where(eq(chatItems.sessionId, input.sessionId));
						await tx
							.delete(chatTurns)
							.where(eq(chatTurns.sessionId, input.sessionId));
					}
				}

				if (folded.items.length > 0) {
					await tx
						.insert(chatItems)
						.values(
							folded.items.map((item) => ({
								sessionId: input.sessionId,
								organizationId: existing?.organizationId ?? caller.organizationId,
								createdBy: existing?.createdBy ?? caller.userId,
								epoch: input.epoch,
								...item,
							})),
						)
						.onConflictDoUpdate({
							target: [chatItems.sessionId, chatItems.itemId],
							set: newerWins(chatItems, [
								"turn_id",
								"kind",
								"started_at",
								"body",
								"search_text",
							]),
						});
				}

				if (folded.turns.length > 0) {
					await tx
						.insert(chatTurns)
						.values(
							folded.turns.map((turn) => ({
								sessionId: input.sessionId,
								epoch: input.epoch,
								...turn,
							})),
						)
						.onConflictDoUpdate({
							target: [chatTurns.sessionId, chatTurns.turnId],
							set: newerWins(chatTurns, [
								"status",
								"started_at",
								"completed_at",
								"usage",
								"body",
							]),
						});
				}

				const sameEpoch = existing?.epoch === input.epoch;
				await tx
					.update(chatSessions)
					.set({
						harness: input.harness,
						harnessSessionId:
							sessionState?.harnessSessionId ??
							input.harnessSessionId ??
							(sameEpoch ? existing?.harnessSessionId : null),
						epoch: input.epoch,
						lastSeq: sameEpoch
							? sql`greatest(coalesce(${chatSessions.lastSeq}, 0), ${folded.lastSeq})`
							: folded.lastSeq,
						...(sessionState
							? {
									status: sessionState.status,
									...(sessionState.title ? { title: sessionState.title } : {}),
								}
							: {}),
						lastActiveAt: new Date(),
					})
					.where(eq(chatSessions.id, input.sessionId));
			});

			return { ackedSeq: folded.lastSeq };
		}),

	/** The chat in the order it shows: each item and turn where it first appeared. */
	pull: protectedProcedure
		.input(pullInputSchema)
		.mutation(async ({ ctx, input }) => {
			const session = await loadAccessibleSession(
				await callerOf(ctx),
				input.sessionId,
			);
			const [items, turns] = await Promise.all([
				db
					.select({
						firstSeq: chatItems.firstSeq,
						seq: chatItems.seq,
						turnId: chatItems.turnId,
						body: chatItems.body,
					})
					.from(chatItems)
					.where(
						and(
							eq(chatItems.sessionId, input.sessionId),
							gt(chatItems.firstSeq, input.afterFirstSeq),
						),
					)
					.orderBy(asc(chatItems.firstSeq))
					.limit(input.limit + 1),
				db
					.select({
						firstSeq: chatTurns.firstSeq,
						seq: chatTurns.seq,
						body: chatTurns.body,
					})
					.from(chatTurns)
					.where(
						and(
							eq(chatTurns.sessionId, input.sessionId),
							gt(chatTurns.firstSeq, input.afterFirstSeq),
						),
					)
					.orderBy(asc(chatTurns.firstSeq))
					.limit(input.limit + 1),
			]);

			const merged: { firstSeq: number; seq: number; event: DurableEvent }[] = [
				...items.map((row) => ({
					firstSeq: row.firstSeq,
					seq: row.seq,
					event: {
						type: "item" as const,
						item: row.body as Item,
						turnId: row.turnId,
					},
				})),
				...turns.map((row) => ({
					firstSeq: row.firstSeq,
					seq: row.seq,
					event: { type: "turn" as const, turn: row.body as Turn },
				})),
			].sort((a, b) => a.firstSeq - b.firstSeq);
			const events = merged.slice(0, input.limit);
			const last = events.at(-1);

			return {
				session: {
					id: session.id,
					epoch: session.epoch,
					lastSeq: session.lastSeq ?? 0,
					harness: session.harness,
					harnessSessionId: session.harnessSessionId,
					status: session.status,
					title: session.title,
				},
				events,
				nextAfterFirstSeq:
					merged.length > input.limit && last ? last.firstSeq : null,
			};
		}),

	createTranscriptUpload: protectedProcedure
		.input(createTranscriptUploadInputSchema)
		.mutation(async ({ ctx, input }) => {
			const caller = await callerOf(ctx);
			const session = await loadAccessibleSession(caller, input.sessionId);

			const { transcriptId, fileId } = await dbWs.transaction(async (tx) => {
				const [file] = await tx
					.insert(files)
					.values({
						organizationId: session.organizationId,
						name: `${input.harnessSessionId}.tar.gz`,
						contentType: "application/gzip",
						sizeBytes: input.sizeBytes,
						sha256: input.sha256,
						createdByUserId: caller.userId,
					})
					.returning({ id: files.id });
				if (!file) throw new Error("Failed to record the transcript file");
				const [transcript] = await tx
					.insert(chatTranscripts)
					.values({
						sessionId: session.id,
						organizationId: session.organizationId,
						fileId: file.id,
						harness: input.harness,
						harnessSessionId: input.harnessSessionId,
						sourceCwd: input.sourceCwd,
						byteLength: input.sizeBytes,
						sha256: input.sha256,
					})
					.returning({ id: chatTranscripts.id });
				if (!transcript) throw new Error("Failed to record the transcript");
				return { transcriptId: transcript.id, fileId: file.id };
			});

			const upload = await presignedPutUrl({
				key: fileOriginalKey(fileId),
				contentType: "application/gzip",
				contentLength: input.sizeBytes,
				expiresInSeconds: 60 * 60,
			});
			return { transcriptId, upload };
		}),

	/** Keeps an uploaded bundle: without this the file sweep reclaims it a day later. */
	completeTranscriptUpload: protectedProcedure
		.input(transcriptInputSchema)
		.mutation(async ({ ctx, input }) => {
			const caller = await callerOf(ctx);
			const transcript = await loadTranscript(input.transcriptId);
			await loadAccessibleSession(caller, transcript.sessionId);

			await anchorAttachments({
				parentKind: "chat_session",
				parentId: transcript.sessionId,
				organizationId: transcript.organizationId,
				fileIds: [transcript.fileId],
			});
			const file = await db.query.files.findFirst({
				where: eq(files.id, transcript.fileId),
				columns: { status: true },
			});
			if (file?.status !== "ready") {
				throw userError({
					code: "BAD_REQUEST",
					message: "Attachment was not uploaded — send the bytes first",
					i18nKey: "serverError.attachment.notUploaded",
				});
			}
			return { transcriptId: transcript.id };
		}),

	/** The newest kept session bundle of a chat, or null when it has none. */
	resolveTranscript: protectedProcedure
		.input(sessionInputSchema)
		.mutation(async ({ ctx, input }) => {
			await loadAccessibleSession(await callerOf(ctx), input.sessionId);
			const [newest] = await db
				.select({
					id: chatTranscripts.id,
					fileId: chatTranscripts.fileId,
					harness: chatTranscripts.harness,
					harnessSessionId: chatTranscripts.harnessSessionId,
					sourceCwd: chatTranscripts.sourceCwd,
					byteLength: chatTranscripts.byteLength,
					sha256: chatTranscripts.sha256,
					createdAt: chatTranscripts.createdAt,
				})
				.from(chatTranscripts)
				.innerJoin(files, eq(files.id, chatTranscripts.fileId))
				.where(
					and(
						eq(chatTranscripts.sessionId, input.sessionId),
						eq(files.status, "ready"),
					),
				)
				.orderBy(desc(chatTranscripts.createdAt))
				.limit(1);
			if (!newest) return null;
			const { fileId, ...transcript } = newest;
			return {
				...transcript,
				url: await presignedGetUrl(fileOriginalKey(fileId), 60 * 60),
			};
		}),

	search: protectedProcedure
		.input(searchInputSchema)
		.query(async ({ ctx, input }) => {
			const caller = await callerOf(ctx);
			return searchChats({
				query: input.query,
				userId: caller.userId,
				organizationId: caller.organizationId,
				limit: input.limit,
			});
		}),
} satisfies TRPCRouterRecord;

async function loadTranscript(transcriptId: string) {
	const transcript = await db.query.chatTranscripts.findFirst({
		where: eq(chatTranscripts.id, transcriptId),
	});
	if (!transcript) {
		throw userError({
			code: "NOT_FOUND",
			message: "Chat session not found",
			i18nKey: "serverError.chat.chatSessionNotFound",
		});
	}
	return transcript;
}

/**
 * An upsert where the newest version of a row wins, whatever order retries
 * arrive in. `first_seq` keeps the earliest seen.
 */
function newerWins(
	table: typeof chatItems | typeof chatTurns,
	columns: string[],
) {
	const newer = sql`excluded.seq > ${table.seq}`;
	const set: Record<string, ReturnType<typeof sql>> = {
		seq: sql`greatest(${table.seq}, excluded.seq)`,
		firstSeq: sql`least(${table.firstSeq}, excluded.first_seq)`,
		updatedAt: sql`now()`,
	};
	for (const column of columns) {
		const name = sql.identifier(column);
		set[toCamel(column)] =
			sql`case when ${newer} then excluded.${name} else ${table}.${name} end`;
	}
	return set;
}

function toCamel(column: string): string {
	return column.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}
