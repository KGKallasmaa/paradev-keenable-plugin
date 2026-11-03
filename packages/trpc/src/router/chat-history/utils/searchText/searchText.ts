import {
	type AgentMessage,
	isHiddenText,
	type Item,
	type ToolCall,
	type UserMessage,
} from "@superset/chat/protocol";

const MAX_SEARCH_TEXT_CHARS = 32_000;
const ATTACHMENT_TAG = /<attachment path="[^"]*"[^>]*\/>/g;
const HIDDEN_BLOCK = /<superset-context>[\s\S]*?<\/superset-context>/g;
const CAMEL_BOUNDARY = /([a-z0-9])([A-Z])/g;
const CODE_PUNCTUATION = /[/._:()[\]{}<>`#=-]+/g;

/** What a search can match: what the user and the agent said, and tool titles. */
export function searchTextForItem(item: Item): string {
	let text = "";
	if (item.kind === "user_message") {
		text = (item as UserMessage).content
			.flatMap((part) =>
				part.type === "text" && !part.hidden && !isHiddenText(part.text)
					? [part.text]
					: [],
			)
			.join("\n");
	} else if (item.kind === "agent_message") {
		text = (item as AgentMessage).text;
	} else if (item.kind === "tool_call") {
		text = (item as ToolCall).title;
	}
	return text
		.replace(HIDDEN_BLOCK, " ")
		.replace(ATTACHMENT_TAG, " ")
		.trim()
		.slice(0, MAX_SEARCH_TEXT_CHARS);
}

/** The query split the way `chat_search_text` splits what it indexes. */
export function splitSearchQuery(query: string): string {
	return query
		.replace(CAMEL_BOUNDARY, "$1 $2")
		.replace(CODE_PUNCTUATION, " ")
		.replace(/\s+/g, " ")
		.trim();
}
