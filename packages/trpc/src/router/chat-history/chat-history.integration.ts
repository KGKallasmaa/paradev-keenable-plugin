import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DurableEvent } from "@superset/chat/protocol";

const { db } = await import("@superset/db/client");
const { chatSessions, members, organizations, users } = await import(
	"@superset/db/schema"
);
const { inArray } = await import("drizzle-orm");
const { chatHistoryRouter } = await import("./chat-history");
const { createCallerFactory, createTRPCContext, createTRPCRouter } =
	await import("../../trpc");

const ORG = crypto.randomUUID();
const USER = crypto.randomUUID();
const OTHER_USER = crypto.randomUUID();
const WORKSPACE = crypto.randomUUID();
const CLOUD_WORKSPACE = crypto.randomUUID();
const suffix = Date.now();
const sessions: string[] = [];

const createCaller = createCallerFactory(
	createTRPCRouter({ chatHistory: chatHistoryRouter }),
);

function callerFor(userId: string, box?: string) {
	return createCaller(
		createTRPCContext({
			session: {
				user: { id: userId, email: `u-${userId}@example.com` },
				session: { activeOrganizationId: ORG },
			} as never,
			auth: {} as never,
			headers: new Headers(),
			sandboxCaller: box
				? { workspaceId: box, organizationId: ORG, userId }
				: null,
		}),
	).chatHistory;
}

const owner = callerFor(USER);

function newSession(): string {
	const id = crypto.randomUUID();
	sessions.push(id);
	return id;
}

function agentMessage(id: string, text: string, startedAtMs = 1): DurableEvent {
	return {
		type: "item",
		turnId: "turn-1",
		item: { id, kind: "agent_message", text, startedAtMs },
	} as DurableEvent;
}

function toolCall(id: string, status: string, title: string): DurableEvent {
	return {
		type: "item",
		turnId: "turn-1",
		item: {
			id,
			kind: "tool_call",
			title,
			toolKind: "execute",
			toolName: "bash",
			status,
			content: [],
			startedAtMs: 1,
		},
	} as DurableEvent;
}

function push(
	sessionId: string,
	events: { seq: number; event: DurableEvent }[],
	options: { epoch?: string; workspaceId?: string; as?: typeof owner } = {},
) {
	return (options.as ?? owner).push({
		sessionId,
		workspaceId: options.workspaceId ?? WORKSPACE,
		harness: "claude-acp",
		harnessSessionId: "harness-1",
		epoch: options.epoch ?? "epoch-1",
		events: events.map((event) => ({ ...event, ts: 1 })),
	});
}

beforeAll(async () => {
	await db
		.insert(organizations)
		.values({ id: ORG, name: "Chat Org", slug: `chat-org-${suffix}` });
	await db.insert(users).values([
		{
			id: USER,
			name: "Chat User",
			email: `chat-${suffix}@example.com`,
			organizationIds: [ORG],
		},
		{
			id: OTHER_USER,
			name: "Other User",
			email: `chat-other-${suffix}@example.com`,
			organizationIds: [ORG],
		},
	]);
	await db.insert(members).values([
		{ organizationId: ORG, userId: USER, role: "member" },
		{ organizationId: ORG, userId: OTHER_USER, role: "member" },
	]);
});

afterAll(async () => {
	if (sessions.length > 0) {
		await db.delete(chatSessions).where(inArray(chatSessions.id, sessions));
	}
	await db.delete(users).where(inArray(users.id, [USER, OTHER_USER]));
	await db.delete(organizations).where(inArray(organizations.id, [ORG]));
});

describe("chatHistory.push and pull", () => {
	test("keeps the newest version of each item, in first-appearance order, whatever order retries arrive in", async () => {
		const sessionId = newSession();
		const events = [
			{ seq: 1, event: toolCall("tool", "running", "Run tests") },
			{ seq: 2, event: agentMessage("reply", "Running the tests now") },
			{ seq: 3, event: toolCall("tool", "completed", "Run tests") },
		];
		await push(sessionId, events.slice(0, 2));
		await push(sessionId, events.slice(2));
		await push(sessionId, [...events].reverse());

		const pulled = await owner.pull({ sessionId });
		expect(pulled.events.map((row) => row.firstSeq)).toEqual([1, 2]);
		expect(pulled.events.map((row) => row.seq)).toEqual([3, 2]);
		const tool = pulled.events[0]?.event;
		expect(tool?.type === "item" && tool.item.status).toBe("completed");
		expect(pulled.session.lastSeq).toBe(3);
		expect(pulled.session.epoch).toBe("epoch-1");
	});

	test("pages through the chat by first seq", async () => {
		const sessionId = newSession();
		await push(
			sessionId,
			[1, 2, 3, 4, 5].map((seq) => ({
				seq,
				event: agentMessage(`m${seq}`, `message ${seq}`),
			})),
		);
		const first = await owner.pull({ sessionId, limit: 2 });
		expect(first.events.map((row) => row.firstSeq)).toEqual([1, 2]);
		const rest = await owner.pull({
			sessionId,
			afterFirstSeq: first.nextAfterFirstSeq ?? 0,
			limit: 10,
		});
		expect(rest.events.map((row) => row.firstSeq)).toEqual([3, 4, 5]);
		expect(rest.nextAfterFirstSeq).toBeNull();
	});

	test("a new epoch starts the chat again", async () => {
		const sessionId = newSession();
		await push(sessionId, [{ seq: 1, event: agentMessage("old", "old") }]);
		await push(sessionId, [{ seq: 1, event: agentMessage("new", "new") }], {
			epoch: "epoch-2",
		});
		const pulled = await owner.pull({ sessionId });
		expect(
			pulled.events.map((row) => row.event.type === "item" && row.event.item.id),
		).toEqual(["new"]);
		expect(pulled.session.epoch).toBe("epoch-2");
	});

	test("only the owner can read a chat", async () => {
		const sessionId = newSession();
		await push(sessionId, [{ seq: 1, event: agentMessage("a", "private") }]);
		await expect(callerFor(OTHER_USER).pull({ sessionId })).rejects.toThrow();
	});

	test("a box may only sync its own workspace's chats", async () => {
		const sessionId = newSession();
		const box = callerFor(USER, CLOUD_WORKSPACE);
		await expect(
			push(sessionId, [{ seq: 1, event: agentMessage("a", "a") }], {
				as: box,
				workspaceId: WORKSPACE,
			}),
		).rejects.toThrow("only sync its own chats");

		await push(sessionId, [{ seq: 1, event: agentMessage("a", "a") }], {
			as: box,
			workspaceId: CLOUD_WORKSPACE,
		});
		expect((await box.pull({ sessionId })).events).toHaveLength(1);
	});

	test("the old host can no longer write a chat that moved", async () => {
		const sessionId = newSession();
		await push(sessionId, [{ seq: 1, event: agentMessage("a", "a") }]);
		await expect(
			push(sessionId, [{ seq: 2, event: agentMessage("b", "b") }], {
				workspaceId: CLOUD_WORKSPACE,
			}),
		).rejects.toThrow("moved to another workspace");
	});
});

describe("chatHistory.search", () => {
	test("finds code names, groups copies of one conversation, and shows only the caller's chats", async () => {
		const first = newSession();
		const copy = newSession();
		const unrelated = newSession();
		const text = "Fixed packages/chat-runtime/src/harness/acp/acpAdapter.ts";
		await push(first, [{ seq: 1, event: agentMessage("x", text) }]);
		await push(copy, [{ seq: 1, event: agentMessage("y", text) }]);
		await push(unrelated, [
			{ seq: 1, event: agentMessage("z", "Nothing relevant here") },
		]);

		const results = await owner.search({ query: "acpAdapter" });
		const ids = results.map((row) => row.sessionId);
		expect(ids.filter((id) => id === first || id === copy)).toHaveLength(1);
		expect(ids).not.toContain(unrelated);
		expect(results[0]?.snippet).toContain("acpAdapter");

		expect(await callerFor(OTHER_USER).search({ query: "acpAdapter" })).toEqual(
			[],
		);
	});
});
