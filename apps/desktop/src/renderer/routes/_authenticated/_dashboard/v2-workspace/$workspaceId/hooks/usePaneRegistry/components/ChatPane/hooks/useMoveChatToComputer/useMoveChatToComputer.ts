import { useLingui } from "@lingui/react/macro";
import { useWorkspaceClient } from "@superset/workspace-client";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { useHostProjects } from "renderer/hooks/host-projects/useHostProjects";
import { getHostServiceClientByUrl } from "renderer/lib/host-service-client";
import { useLocalHostService } from "renderer/routes/_authenticated/providers/LocalHostServiceProvider";
import { useWorkspaceCreates } from "renderer/stores/workspace-creates";

export type MoveToComputerStage = "saving" | "creating" | "restoring";

/** Moves a chat from a workspace on another host into a new workspace here. */
export function useMoveChatToComputer(workspaceId: string) {
	const { t } = useLingui();
	const navigate = useNavigate();
	const { trpcClient: remote } = useWorkspaceClient();
	const { activeHostUrl, machineId } = useLocalHostService();
	const { projects } = useHostProjects();
	const { submit } = useWorkspaceCreates();

	return useCallback(
		async ({
			chatSessionId,
			onStage,
		}: {
			chatSessionId: string;
			onStage: (stage: MoveToComputerStage) => void;
		}) => {
			if (!activeHostUrl)
				throw new Error(t`This computer's host is not running`);
			onStage("saving");
			const prepared = await remote.teleport.prepare.mutate({
				workspaceId,
				chatSessionId,
				stopIfBusy: true,
			});
			const repository = prepared.repositoryFullName.toLowerCase();
			const project = projects.find(
				(row) =>
					row.hostIds.includes(machineId) &&
					`${row.repoOwner}/${row.repoName}`.toLowerCase() === repository,
			);
			if (!project) {
				const repositoryName = prepared.repositoryFullName;
				throw new Error(
					t`Add ${repositoryName} as a project on this computer first`,
				);
			}

			onStage("creating");
			const local = getHostServiceClientByUrl(activeHostUrl);
			await local.teleport.fetchBranch.mutate({
				projectId: project.id,
				branch: prepared.branch,
			});
			const handle = submit({
				hostId: machineId,
				snapshot: {
					id: crypto.randomUUID(),
					projectId: project.id,
					branch: prepared.branch,
					skipBranchPrefix: true,
					...(prepared.title ? { name: prepared.title } : {}),
				},
			});
			const created = await handle.completed;
			if (!created.ok) throw new Error(created.error);

			onStage("restoring");
			await local.teleport.receive.mutate({
				workspaceId: created.workspaceId,
				chatSessionId,
				harnessSessionId: prepared.harnessSessionId,
			});
			await remote.teleport.markMoved
				.mutate({ workspaceId, chatSessionId, destination: "computer" })
				.catch((error: unknown) => {
					console.warn("[teleport] could not mark the cloud copy moved", error);
				});
			await navigate({
				to: "/v2-workspace/$workspaceId",
				params: { workspaceId: created.workspaceId },
				search: {
					sessionId: chatSessionId,
					focusRequestId: crypto.randomUUID(),
				},
			});
		},
		[
			t,
			remote,
			workspaceId,
			activeHostUrl,
			machineId,
			projects,
			submit,
			navigate,
		],
	);
}
