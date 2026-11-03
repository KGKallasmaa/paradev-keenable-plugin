import type { DurableEvent, Item, Turn } from "@superset/chat/protocol";
import { db } from "@superset/db/client";
import {
	chatItems,
	chatTurns,
	type SelectChatSession,
} from "@superset/db/schema";
import { asc, eq } from "drizzle-orm";

/**
 * A stored chat as a journal to import: each item and turn at the seq where
 * it first appeared, which is the order the chat shows them in.
 */
export async function loadChatHistory(session: SelectChatSession): Promise<{
	events: { seq: number; event: DurableEvent }[];
	itemCount: number;
}> {
	const [items, turns] = await Promise.all([
		db
			.select({
				firstSeq: chatItems.firstSeq,
				turnId: chatItems.turnId,
				body: chatItems.body,
			})
			.from(chatItems)
			.where(eq(chatItems.sessionId, session.id))
			.orderBy(asc(chatItems.firstSeq)),
		db
			.select({ firstSeq: chatTurns.firstSeq, body: chatTurns.body })
			.from(chatTurns)
			.where(eq(chatTurns.sessionId, session.id))
			.orderBy(asc(chatTurns.firstSeq)),
	]);
	const events = [
		...items.map((row) => ({
			seq: row.firstSeq,
			event: {
				type: "item" as const,
				item: row.body as Item,
				turnId: row.turnId,
			},
		})),
		...turns.map((row) => ({
			seq: row.firstSeq,
			event: { type: "turn" as const, turn: row.body as Turn },
		})),
	].sort((a, b) => a.seq - b.seq);
	return { events, itemCount: items.length };
}
