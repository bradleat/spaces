/**
 * Shell session management - spawns subshells for workspaces
 */

import { spawn, spawnSync } from 'child_process'
import { logger } from '../utils/logger.js'
import { hasSetupBeenRun, markSetupComplete } from '../utils/workspace-state.js'
import { runScriptsInTerminal, type RunScriptsOptions } from '../utils/run-scripts.js'
import { getScriptsPhaseDir, readProjectConfig } from './config.js'
import { getProjectSecrets } from '../utils/secrets.js'

/**
 * Print a message to terminal using echo (same mechanism as scripts)
 */
function printToTerminal(message: string): void {
	spawnSync('echo', [message], { stdio: 'inherit' })
}

/**
 * Open a workspace in an interactive subshell
 *
 * Flow:
 * 1. Determine if setup or select scripts should run
 * 2. Run the appropriate scripts in the terminal
 * 3. Spawn an interactive subshell in the workspace directory
 * 4. User gets control of the shell with their environment ready
 *
 * @param selectOnly - If true, only run select scripts (skip setup check). Used by TUI which handles setup during creation.
 */
export async function openWorkspaceShell(
	workspacePath: string,
	projectName: string,
	repository: string,
	noSetup: boolean = false,
	selectOnly: boolean = false
): Promise<void> {
	const workspaceName = workspacePath.split('/').pop() || 'workspace'

	// Build script options with bundle values and secrets
	const projectConfig = readProjectConfig(projectName)
	const scriptOptions: RunScriptsOptions = {
		bundleValues: projectConfig.bundleValues,
	}

	// Fetch secrets from OS keychain if we have secret keys
	if (projectConfig.bundleSecretKeys && projectConfig.bundleSecretKeys.length > 0) {
		scriptOptions.bundleSecrets = await getProjectSecrets(projectName, projectConfig.bundleSecretKeys)
	}

	if (selectOnly) {
		// TUI mode: setup was done during creation, just run select scripts
		const selectScriptsDir = getScriptsPhaseDir(projectName, 'select')
		await runScriptsInTerminal(
			selectScriptsDir,
			workspacePath,
			workspaceName,
			repository,
			scriptOptions
		)
	} else {
		const setupAlreadyRun = hasSetupBeenRun(workspacePath)

		// Determine which scripts to run based on setup status
		if (setupAlreadyRun) {
			// Setup has been run before, run select scripts
			const selectScriptsDir = getScriptsPhaseDir(projectName, 'select')
			await runScriptsInTerminal(
				selectScriptsDir,
				workspacePath,
				workspaceName,
				repository,
				scriptOptions
			)
		} else if (!noSetup) {
			// First time setup, run setup scripts
			printToTerminal('Running setup scripts (first time)...')
			const setupScriptsDir = getScriptsPhaseDir(projectName, 'setup')
			await runScriptsInTerminal(
				setupScriptsDir,
				workspacePath,
				workspaceName,
				repository,
				scriptOptions
			)

			// Mark setup as complete
			markSetupComplete(workspacePath)
			printToTerminal('✓ Setup complete')
		}
	}

	printToTerminal('')
	printToTerminal('💡 Press Ctrl+D or type "exit" to return to Spaces TUI')
	printToTerminal('')

	// Spawn interactive shell in workspace directory
	await spawnInteractiveShell(workspacePath)
}

/**
 * Spawn an interactive shell in the given directory
 * Returns when the shell exits, allowing caller to continue
 */
async function spawnInteractiveShell(workingDir: string): Promise<void> {
	const userShell = process.env.SHELL || '/bin/bash'

	logger.debug(`Spawning ${userShell} in ${workingDir}`)

	const shell = spawn(userShell, ['-i'], {
		stdio: 'inherit',
		cwd: workingDir,
		env: {
			...process.env,
			// Set SPACES_WORKSPACE to let scripts know they're in a spaces shell
			SPACES_WORKSPACE: workingDir,
		},
	})

	// Handle shell exit - resolve promise to return control to caller
	return new Promise((resolve, reject) => {
		shell.on('exit', (_code) => {
			resolve()
		})

		shell.on('error', (error) => {
			logger.error(`Failed to spawn shell: ${error.message}`)
			reject(error)
		})
	})
}
