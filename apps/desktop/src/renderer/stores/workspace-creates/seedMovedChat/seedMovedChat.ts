import { createWorkspaceStore, type WorkspaceState } from "@superset/panes";
import type {
	ChatPaneData,
	PaneViewerData,
} from "renderer/routes/_authenticated/_dashboard/v2-workspace/$workspaceId/types";
import type { AppCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider/collections";
import { writeWorkspacePaneLayout } from "../writeWorkspacePaneLayout";

/**
 * Opens a moved chat in the workspace it moved to. The chat keeps its id
 * across the move, so the pane can name it before the new host has it.
 */
export function seedMovedChat({
	collections,
	workspaceId,
	chatSessionId,
	harnessSessionId,
	agentId,
	title,
}: {
	collections: AppCollections;
	workspaceId: string;
	chatSessionId: string;
	harnessSessionId: string;
	agentId: string;
	title: string | null;
}): void {
	const existing = collections.v2WorkspaceLocalState.get(workspaceId)
		?.paneLayout as WorkspaceState<PaneViewerData> | undefined;
	if (existing?.tabs.length) return;
	writeWorkspacePaneLayout(
		collections,
		{ id: workspaceId, projectId: null },
		[],
		[],
	);
	const store = createWorkspaceStore<PaneViewerData>({
		initialState: existing,
	});
	store.getState().addTab({
		panes: [
			{
				kind: "chat-v3",
				data: {
					terminalId: chatSessionId,
					sessionId: chatSessionId,
					awaitingMove: true,
					agent: { id: agentId, sessionId: harnessSessionId },
					...(title ? { chatTitle: title } : {}),
				} as ChatPaneData,
			},
		],
	});
	const { version, tabs, activeTabId } = store.getState();
	collections.v2WorkspaceLocalState.update(workspaceId, (draft) => {
		draft.paneLayout = { version, tabs, activeTabId };
	});
}
