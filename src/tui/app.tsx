/**
 * Main TUI application using @opentui/react
 * Two-panel layout with projects on left, workspaces on right
 */

import { createCliRenderer } from '@opentui/core';
import { createRoot, useKeyboard, useRenderer } from '@opentui/react';
import { useState, useEffect, useCallback, useReducer } from 'react';
import {
  loadProjects,
  loadWorkspaces,
  stateReducer,
  createInitialState,
  type ProjectState,
  type WorkspaceState,
} from './state.js';
import {
  setCurrentProject,
  getProjectWorkspacesDir,
  getProjectBaseDir,
  readProjectConfig,
  createProject,
  projectExists,
  getAllProjectNames,
} from '../core/config.js';
import { openWorkspaceShell } from '../core/shell.js';
import { removeWorkspace, removeProject } from '../commands/remove.js';
import { listAllRepos, cloneRepository } from '../core/github.js';
import { listRemoteBranches, getDefaultBranch, createWorktree, checkRemoteBranch } from '../core/git.js';
import { fetchUnstartedIssues } from '../core/linear.js';
import { sanitizeForFileSystem, extractRepoName, generateWorkspaceName, isValidWorkspaceName } from '../utils/sanitize.js';
import { join } from 'path';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { generateMarkdown } from '../utils/markdown.js';
import { runScriptsInTerminal, type RunScriptsOptions } from '../utils/run-scripts.js';
import { getProjectSecrets } from '../utils/secrets.js';
import { getScriptsPhaseDir, updateProjectConfig } from '../core/config.js';
import { markSetupComplete } from '../utils/workspace-state.js';
import { createRequire } from 'module';
import { appendFileSync } from 'fs';
import { homedir } from 'os';
import {
  detectBundleInRepo,
  loadBundleFromPath,
  copyBundleScripts,
} from '../core/bundle.js';
import { setProjectSecret } from '../utils/secrets.js';
// Debug log to file (useful for debugging TUI issues)
const DEBUG_LOG = join(homedir(), 'spaces-debug.log');
function debugLog(msg: string) {
  const timestamp = new Date().toISOString();
  appendFileSync(DEBUG_LOG, `[${timestamp}] ${msg}\n`);
}

// Version from package.json
const require = createRequire(import.meta.url);
const { version: VERSION } = require('../../package.json');

// Colors
const COLORS = {
  border: '#555555',
  borderFocused: '#00AAFF',
  text: '#FFFFFF',
  textDim: '#888888',
  selected: '#00AAFF',
  title: '#00FF88',
  statusBar: '#333333',
  stale: '#FF8800',
  loading: '#FFAA00',
  error: '#FF4444',
  // Gradient colors for ASCII art
  gradient1: '#00FFFF',
  gradient2: '#00DDFF',
  gradient3: '#00BBFF',
  gradient4: '#0099FF',
  gradient5: '#0077FF',
  gradient6: '#0055FF',
  asciiBox: '#444466',
  subtitle: '#888899',
};

// Flow types for multi-step dialogs
type FlowState =
  | { type: 'none' }
  | { type: 'help' }
  | { type: 'confirm-delete'; target: { type: 'workspace'; name: string } | { type: 'project'; name: string } }
  | { type: 'workspace-actions'; projectName: string; workspaceName: string }
  // New Project flow
  | { type: 'new-project-loading' }
  | { type: 'new-project-select'; repos: string[]; selectedIndex: number }
  | { type: 'new-project-cloning'; repo: string }
  | {
      type: 'new-project-onboarding';
      repo: string;
      projectName: string;
      baseBranch: string;
      bundleDir: string;
      bundleName: string;
      steps: import('../types/bundle.js').OnboardingStep[];
      currentStep: number;
      collectedValues: Record<string, string>;
      /** Keys of secrets that have been stored via Bun.secrets */
      collectedSecretKeys: string[];
      inputValue: string;
      /** For confirm steps: status of command check */
      confirmStatus?: 'checking' | 'found' | 'missing' | null;
    }
  // New Workspace flow
  | { type: 'new-workspace-source'; selectedIndex: number; hasLinear: boolean }
  | { type: 'new-workspace-loading'; source: 'branch' | 'linear' }
  | { type: 'new-workspace-select-branch'; branches: string[]; selectedIndex: number }
  | { type: 'new-workspace-select-linear'; issues: Array<{ identifier: string; title: string }>; selectedIndex: number }
  | { type: 'new-workspace-manual'; inputValue: string }
  | { type: 'new-workspace-creating'; name: string };

// ASCII art header lines with colors
const ASCII_LINES = [
  { text: '╔══════════════════════════════════════════════════════════════╗', color: COLORS.asciiBox },
  { text: '║                                                              ║', color: COLORS.asciiBox },
  { text: '║   ███████╗██████╗  █████╗  ██████╗███████╗███████╗           ║', color: COLORS.gradient1 },
  { text: '║   ██╔════╝██╔══██╗██╔══██╗██╔════╝██╔════╝██╔════╝           ║', color: COLORS.gradient2 },
  { text: '║   ███████╗██████╔╝███████║██║     █████╗  ███████╗           ║', color: COLORS.gradient3 },
  { text: '║   ╚════██║██╔═══╝ ██╔══██║██║     ██╔══╝  ╚════██║           ║', color: COLORS.gradient4 },
  { text: '║   ███████║██║     ██║  ██║╚██████╗███████╗███████║           ║', color: COLORS.gradient5 },
  { text: '║   ╚══════╝╚═╝     ╚═╝  ╚═╝ ╚═════╝╚══════╝╚══════╝           ║', color: COLORS.gradient6 },
  { text: '║                                                              ║', color: COLORS.asciiBox },
  { text: '║                    worktree manager                          ║', color: COLORS.subtitle },
  { text: '║                                                              ║', color: COLORS.asciiBox },
  { text: '╚══════════════════════════════════════════════════════════════╝', color: COLORS.asciiBox },
];

// Header component with colorful ASCII art
function Header() {
  return (
    <box flexDirection="column" alignItems="center" width="100%" height={13}>
      {ASCII_LINES.map((line, i) => (
        <text key={i} fg={line.color}>{line.text}</text>
      ))}
      <text fg={COLORS.textDim}>v{VERSION}</text>
    </box>
  );
}

// Project panel component
function ProjectPanel({
  projects,
  selectedIndex,
  focused,
  onNavigate,
}: {
  projects: ProjectState[];
  selectedIndex: number;
  focused: boolean;
  onNavigate: (index: number) => void;
}) {
  const options = projects.map((p) => ({
    name: p.name,
    value: p.name,
    description: `${p.repository} (${p.workspaceCount} workspaces)${p.isCurrent ? ' *' : ''}`,
  }));

  return (
    <box
      flexGrow={1}
      flexDirection="column"
      border
      borderStyle="single"
      borderColor={focused ? COLORS.borderFocused : COLORS.border}
    >
      <text fg={COLORS.title} paddingLeft={1}> Projects </text>
      {projects.length > 0 ? (
        <select
          options={options}
          focused={focused}
          selectedIndex={selectedIndex}
          showDescription
          flexGrow={1}
          onChange={(index) => onNavigate(index)}
        />
      ) : (
        <text fg={COLORS.textDim} paddingLeft={2} paddingTop={1}>No projects. Press [n] to add one.</text>
      )}
    </box>
  );
}

// Workspace panel component
function WorkspacePanel({
  workspaces,
  selectedIndex,
  focused,
  projectName,
  onSelect,
}: {
  workspaces: WorkspaceState[];
  selectedIndex: number;
  focused: boolean;
  projectName: string | null;
  onSelect: (index: number) => void;
}) {
  const options = workspaces.map((ws) => {
    let status = ws.uncommittedChanges > 0 ? `${ws.uncommittedChanges} changes` : 'clean';
    if (ws.isStale) status += ' (stale)';
    const branchInfo =
      ws.ahead > 0 || ws.behind > 0
        ? `[${ws.branch} +${ws.ahead} -${ws.behind}]`
        : `[${ws.branch}]`;
    return {
      name: ws.name,
      value: ws.name,
      description: `${branchInfo} ${status}`,
    };
  });

  return (
    <box
      flexGrow={2}
      flexDirection="column"
      border
      borderStyle="single"
      borderColor={focused ? COLORS.borderFocused : COLORS.border}
    >
      <text fg={COLORS.title} paddingLeft={1}>
        {projectName ? ` Workspaces (${projectName}) ` : ' Workspaces '}
      </text>
      {workspaces.length > 0 ? (
        <select
          options={options}
          focused={focused}
          selectedIndex={selectedIndex}
          showDescription
          flexGrow={1}
          onChange={(index) => onSelect(index)}
        />
      ) : (
        <text fg={COLORS.textDim} paddingLeft={2} paddingTop={1}>
          {projectName ? 'No workspaces. Press [n] to create one.' : 'Select a project first'}
        </text>
      )}
    </box>
  );
}

// Status bar component
function StatusBar({ activePanel }: { activePanel: 'projects' | 'workspaces' }) {
  const newAction = activePanel === 'projects' ? 'New Project' : 'New Workspace';
  return (
    <box width="100%" height={1} backgroundColor={COLORS.statusBar}>
      <text fg={COLORS.textDim}>
        {` [Arrows] Navigate  [Tab] Switch  [Enter] Select  [n] ${newAction}  [d] Delete  [?] Help  [q] Quit`}
      </text>
    </box>
  );
}

// Modal dialog component
function Modal({
  title,
  children,
  hint,
  width = 60,
  height,
}: {
  title: string;
  children: React.ReactNode;
  hint?: string;
  width?: number;
  height?: number;
}) {
  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width="100%"
      height="100%"
      backgroundColor="rgba(0, 0, 0, 0.7)"
      justifyContent="center"
      alignItems="center"
    >
      <box
        width={width}
        height={height}
        border
        borderStyle="single"
        borderColor={COLORS.borderFocused}
        backgroundColor="#222222"
        flexDirection="column"
        padding={1}
      >
        <text fg={COLORS.title} height={1}>{title}</text>
        {children}
        {hint && <text fg={COLORS.textDim} height={1}>{hint}</text>}
      </box>
    </box>
  );
}

// Main App component
function App({ onQuit, onOpenShell }: { onQuit: () => void; onOpenShell: (projectName: string, workspaceName: string) => Promise<void> }) {
  const [state, dispatch] = useReducer(stateReducer, createInitialState());
  const [flow, setFlow] = useState<FlowState>({ type: 'none' });
  const [error, setError] = useState<string | null>(null);
  const renderer = useRenderer();

  // Load initial data
  useEffect(() => {
    const load = async () => {
      const projects = loadProjects();
      dispatch({ type: 'SET_PROJECTS', projects });

      if (projects.length > 0) {
        const currentIndex = projects.findIndex((p) => p.isCurrent);
        if (currentIndex >= 0) {
          dispatch({ type: 'SELECT_PROJECT', index: currentIndex });
          dispatch({ type: 'SET_CURRENT_PROJECT', project: projects[currentIndex].name });
          const workspaces = await loadWorkspaces(projects[currentIndex].name);
          dispatch({ type: 'SET_WORKSPACES', workspaces });
        }
      }
      dispatch({ type: 'SET_LOADING', loading: false });
    };
    load();
  }, []);

  // Load workspaces when project changes
  const loadWorkspacesForProject = useCallback(async (projectName: string) => {
    const workspaces = await loadWorkspaces(projectName);
    dispatch({ type: 'SET_WORKSPACES', workspaces });
  }, []);

  // Handle project selection
  const handleSelectProject = useCallback(async (index: number) => {
    const project = state.projects[index];
    if (project) {
      dispatch({ type: 'SELECT_PROJECT', index });
      dispatch({ type: 'SET_CURRENT_PROJECT', project: project.name });
      setCurrentProject(project.name);
      await loadWorkspacesForProject(project.name);
      dispatch({ type: 'SET_ACTIVE_PANEL', panel: 'workspaces' });
      dispatch({ type: 'SELECT_WORKSPACE', index: 0 });
    }
  }, [state.projects, loadWorkspacesForProject]);

  // Start new project flow
  const startNewProjectFlow = useCallback(async () => {
    setFlow({ type: 'new-project-loading' });
    setError(null);
    try {
      const repos = await listAllRepos();
      if (repos.length === 0) {
        setError('No repositories found');
        setFlow({ type: 'none' });
        return;
      }
      setFlow({ type: 'new-project-select', repos, selectedIndex: 0 });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch repositories');
      setFlow({ type: 'none' });
    }
  }, []);

  // Handle project creation
  const handleCreateProject = useCallback(async (repo: string) => {
    setFlow({ type: 'new-project-cloning', repo });
    setError(null);

    const projectName = extractRepoName(repo);

    // Check if already exists
    if (projectExists(projectName)) {
      setError(`Project "${projectName}" already exists`);
      setFlow({ type: 'none' });
      return;
    }

    // Check for duplicate repos
    const existingProjects = getAllProjectNames();
    for (const existing of existingProjects) {
      const config = readProjectConfig(existing);
      if (config.repository === repo) {
        setError(`Repository already tracked by project "${existing}"`);
        setFlow({ type: 'none' });
        return;
      }
    }

    try {
      const baseDir = getProjectBaseDir(projectName);
      debugLog(`Cloning ${repo} to ${baseDir}`);
      await cloneRepository(repo, baseDir);
      debugLog(`Clone complete`);

      const baseBranch = await getDefaultBranch(baseDir);
      debugLog(`Default branch: ${baseBranch}`);

      // Check for bundle in cloned repo
      debugLog(`Checking for bundle in: ${baseDir}`);
      const bundleDir = detectBundleInRepo(baseDir);
      debugLog(`bundleDir result: ${bundleDir}`);

      if (bundleDir) {
        debugLog(`Bundle directory found, loading...`);
        try {
          const loadedBundle = loadBundleFromPath(bundleDir);
          debugLog(`Bundle loaded: ${loadedBundle.bundle.name}`);
          debugLog(`Onboarding steps: ${loadedBundle.bundle.onboarding?.length ?? 0}`);

          // If bundle has onboarding steps, start the TUI onboarding flow
          if (loadedBundle.bundle.onboarding && loadedBundle.bundle.onboarding.length > 0) {
            debugLog(`Has onboarding steps, starting TUI onboarding flow...`);
            const firstStep = loadedBundle.bundle.onboarding[0];
            const initialInputValue = firstStep.type === 'input' && firstStep.defaultValue ? firstStep.defaultValue : '';

            // Check if first step is a confirm step with checkCommand
            if (firstStep.type === 'confirm' && firstStep.checkCommand) {
              setFlow({
                type: 'new-project-onboarding',
                repo,
                projectName,
                baseBranch,
                bundleDir: loadedBundle.bundleDir,
                bundleName: loadedBundle.bundle.name,
                steps: loadedBundle.bundle.onboarding,
                currentStep: 0,
                collectedValues: {},
                collectedSecretKeys: [],
                inputValue: '',
                confirmStatus: 'checking',
              });

              // Check command asynchronously
              const checkCmd = firstStep.checkCommand;
              import('child_process').then(async ({ exec }) => {
                const { promisify } = await import('util');
                const execAsync = promisify(exec);
                try {
                  await execAsync(`which ${checkCmd}`);
                  setFlow((prev) => {
                    if (prev.type !== 'new-project-onboarding') return prev;
                    return { ...prev, confirmStatus: 'found' };
                  });
                } catch {
                  setFlow((prev) => {
                    if (prev.type !== 'new-project-onboarding') return prev;
                    return { ...prev, confirmStatus: 'missing' };
                  });
                }
              });
            } else {
              setFlow({
                type: 'new-project-onboarding',
                repo,
                projectName,
                baseBranch,
                bundleDir: loadedBundle.bundleDir,
                bundleName: loadedBundle.bundle.name,
                steps: loadedBundle.bundle.onboarding,
                currentStep: 0,
                collectedValues: {},
                collectedSecretKeys: [],
                inputValue: initialInputValue,
                confirmStatus: null,
              });
            }
            // Return here - the flow will be continued by keyboard handlers
            return;
          } else {
            // Bundle exists but no onboarding steps, just copy scripts
            createProject(projectName, repo, baseBranch);
            copyBundleScripts(loadedBundle.bundleDir, projectName);
            updateProjectConfig(projectName, {
              appliedBundle: {
                name: loadedBundle.bundle.name,
                version: loadedBundle.bundle.version,
                source: loadedBundle.source,
                appliedAt: new Date().toISOString(),
              },
            });
          }
        } catch (bundleErr) {
          // Bundle loading failed, continue without bundle
          console.error('Failed to load bundle:', bundleErr);
          createProject(projectName, repo, baseBranch);
        }
      } else {
        // No bundle found
        createProject(projectName, repo, baseBranch);
      }

      setCurrentProject(projectName);

      // Refresh projects
      const projects = loadProjects();
      dispatch({ type: 'SET_PROJECTS', projects });
      const idx = projects.findIndex(p => p.name === projectName);
      if (idx >= 0) {
        dispatch({ type: 'SELECT_PROJECT', index: idx });
        dispatch({ type: 'SET_CURRENT_PROJECT', project: projectName });
      }
      setFlow({ type: 'none' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clone repository');
      setFlow({ type: 'none' });
    }
  }, [renderer]);

  // Finalize project creation after onboarding
  const finalizeProjectAfterOnboarding = useCallback(
    async (
      projectName: string,
      repo: string,
      baseBranch: string,
      bundleDir: string,
      bundleName: string,
      collectedValues: Record<string, string>,
      collectedSecretKeys: string[]
    ) => {
      try {
        // Create the project
        createProject(projectName, repo, baseBranch);

        // Copy bundle scripts
        const bundleResult = loadBundleFromPath(bundleDir);
        copyBundleScripts(bundleDir, projectName);

        // Store bundle values, secret keys, and metadata
        updateProjectConfig(projectName, {
          bundleValues: collectedValues,
          bundleSecretKeys: collectedSecretKeys.length > 0 ? collectedSecretKeys : undefined,
          appliedBundle: {
            name: bundleName,
            version: bundleResult.bundle.version,
            source: bundleResult.source,
            appliedAt: new Date().toISOString(),
          },
        });

        setCurrentProject(projectName);

        // Refresh projects
        const projects = loadProjects();
        dispatch({ type: 'SET_PROJECTS', projects });
        const idx = projects.findIndex((p) => p.name === projectName);
        if (idx >= 0) {
          dispatch({ type: 'SELECT_PROJECT', index: idx });
          dispatch({ type: 'SET_CURRENT_PROJECT', project: projectName });
        }
        setFlow({ type: 'none' });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to create project');
        setFlow({ type: 'none' });
      }
    },
    []
  );

  // Check command for confirm steps
  const checkOnboardingCommand = useCallback(async (command: string): Promise<boolean> => {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);
      await execAsync(`which ${command}`);
      return true;
    } catch {
      return false;
    }
  }, []);

  // Advance to next onboarding step or finalize
  const advanceOnboardingStep = useCallback(
    async (flow: Extract<FlowState, { type: 'new-project-onboarding' }>) => {
      const nextStep = flow.currentStep + 1;

      if (nextStep >= flow.steps.length) {
        // All steps done, finalize project
        await finalizeProjectAfterOnboarding(
          flow.projectName,
          flow.repo,
          flow.baseBranch,
          flow.bundleDir,
          flow.bundleName,
          flow.collectedValues,
          flow.collectedSecretKeys
        );
      } else {
        // Move to next step
        const nextStepData = flow.steps[nextStep];
        let confirmStatus: 'checking' | 'found' | 'missing' | null = null;

        // If next step is confirm with checkCommand, start checking
        if (nextStepData.type === 'confirm' && nextStepData.checkCommand) {
          confirmStatus = 'checking';
          setFlow({
            ...flow,
            currentStep: nextStep,
            inputValue: '',
            confirmStatus,
          });

          // Check command asynchronously
          const found = await checkOnboardingCommand(nextStepData.checkCommand);
          setFlow((prev) => {
            if (prev.type !== 'new-project-onboarding') return prev;
            return { ...prev, confirmStatus: found ? 'found' : 'missing' };
          });
        } else {
          setFlow({
            ...flow,
            currentStep: nextStep,
            inputValue: nextStepData.type === 'input' && nextStepData.defaultValue ? nextStepData.defaultValue : '',
            confirmStatus: null,
          });
        }
      }
    },
    [finalizeProjectAfterOnboarding, checkOnboardingCommand]
  );

  // Start new workspace flow
  const startNewWorkspaceFlow = useCallback(() => {
    if (!state.currentProject) return;
    const config = readProjectConfig(state.currentProject);
    setFlow({
      type: 'new-workspace-source',
      selectedIndex: 0,
      hasLinear: !!config.linearApiKey,
    });
    setError(null);
  }, [state.currentProject]);

  // Handle workspace source selection
  const handleWorkspaceSourceSelect = useCallback(async (source: 'branch' | 'linear' | 'manual') => {
    if (!state.currentProject) return;

    if (source === 'manual') {
      setFlow({ type: 'new-workspace-manual', inputValue: '' });
      return;
    }

    setFlow({ type: 'new-workspace-loading', source });
    setError(null);

    try {
      if (source === 'branch') {
        const baseDir = getProjectBaseDir(state.currentProject);
        const config = readProjectConfig(state.currentProject);
        const allBranches = await listRemoteBranches(baseDir);
        const branches = allBranches.filter(b => b !== config.baseBranch);
        if (branches.length === 0) {
          setError('No remote branches found');
          setFlow({ type: 'none' });
          return;
        }
        setFlow({ type: 'new-workspace-select-branch', branches, selectedIndex: 0 });
      } else if (source === 'linear') {
        const config = readProjectConfig(state.currentProject);
        if (!config.linearApiKey) {
          setError('Linear not configured for this project');
          setFlow({ type: 'none' });
          return;
        }
        const issues = await fetchUnstartedIssues(config.linearApiKey, config.linearTeamKey);
        if (issues.length === 0) {
          setError('No unstarted Linear issues found');
          setFlow({ type: 'none' });
          return;
        }
        setFlow({
          type: 'new-workspace-select-linear',
          issues: issues.map(i => ({ identifier: i.identifier, title: i.title })),
          selectedIndex: 0,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
      setFlow({ type: 'none' });
    }
  }, [state.currentProject]);

  // Create workspace from branch
  const createWorkspaceFromBranch = useCallback(async (branch: string) => {
    if (!state.currentProject) return;

    const workspaceName = sanitizeForFileSystem(branch);
    setFlow({ type: 'new-workspace-creating', name: workspaceName });

    try {
      const config = readProjectConfig(state.currentProject);
      const baseDir = getProjectBaseDir(state.currentProject);
      const workspacesDir = getProjectWorkspacesDir(state.currentProject);
      const workspacePath = join(workspacesDir, workspaceName);

      if (existsSync(workspacePath)) {
        setError(`Workspace "${workspaceName}" already exists`);
        setFlow({ type: 'none' });
        return;
      }

      await createWorktree(baseDir, workspacePath, branch, config.baseBranch, true);

      // Build script options with bundle values and secrets
      const scriptOptions: RunScriptsOptions = {
        bundleValues: config.bundleValues,
      };
      if (config.bundleSecretKeys && config.bundleSecretKeys.length > 0) {
        scriptOptions.bundleSecrets = await getProjectSecrets(state.currentProject, config.bundleSecretKeys);
      }

      // Run pre and setup scripts during creation
      const preScriptsDir = getScriptsPhaseDir(state.currentProject, 'pre');
      const setupScriptsDir = getScriptsPhaseDir(state.currentProject, 'setup');
      renderer.suspend();
      try {
        await runScriptsInTerminal(preScriptsDir, workspacePath, workspaceName, config.repository, scriptOptions);
        await runScriptsInTerminal(setupScriptsDir, workspacePath, workspaceName, config.repository, scriptOptions);
        markSetupComplete(workspacePath);
      } finally {
        renderer.resume();
      }

      await loadWorkspacesForProject(state.currentProject);
      setFlow({ type: 'none' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create workspace');
      setFlow({ type: 'none' });
    }
  }, [state.currentProject, renderer, loadWorkspacesForProject]);

  // Create workspace from Linear issue
  const createWorkspaceFromLinear = useCallback(async (identifier: string, title: string) => {
    if (!state.currentProject) return;

    const workspaceName = generateWorkspaceName(identifier, title);
    setFlow({ type: 'new-workspace-creating', name: workspaceName });

    try {
      const config = readProjectConfig(state.currentProject);
      const baseDir = getProjectBaseDir(state.currentProject);
      const workspacesDir = getProjectWorkspacesDir(state.currentProject);
      const workspacePath = join(workspacesDir, workspaceName);

      if (existsSync(workspacePath)) {
        setError(`Workspace "${workspaceName}" already exists`);
        setFlow({ type: 'none' });
        return;
      }

      const branchName = workspaceName;
      const existsRemotely = await checkRemoteBranch(baseDir, branchName);
      await createWorktree(baseDir, workspacePath, branchName, config.baseBranch, existsRemotely);

      // Save Linear issue details
      const issues = await fetchUnstartedIssues(config.linearApiKey!, config.linearTeamKey);
      const issue = issues.find(i => i.identifier === identifier);
      if (issue) {
        const promptDir = join(workspacePath, '.prompt');
        mkdirSync(promptDir, { recursive: true });
        const markdown = await generateMarkdown(issue, promptDir, config.linearApiKey);
        writeFileSync(join(promptDir, 'issue.md'), markdown, 'utf-8');
      }

      // Build script options with bundle values and secrets
      const scriptOptions: RunScriptsOptions = {
        bundleValues: config.bundleValues,
      };
      if (config.bundleSecretKeys && config.bundleSecretKeys.length > 0) {
        scriptOptions.bundleSecrets = await getProjectSecrets(state.currentProject, config.bundleSecretKeys);
      }

      // Run pre and setup scripts during creation
      const preScriptsDir = getScriptsPhaseDir(state.currentProject, 'pre');
      const setupScriptsDir = getScriptsPhaseDir(state.currentProject, 'setup');
      renderer.suspend();
      try {
        await runScriptsInTerminal(preScriptsDir, workspacePath, workspaceName, config.repository, scriptOptions);
        await runScriptsInTerminal(setupScriptsDir, workspacePath, workspaceName, config.repository, scriptOptions);
        markSetupComplete(workspacePath);
      } finally {
        renderer.resume();
      }

      await loadWorkspacesForProject(state.currentProject);
      setFlow({ type: 'none' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create workspace');
      setFlow({ type: 'none' });
    }
  }, [state.currentProject, renderer, loadWorkspacesForProject]);

  // Create workspace with manual name
  const createWorkspaceManual = useCallback(async (name: string) => {
    if (!state.currentProject || !name.trim()) return;

    if (!isValidWorkspaceName(name)) {
      setError('Invalid name. Use only alphanumeric, hyphens, underscores.');
      return;
    }

    setFlow({ type: 'new-workspace-creating', name });

    try {
      const config = readProjectConfig(state.currentProject);
      const baseDir = getProjectBaseDir(state.currentProject);
      const workspacesDir = getProjectWorkspacesDir(state.currentProject);
      const workspacePath = join(workspacesDir, name);

      if (existsSync(workspacePath)) {
        setError(`Workspace "${name}" already exists`);
        setFlow({ type: 'none' });
        return;
      }

      const existsRemotely = await checkRemoteBranch(baseDir, name);
      await createWorktree(baseDir, workspacePath, name, config.baseBranch, existsRemotely);

      // Build script options with bundle values and secrets
      const scriptOptions: RunScriptsOptions = {
        bundleValues: config.bundleValues,
      };
      if (config.bundleSecretKeys && config.bundleSecretKeys.length > 0) {
        scriptOptions.bundleSecrets = await getProjectSecrets(state.currentProject, config.bundleSecretKeys);
      }

      // Run pre and setup scripts during creation
      const preScriptsDir = getScriptsPhaseDir(state.currentProject, 'pre');
      const setupScriptsDir = getScriptsPhaseDir(state.currentProject, 'setup');
      renderer.suspend();
      try {
        await runScriptsInTerminal(preScriptsDir, workspacePath, name, config.repository, scriptOptions);
        await runScriptsInTerminal(setupScriptsDir, workspacePath, name, config.repository, scriptOptions);
        markSetupComplete(workspacePath);
      } finally {
        renderer.resume();
      }

      await loadWorkspacesForProject(state.currentProject);
      setFlow({ type: 'none' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create workspace');
      setFlow({ type: 'none' });
    }
  }, [state.currentProject, renderer, loadWorkspacesForProject]);

  // Handle delete
  const handleDelete = useCallback(async () => {
    if (flow.type !== 'confirm-delete') return;

    renderer.stop();
    process.stdout.write('\x1b[2J\x1b[H');

    try {
      if (flow.target.type === 'workspace') {
        if (!state.currentProject) return;
        await removeWorkspace(flow.target.name, { force: true });
        renderer.start();
        await loadWorkspacesForProject(state.currentProject);
      } else if (flow.target.type === 'project') {
        await removeProject(flow.target.name, { force: true });
        renderer.start();
        // Refresh projects list
        const projects = loadProjects();
        dispatch({ type: 'SET_PROJECTS', projects });
        // If we deleted the current project, clear selection
        if (state.currentProject === flow.target.name) {
          dispatch({ type: 'SET_CURRENT_PROJECT', project: null });
          dispatch({ type: 'SET_WORKSPACES', workspaces: [] });
          if (projects.length > 0) {
            dispatch({ type: 'SELECT_PROJECT', index: 0 });
          }
        }
      }
    } catch (err) {
      // Ignore errors
    }

    setFlow({ type: 'none' });
  }, [flow, state.currentProject, renderer, loadWorkspacesForProject]);

  // Keyboard handler
  useKeyboard(async (key) => {
    // Clear error on any key
    if (error && key.name !== 'escape') {
      setError(null);
    }

    // Handle flow states
    if (flow.type !== 'none') {
      if (key.name === 'escape') {
        setFlow({ type: 'none' });
        return;
      }

      // Help dialog
      if (flow.type === 'help') {
        setFlow({ type: 'none' });
        return;
      }

      // Confirm delete
      if (flow.type === 'confirm-delete') {
        if (key.name === 'y') await handleDelete();
        else if (key.name === 'n') setFlow({ type: 'none' });
        return;
      }

      // Workspace actions
      if (flow.type === 'workspace-actions') {
        if (key.name === 'o' || key.name === 'return' || key.name === 'enter') {
          setFlow({ type: 'none' });
          await onOpenShell(flow.projectName, flow.workspaceName);
          if (state.currentProject) {
            await loadWorkspacesForProject(state.currentProject);
          }
        } else if (key.name === 's') {
          // Re-run setup scripts
          const workspacesDir = getProjectWorkspacesDir(flow.projectName);
          const workspacePath = join(workspacesDir, flow.workspaceName);
          const config = readProjectConfig(flow.projectName);
          const setupScriptsDir = getScriptsPhaseDir(flow.projectName, 'setup');

          // Build script options with bundle values and secrets
          const scriptOptions: RunScriptsOptions = {
            bundleValues: config.bundleValues,
          };
          if (config.bundleSecretKeys && config.bundleSecretKeys.length > 0) {
            scriptOptions.bundleSecrets = await getProjectSecrets(flow.projectName, config.bundleSecretKeys);
          }

          setFlow({ type: 'none' });
          renderer.suspend();
          await runScriptsInTerminal(setupScriptsDir, workspacePath, flow.workspaceName, config.repository, scriptOptions);
          renderer.resume();

          if (state.currentProject) {
            await loadWorkspacesForProject(state.currentProject);
          }
        } else if (key.name === 'c') {
          setFlow({ type: 'none' });
        }
        return;
      }

      // New project select
      if (flow.type === 'new-project-select') {
        if (key.name === 'up' || key.name === 'k') {
          setFlow({ ...flow, selectedIndex: Math.max(0, flow.selectedIndex - 1) });
        } else if (key.name === 'down' || key.name === 'j') {
          setFlow({ ...flow, selectedIndex: Math.min(flow.repos.length - 1, flow.selectedIndex + 1) });
        } else if (key.name === 'return' || key.name === 'enter') {
          await handleCreateProject(flow.repos[flow.selectedIndex]);
        }
        return;
      }

      // Onboarding flow
      if (flow.type === 'new-project-onboarding') {
        const currentStepData = flow.steps[flow.currentStep];

        if (currentStepData.type === 'info') {
          // Info step: Enter to continue
          if (key.name === 'return' || key.name === 'enter') {
            await advanceOnboardingStep(flow);
          }
          return;
        }

        if (currentStepData.type === 'confirm') {
          // Confirm step: Enter to continue (if command found or no check), wait if checking
          if (flow.confirmStatus === 'checking') {
            // Still checking, ignore input
            return;
          }
          if (key.name === 'return' || key.name === 'enter') {
            await advanceOnboardingStep(flow);
          }
          return;
        }

        if (currentStepData.type === 'secret' || currentStepData.type === 'input') {
          // Input handled by input component - just return to let it handle keys
          return;
        }

        return;
      }

      // New workspace source selection
      if (flow.type === 'new-workspace-source') {
        const options = flow.hasLinear
          ? ['GitHub Branch', 'Linear Issue', 'Manual Name']
          : ['GitHub Branch', 'Manual Name'];

        if (key.name === 'up' || key.name === 'k') {
          setFlow({ ...flow, selectedIndex: Math.max(0, flow.selectedIndex - 1) });
        } else if (key.name === 'down' || key.name === 'j') {
          setFlow({ ...flow, selectedIndex: Math.min(options.length - 1, flow.selectedIndex + 1) });
        } else if (key.name === 'return' || key.name === 'enter') {
          const selected = options[flow.selectedIndex];
          if (selected === 'GitHub Branch') {
            await handleWorkspaceSourceSelect('branch');
          } else if (selected === 'Linear Issue') {
            await handleWorkspaceSourceSelect('linear');
          } else {
            await handleWorkspaceSourceSelect('manual');
          }
        }
        return;
      }

      // Branch selection
      if (flow.type === 'new-workspace-select-branch') {
        if (key.name === 'up' || key.name === 'k') {
          setFlow({ ...flow, selectedIndex: Math.max(0, flow.selectedIndex - 1) });
        } else if (key.name === 'down' || key.name === 'j') {
          setFlow({ ...flow, selectedIndex: Math.min(flow.branches.length - 1, flow.selectedIndex + 1) });
        } else if (key.name === 'return' || key.name === 'enter') {
          await createWorkspaceFromBranch(flow.branches[flow.selectedIndex]);
        }
        return;
      }

      // Linear issue selection
      if (flow.type === 'new-workspace-select-linear') {
        if (key.name === 'up' || key.name === 'k') {
          setFlow({ ...flow, selectedIndex: Math.max(0, flow.selectedIndex - 1) });
        } else if (key.name === 'down' || key.name === 'j') {
          setFlow({ ...flow, selectedIndex: Math.min(flow.issues.length - 1, flow.selectedIndex + 1) });
        } else if (key.name === 'return' || key.name === 'enter') {
          const issue = flow.issues[flow.selectedIndex];
          await createWorkspaceFromLinear(issue.identifier, issue.title);
        }
        return;
      }

      // Manual name input - let input component handle it
      if (flow.type === 'new-workspace-manual') {
        return;
      }

      return;
    }

    // Main view keyboard handling
    if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
      onQuit();
      return;
    }

    if (key.name === 'tab' || key.name === 'left' || key.name === 'right') {
      dispatch({ type: 'SWITCH_PANEL' });
      return;
    }

    if (key.name === 'up' || key.name === 'k') {
      dispatch({ type: 'MOVE_UP' });
      return;
    }

    if (key.name === 'down' || key.name === 'j') {
      dispatch({ type: 'MOVE_DOWN' });
      return;
    }

    if (key.name === 'return' || key.name === 'enter') {
      if (state.activePanel === 'projects' && state.projects.length > 0) {
        await handleSelectProject(state.selectedProjectIndex);
      } else if (state.activePanel === 'workspaces' && state.workspaces.length > 0 && state.currentProject) {
        const workspace = state.workspaces[state.selectedWorkspaceIndex];
        if (workspace) {
          setFlow({ type: 'workspace-actions', projectName: state.currentProject, workspaceName: workspace.name });
        }
      }
      return;
    }

    if (key.name === 'n') {
      if (state.activePanel === 'projects') {
        await startNewProjectFlow();
      } else if (state.currentProject) {
        startNewWorkspaceFlow();
      }
      return;
    }

    if (key.name === 'd') {
      if (state.activePanel === 'workspaces' && state.workspaces.length > 0) {
        const workspace = state.workspaces[state.selectedWorkspaceIndex];
        if (workspace) {
          setFlow({ type: 'confirm-delete', target: { type: 'workspace', name: workspace.name } });
        }
      } else if (state.activePanel === 'projects' && state.projects.length > 0) {
        const project = state.projects[state.selectedProjectIndex];
        if (project) {
          setFlow({ type: 'confirm-delete', target: { type: 'project', name: project.name } });
        }
      }
      return;
    }

    if (key.name === '?' || (key.shift && key.name === '/')) {
      setFlow({ type: 'help' });
      return;
    }

    if (key.name === 'r') {
      const projects = loadProjects();
      dispatch({ type: 'SET_PROJECTS', projects });
      if (state.currentProject) {
        await loadWorkspacesForProject(state.currentProject);
      }
      return;
    }
  });

  // Render flow dialogs
  const renderFlowDialog = () => {
    if (flow.type === 'none') return null;

    if (flow.type === 'help') {
      return (
        <Modal title="Keyboard Shortcuts" hint="Press any key to close" height={14}>
          <text fg={COLORS.text} paddingTop={1}>
            {[
              'Enter      Select / Open workspace',
              'Tab        Switch between panels',
              'Arrows/jk  Navigate list',
              'n          New project / workspace',
              'd          Delete selected workspace',
              'r          Refresh lists',
              '?          Show this help',
              'q          Quit',
            ].join('\n')}
          </text>
        </Modal>
      );
    }

    if (flow.type === 'confirm-delete') {
      const isProject = flow.target.type === 'project';
      const itemType = isProject ? 'project' : 'workspace';
      return (
        <Modal title="Confirm Delete" hint="[y] Yes  [n] No" height={7}>
          <text fg={COLORS.text} height={1} marginTop={1}>Delete {itemType} "{flow.target.name}"?</text>
          {isProject && <text fg={COLORS.error} height={1}>This will delete all workspaces!</text>}
        </Modal>
      );
    }

    if (flow.type === 'workspace-actions') {
      return (
        <Modal title={`Workspace: ${flow.workspaceName}`} hint="[o/Enter] Open  [s] Re-run Setup  [Esc] Cancel" height={6}>
          <text fg={COLORS.text} height={1} marginTop={1}>What would you like to do?</text>
        </Modal>
      );
    }

    if (flow.type === 'new-project-loading') {
      return (
        <Modal title="New Project" height={5}>
          <text fg={COLORS.loading} paddingTop={1}>Fetching repositories...</text>
        </Modal>
      );
    }

    if (flow.type === 'new-project-select') {
      const options = flow.repos.map(r => ({ name: r, value: r, description: '' }));
      return (
        <Modal title="Select Repository" hint="[Enter] Select  [Esc] Cancel" height={16}>
          <select
            options={options}
            focused
            selectedIndex={flow.selectedIndex}
            flexGrow={1}
            onChange={(idx) => setFlow({ ...flow, selectedIndex: idx })}
          />
        </Modal>
      );
    }

    if (flow.type === 'new-project-cloning') {
      return (
        <Modal title="New Project" height={5}>
          <text fg={COLORS.loading} paddingTop={1}>Cloning {flow.repo}...</text>
        </Modal>
      );
    }

    if (flow.type === 'new-project-onboarding') {
      const currentStepData = flow.steps[flow.currentStep];
      const stepProgress = `Step ${flow.currentStep + 1} of ${flow.steps.length}`;

      // Info step
      if (currentStepData.type === 'info') {
        return (
          <Modal title={currentStepData.title} hint={`[Enter] Continue  [Esc] Cancel  (${stepProgress})`} height={10} width={70}>
            <text fg={COLORS.text} paddingTop={1}>{currentStepData.description}</text>
          </Modal>
        );
      }

      // Confirm step
      if (currentStepData.type === 'confirm') {
        let statusText = '';
        let statusColor = COLORS.text;

        if (currentStepData.checkCommand) {
          if (flow.confirmStatus === 'checking') {
            statusText = `Checking for ${currentStepData.checkCommand}...`;
            statusColor = COLORS.loading;
          } else if (flow.confirmStatus === 'found') {
            statusText = `${currentStepData.checkCommand} is installed`;
            statusColor = COLORS.title;
          } else if (flow.confirmStatus === 'missing') {
            statusText = `${currentStepData.checkCommand} not found`;
            statusColor = COLORS.error;
          }
        }

        return (
          <Modal title={currentStepData.title} hint={flow.confirmStatus === 'checking' ? `Checking... (${stepProgress})` : `[Enter] Continue  [Esc] Cancel  (${stepProgress})`} height={12} width={70}>
            <text fg={COLORS.text} paddingTop={1}>{currentStepData.description}</text>
            {statusText && <text fg={statusColor} paddingTop={1}>{statusText}</text>}
            {flow.confirmStatus === 'missing' && currentStepData.installUrl && (
              <text fg={COLORS.textDim} paddingTop={1}>Install: {currentStepData.installUrl}</text>
            )}
          </Modal>
        );
      }

      // Secret step (stored securely via Bun.secrets)
      if (currentStepData.type === 'secret') {
        return (
          <Modal title={currentStepData.title} hint={`[Enter] Submit  [Esc] Cancel  (${stepProgress})`} height={11} width={70}>
            <text fg={COLORS.text} paddingTop={1}>{currentStepData.description}</text>
            <text fg={COLORS.textDim}>(Secret will be stored securely in OS keychain)</text>
            <input
              placeholder="Enter value"
              focused
              value={flow.inputValue}
              onInput={(v) => setFlow({ ...flow, inputValue: v })}
              onSubmit={async (v) => {
                if (!v.trim()) return;
                // Store secret via Bun.secrets
                await setProjectSecret(flow.projectName, currentStepData.configKey, v);
                const newSecretKeys = [...flow.collectedSecretKeys, currentStepData.configKey];
                await advanceOnboardingStep({ ...flow, collectedSecretKeys: newSecretKeys });
              }}
            />
          </Modal>
        );
      }

      // Input step (regular input)
      if (currentStepData.type === 'input') {
        return (
          <Modal title={currentStepData.title} hint={`[Enter] Submit  [Esc] Cancel  (${stepProgress})`} height={10} width={70}>
            <text fg={COLORS.text} paddingTop={1}>{currentStepData.description}</text>
            <input
              placeholder={currentStepData.defaultValue || 'Enter value'}
              focused
              value={flow.inputValue}
              onInput={(v) => setFlow({ ...flow, inputValue: v })}
              onSubmit={async (v) => {
                const value = v.trim() || currentStepData.defaultValue || '';
                const newValues = { ...flow.collectedValues, [currentStepData.configKey]: value };
                await advanceOnboardingStep({ ...flow, collectedValues: newValues });
              }}
            />
          </Modal>
        );
      }

      // Fallback
      return (
        <Modal title="Bundle Onboarding" height={6}>
          <text fg={COLORS.loading} paddingTop={1}>Processing step...</text>
        </Modal>
      );
    }

    if (flow.type === 'new-workspace-source') {
      const options = flow.hasLinear
        ? [{ name: 'GitHub Branch', description: 'Create from existing remote branch' }, { name: 'Linear Issue', description: 'Create from Linear ticket' }, { name: 'Manual Name', description: 'Enter a custom name' }]
        : [{ name: 'GitHub Branch', description: 'Create from existing remote branch' }, { name: 'Manual Name', description: 'Enter a custom name' }];
      return (
        <Modal title="Create Workspace From" hint="[Enter] Select  [Esc] Cancel" height={12}>
          <select
            options={options}
            focused
            selectedIndex={flow.selectedIndex}
            showDescription
            flexGrow={1}
            onChange={(idx) => setFlow({ ...flow, selectedIndex: idx })}
          />
        </Modal>
      );
    }

    if (flow.type === 'new-workspace-loading') {
      const msg = flow.source === 'branch' ? 'Fetching branches...' : 'Fetching Linear issues...';
      return (
        <Modal title="New Workspace" height={5}>
          <text fg={COLORS.loading} paddingTop={1}>{msg}</text>
        </Modal>
      );
    }

    if (flow.type === 'new-workspace-select-branch') {
      const options = flow.branches.map(b => ({ name: b, value: b, description: '' }));
      return (
        <Modal title="Select Branch" hint="[Enter] Select  [Esc] Cancel" height={16}>
          <select
            options={options}
            focused
            selectedIndex={flow.selectedIndex}
            flexGrow={1}
            onChange={(idx) => setFlow({ ...flow, selectedIndex: idx })}
          />
        </Modal>
      );
    }

    if (flow.type === 'new-workspace-select-linear') {
      const options = flow.issues.map(i => ({ name: `${i.identifier} - ${i.title}`, value: i.identifier, description: '' }));
      return (
        <Modal title="Select Linear Issue" hint="[Enter] Select  [Esc] Cancel" height={16}>
          <select
            options={options}
            focused
            selectedIndex={flow.selectedIndex}
            flexGrow={1}
            onChange={(idx) => setFlow({ ...flow, selectedIndex: idx })}
          />
        </Modal>
      );
    }

    if (flow.type === 'new-workspace-manual') {
      return (
        <Modal title="New Workspace" hint="[Enter] Create  [Esc] Cancel" height={7}>
          <text fg={COLORS.textDim} paddingTop={1}>Enter workspace name:</text>
          <input
            placeholder="my-feature"
            focused
            value={flow.inputValue}
            onInput={(v) => setFlow({ ...flow, inputValue: v })}
            onSubmit={(v) => createWorkspaceManual(v)}
          />
        </Modal>
      );
    }

    if (flow.type === 'new-workspace-creating') {
      return (
        <Modal title="New Workspace" height={5}>
          <text fg={COLORS.loading} paddingTop={1}>Creating {flow.name}...</text>
        </Modal>
      );
    }

    return null;
  };

  return (
    <box flexDirection="column" width="100%" height="100%">
      <Header />

      <box flexDirection="row" flexGrow={1} width="100%" gap={1} paddingLeft={1} paddingRight={1}>
        <ProjectPanel
          projects={state.projects}
          selectedIndex={state.selectedProjectIndex}
          focused={state.activePanel === 'projects' && flow.type === 'none'}
          onNavigate={(index) => dispatch({ type: 'SELECT_PROJECT', index })}
        />
        <WorkspacePanel
          workspaces={state.workspaces}
          selectedIndex={state.selectedWorkspaceIndex}
          focused={state.activePanel === 'workspaces' && flow.type === 'none'}
          projectName={state.currentProject}
          onSelect={(index) => dispatch({ type: 'SELECT_WORKSPACE', index })}
        />
      </box>

      {error && (
        <box width="100%" height={1} backgroundColor={COLORS.error}>
          <text fg={COLORS.text}> Error: {error}</text>
        </box>
      )}

      <StatusBar activePanel={state.activePanel} />

      {renderFlowDialog()}
    </box>
  );
}

/**
 * Launch the TUI
 */
export async function launchTUI(): Promise<void> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 30,
  });

  const cleanup = () => {
    if (renderer && !renderer.isDestroyed) {
      renderer.destroy();
    }
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('exit', cleanup);

  const handleQuit = () => {
    renderer.destroy();
    process.exit(0);
  };

  const handleOpenShell = async (projectName: string, workspaceName: string) => {
    const workspacesDir = getProjectWorkspacesDir(projectName);
    const workspacePath = join(workspacesDir, workspaceName);
    const config = readProjectConfig(projectName);

    renderer.suspend();

    try {
      // TUI handles setup during creation, so just run select scripts
      await openWorkspaceShell(workspacePath, projectName, config.repository, false, true);
    } catch (err) {
      // Ignore
    }

    renderer.resume();
  };

  createRoot(renderer).render(<App onQuit={handleQuit} onOpenShell={handleOpenShell} />);
}

export class SpacesTUI {
  async start(): Promise<void> {
    await launchTUI();
  }
}
