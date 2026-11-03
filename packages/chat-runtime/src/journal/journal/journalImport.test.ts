import { beforeEach, describe, expect, test } from "bun:test";
import type { DurableEnvelope } from "@superset/chat/protocol";
import type { ChatRuntime } from "../../index";
import { readSince } from "../../replay";
import { agentMessage, toolCall, turn } from "../../testing/fixtures";
import { createTestRuntime } from "../../testing/testRuntime";
import type { ImportedSession } from "./journal";

const SESSION = "moved-session";
const EPOCH = "source-epoch";

/** A chat folded elsewhere: a tool call that finished after the reply that followed it. */
function moved(lastSeq = 9): ImportedSession {
	return {
		session: {
			sessionId: SESSION,
			scopeId: "cloud-workspace",
			harness: "claude-acp",
			harnessSessionId: "claude-session",
			title: "Fix the upload",
			epoch: EPOCH,
			lastSeq,
		},
		events: [
			{ seq: 1, event: { type: "turn", turn: turn("t1") } },
			{
				seq: 2,
				event: {
					type: "item",
					turnId: "t1",
					item: toolCall("tool", { status: "completed" }),
				},
			},
			{
				seq: 4,
				event: {
					type: "item",
					turnId: "t1",
					item: agentMessage("reply", "Done"),
				},
			},
		],
	};
}

describe("ChatJournal.importSession", () => {
	let runtime: ChatRuntime;

	beforeEach(() => {
		runtime = createTestRuntime();
	});

	test("keeps the source's order, epoch and head seq, and the next append follows it", () => {
		expect(runtime.journal.importSession(moved())).toBe(true);

		const outline = runtime.commands.getOutline({ sessionId: SESSION });
		expect(outline.ok && outline.outline.items.map((s) => s.item.id)).toEqual([
			"tool",
			"reply",
		]);
		expect(outline.ok && outline.outline.session?.title).toBe(
			"Fix the upload",
		);

		const atHead = readSince(runtime.db, SESSION, { epoch: EPOCH, seq: 9 });
		expect(atHead).toEqual({ ok: true, envelopes: [] });

		const opened = runtime.journal.open({
			sessionId: SESSION,
			scopeId: "cloud-workspace",
			harness: "claude-acp",
		});
		expect(opened.epoch).toBe(EPOCH);
		expect(
			runtime.journal.append(SESSION, {
				type: "turn",
				turn: turn("t2"),
			}),
		).toEqual({ epoch: EPOCH, seq: 10 });
	});

	test("does nothing when the session already has a journal", () => {
		runtime.journal.importSession(moved());
		expect(runtime.journal.importSession(moved(20))).toBe(false);
		expect(runtime.journal.cursor(SESSION)).toEqual({ epoch: EPOCH, seq: 9 });
	});
});

describe("ChatJournal onAppend", () => {
	test("reports each durable event once it is written", () => {
		const seen: DurableEnvelope[] = [];
		const runtime = createTestRuntime({
			onAppend: (envelope) => seen.push(envelope),
		});
		runtime.journal.open({
			sessionId: "s",
			scopeId: "w",
			harness: "fake",
		});
		runtime.journal.append("s", {
			type: "item",
			turnId: "t1",
			item: agentMessage("m", "hi"),
		});
		expect(seen.map((envelope) => envelope.cursor.seq)).toEqual([1]);
	});
});
