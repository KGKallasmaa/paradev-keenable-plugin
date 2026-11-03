import { useLingui } from "@lingui/react/macro";
import type { MachineSize } from "@superset/shared/billing";
import { useWorkspaceClient } from "@superset/workspace-client";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { useActiveOrganizationId } from "renderer/hooks/useActiveOrganizationId";
import { cloudTrpc, cloudTrpcClient } from "renderer/lib/cloud-trpc";

export function useMoveChatToCloud(workspaceId: string) {
	const { t } = useLingui();
	const navigate = useNavigate();
	const { trpcClient } = useWorkspaceClient();
	const organizationId = useActiveOrganizationId();
	const utils = cloudTrpc.useUtils();

	return useCallback(
		async ({
			chatSessionId,
			name,
			environment,
			machineSize,
		}: {
			chatSessionId: string;
			name: string;
			environment: { id: string; repositoryFullName: string | null };
			machineSize: MachineSize;
		}) => {
			if (!organizationId) throw new Error(t`No active organization`);
			const prepared = await trpcClient.teleport.prepare.mutate({
				workspaceId,
				chatSessionId,
			});
			const environmentRepository = environment.repositoryFullName;
			const chatRepository = prepared.repositoryFullName;
			if (
				environmentRepository &&
				environmentRepository.toLowerCase() !== chatRepository.toLowerCase()
			) {
				throw new Error(
					t`This environment opens ${environmentRepository}, not ${chatRepository}`,
				);
			}
			const created = await cloudTrpcClient.cloudWorkspace.create.mutate({
				organizationId,
				environmentId: environment.id,
				machineSize,
				name,
				branch: prepared.branch,
				agent: "claude",
				resume: {
					chatSessionId,
					harnessSessionId: prepared.harnessSessionId,
				},
			});
			const listInput = { organizationId };
			await utils.cloudWorkspace.list.cancel(listInput);
			utils.cloudWorkspace.list.setData(listInput, (rows) =>
				rows ? [created, ...rows] : [created],
			);
			void utils.cloudWorkspace.list.invalidate();
			await navigate({
				to: "/v2-workspace/$workspaceId",
				params: { workspaceId: created.id },
			});
		},
		[organizationId, t, trpcClient, workspaceId, utils, navigate],
	);
}
