import type { DurableEnvelope } from "@superset/chat/protocol";
import {
	type ChatDb,
	type ChatRuntime,
	chatJournal,
	chatSyncState,
	readSessionRow,
} from "@superset/chat-runtime";
import { and, asc, eq, gt } from "drizzle-orm";
import type { ApiClient } from "../types";
import { prepareEventForCloud } from "./prepareEvent";

const SETTLE_MS = 1_000;
const MIN_RETRY_MS = 5_000;
const MAX_RETRY_MS = 5 * 60 * 1000;
const BATCH_EVENTS = 500;
const BATCH_CHARS = 1024 * 1024;

export type ChatSync = {
	/** Pushes everything not yet pushed for one chat, and resolves once it is acked. */
	syncSession(sessionId: string): Promise<void>;
	/** Records an append; a running sync pushes it soon after. */
	noteAppend(envelope: DurableEnvelope): void;
	/** Keeps pushing every chat that changes, retrying with backoff. */
	start(): () => void;
	/** Marks a chat as already pushed up to `seq`, as after an import. */
	markPushed(sessionId: string, epoch: string, seq: number): void;
};

type Schedule = (run: () => void, ms: number) => () => void;

const defaultSchedule: Schedule = (run, ms) => {
	const timer = setTimeout(run, ms);
	timer.unref?.();
	return () => clearTimeout(timer);
};

function readPushed(db: ChatDb, sessionId: string, epoch: string): number {
	const row = db
		.select()
		.from(chatSyncState)
		.where(eq(chatSyncState.sessionId, sessionId))
		.get();
	return row && row.epoch === epoch ? row.pushedSeq : 0;
}

function writePushed(
	db: ChatDb,
	sessionId: string,
	epoch: string,
	seq: number,
): void {
	const updatedAt = Date.now();
	db.insert(chatSyncState)
		.values({ sessionId, epoch, pushedSeq: seq, updatedAt })
		.onConflictDoUpdate({
			target: chatSyncState.sessionId,
			set: { epoch, pushedSeq: seq, updatedAt },
		})
		.run();
}

function isMovedAway(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"data" in error &&
		(error as { data?: { code?: string } }).data?.code === "CONFLICT"
	);
}

export function createChatSync(args: {
	runtime: () => ChatRuntime;
	api: ApiClient;
	schedule?: Schedule;
}): ChatSync {
	const schedule = args.schedule ?? defaultSchedule;
	const dirty = new Set<string>();
	const moved = new Set<string>();
	const inFlight = new Map<string, Promise<void>>();
	let running = false;
	let cancelTimer: (() => void) | null = null;
	let retryMs = MIN_RETRY_MS;

	const pushOnce = async (sessionId: string) => {
		const { db } = args.runtime();
		for (;;) {
			const session = readSessionRow(db, sessionId);
			if (!session) return;
			const pushed = readPushed(db, sessionId, session.epoch);
			const rows = db
				.select()
				.from(chatJournal)
				.where(
					and(
						eq(chatJournal.sessionId, sessionId),
						eq(chatJournal.epoch, session.epoch),
						gt(chatJournal.seq, pushed),
					),
				)
				.orderBy(asc(chatJournal.seq))
				.limit(BATCH_EVENTS)
				.all();
			if (rows.length === 0) return;

			const events = [];
			let chars = 0;
			for (const row of rows) {
				const event = prepareEventForCloud(JSON.parse(row.eventJson));
				chars += JSON.stringify(event).length;
				if (events.length > 0 && chars > BATCH_CHARS) break;
				events.push({ seq: row.seq, ts: row.ts, event });
			}

			const { ackedSeq } = await args.api.chatHistory.push.mutate({
				sessionId,
				workspaceId: session.scopeId,
				harness: session.harness,
				harnessSessionId: session.harnessSessionId ?? undefined,
				epoch: session.epoch,
				events,
			});
			writePushed(db, sessionId, session.epoch, ackedSeq);
		}
	};

	const syncSession = (sessionId: string): Promise<void> => {
		const current = inFlight.get(sessionId);
		if (current) {
			return current.catch(() => {}).then(() => syncSession(sessionId));
		}
		const run = pushOnce(sessionId).finally(() => inFlight.delete(sessionId));
		inFlight.set(sessionId, run);
		return run;
	};

	let started = false;

	const drain = async () => {
		cancelTimer = null;
		if (running) return;
		running = true;
		let failed = false;
		for (const sessionId of [...dirty]) {
			dirty.delete(sessionId);
			if (moved.has(sessionId)) continue;
			try {
				await syncSession(sessionId);
			} catch (error) {
				if (isMovedAway(error)) {
					moved.add(sessionId);
					continue;
				}
				dirty.add(sessionId);
				failed = true;
				console.warn(
					"[chat-sync] push failed:",
					error instanceof Error ? error.message : error,
				);
			}
		}
		running = false;
		if (failed) {
			wake(retryMs);
			retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
		} else {
			retryMs = MIN_RETRY_MS;
			if (dirty.size > 0) wake(SETTLE_MS);
		}
	};

	const wake = (ms: number) => {
		if (!started || cancelTimer) return;
		cancelTimer = schedule(() => void drain(), ms);
	};

	return {
		syncSession,
		noteAppend(envelope) {
			if (!started) return;
			dirty.add(envelope.sessionId);
			const turnEnded =
				envelope.event.type === "turn" &&
				envelope.event.turn.status !== "running";
			if (turnEnded && cancelTimer) {
				cancelTimer();
				cancelTimer = null;
			}
			wake(turnEnded ? 0 : SETTLE_MS);
		},
		markPushed(sessionId, epoch, seq) {
			writePushed(args.runtime().db, sessionId, epoch, seq);
		},
		start() {
			started = true;
			return () => {
				started = false;
				cancelTimer?.();
				cancelTimer = null;
			};
		},
	};
}
