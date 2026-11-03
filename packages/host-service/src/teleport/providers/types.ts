import type { HarnessEnv } from "../../terminal-agents/harness-sessions/types";

/** Where an agent's session files were recorded, packed with them. */
export type BundleManifest = {
	version: 1;
	harnessSessionId: string;
	/** The working directory the agent ran in, as it recorded it. */
	sourceCwd: string;
	/** The directory the files sat in, which absolute paths inside them name. */
	sourceDir: string;
};

/**
 * Moves one agent's own session files between hosts. The rest of a move
 * (history, git, the new workspace) is the same for every agent.
 */
export type TeleportProvider = {
	harnesses: readonly string[];
	/** Copies the session's files into `stageDir`; returns what `place` needs. */
	collect(input: {
		harnessSessionId: string;
		worktreePath: string;
		env: HarnessEnv;
		locate: () => Promise<string | null>;
		stageDir: string;
	}): Promise<BundleManifest>;
	/** Puts the files from `stageDir` where the agent looks, paths rewritten. */
	place(input: {
		manifest: BundleManifest;
		worktreePath: string;
		env: HarnessEnv;
		stageDir: string;
	}): Promise<void>;
};
