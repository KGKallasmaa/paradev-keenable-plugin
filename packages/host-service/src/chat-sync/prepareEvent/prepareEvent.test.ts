import { describe, expect, test } from "bun:test";
import type { DurableEvent } from "@superset/chat/protocol";
import { prepareEventForCloud } from "./prepareEvent";

describe("prepareEventForCloud", () => {
	test("cuts long tool output and drops the session's command list", () => {
		const tool = prepareEventForCloud({
			type: "item",
			turnId: "t",
			item: {
				id: "x",
				kind: "tool_call",
				title: "cat big.log",
				toolKind: "read",
				toolName: "Read",
				status: "completed",
				content: [],
				rawOutput: "a".repeat(200_000),
				startedAtMs: 0,
			},
		} as DurableEvent);
		expect(JSON.stringify(tool).length).toBeLessThan(70_000);

		const session = prepareEventForCloud({
			type: "session",
			session: {
				status: "idle",
				harness: "claude-acp",
				availableCommands: [{ name: "init", description: "" }],
			},
		} as DurableEvent);
		expect(session).toEqual({
			type: "session",
			session: { status: "idle", harness: "claude-acp" },
		} as DurableEvent);
	});
});
