import type { DurableEvent } from "@superset/chat/protocol";

const MAX_STRING_CHARS = 64 * 1024;
const TIGHT_STRING_CHARS = 4 * 1024;
const MAX_EVENT_CHARS = 400 * 1024;
const CUT_MARKER = "\n…[cut for cloud storage]";

function cutStrings(value: unknown, limit: number): unknown {
	if (typeof value === "string") {
		return value.length > limit ? value.slice(0, limit) + CUT_MARKER : value;
	}
	if (Array.isArray(value))
		return value.map((entry) => cutStrings(entry, limit));
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [
				key,
				cutStrings(entry, limit),
			]),
		);
	}
	return value;
}

/**
 * The copy of an event kept in the cloud: long tool output and inline image
 * data are cut, and the session's command list, re-sent with every status
 * change, is dropped. The agent's own session file keeps the full output.
 */
export function prepareEventForCloud(event: DurableEvent): DurableEvent {
	let prepared = event;
	if (event.type === "session") {
		const { availableCommands: _commands, ...session } = event.session;
		prepared = { ...event, session };
	}
	const cut = cutStrings(prepared, MAX_STRING_CHARS) as DurableEvent;
	if (JSON.stringify(cut).length <= MAX_EVENT_CHARS) return cut;
	return cutStrings(prepared, TIGHT_STRING_CHARS) as DurableEvent;
}
