/**
 * Main TUI application using @opentui/react
 * Two-panel layout with projects on left, workspaces on right
 */

import { createCliRenderer } from '@opentui/core';
import { createRoot, useKeyboard, useRenderer } from '@opentui/react';
import { useState, useEffect, useCallback, useReducer } from 'react';
import { spawn } from 'child_process';
import {
  loadProjects,
  loadWorkspaces,
  loadInbox,
  stateReducer,
  createInitialState,
  buildTree,
  type ProjectState,
  type WorkspaceState,
  type TreeItem,
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
// Import WorkspaceSession type for flow state
import type { WorkspaceSession } from './state.js';

type FlowState =
  | { type: 'none' }
  | { type: 'help' }
  | { type: 'inbox'; selectedIndex: number; viewingSessionId: string | null }
  | { type: 'confirm-delete'; target: { type: 'workspace'; name: string } | { type: 'project'; name: string } | { type: 'session'; session: WorkspaceSession; workspaceName: string }; inputValue: string }
  | { type: 'confirm-steal'; session: WorkspaceSession; workspace: WorkspaceState }
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
  | { type: 'new-workspace-creating'; name: string }
  // New Session flow
  | { type: 'new-session-name'; workspace: WorkspaceState; inputValue: string }
  | { type: 'new-session-creating'; workspace: WorkspaceState; sessionName: string };

// Helper to format relative time
function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

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

// Import InboxItem type
import type { InboxItem } from '../lib/tmux-lite/cli.js';

// Helper to parse session name into project/workspace/session
// Format: project:workspace:sessionName
function parseSessionName(sessionName: string): { project: string; workspace: string; session: string } {
  const parts = sessionName.split(':');
  return {
    project: parts[0] || sessionName,
    workspace: parts[1] || sessionName,
    session: parts[2] || sessionName,
  };
}

// Helper to get icon for inbox item type
function getInboxIcon(item: InboxItem): string {
  if (item.type === 'exit') return item.exitCode === 0 ? '✅' : '❌';
  if (item.type === 'title') return '📝';
  if (item.type === 'idle') return '⏸️';
  return '🔔';
}

function getInboxTypeLabel(item: InboxItem): string {
  if (item.type === 'exit') return item.exitCode === 0 ? 'Completed' : `Exit code ${item.exitCode}`;
  if (item.type === 'title') return 'Title Change';
  if (item.type === 'idle') return 'Activity Complete';
  return 'Bell';
}

// Helper to group inbox items by project
function groupInboxByProject(items: InboxItem[]): Map<string, InboxItem[]> {
  const groups = new Map<string, InboxItem[]>();
  for (const item of items) {
    const { project } = parseSessionName(item.sessionName);
    if (!groups.has(project)) {
      groups.set(project, []);
    }
    groups.get(project)!.push(item);
  }
  return groups;
}

// Hierarchical grouping: project → workspace → session → items
interface SessionGroup {
  session: string;
  items: InboxItem[];
}

interface WorkspaceGroup {
  workspace: string;
  sessions: SessionGroup[];
  totalItems: number;
}

interface ProjectGroup {
  project: string;
  workspaces: WorkspaceGroup[];
  totalItems: number;
}

function groupInboxHierarchically(items: InboxItem[]): ProjectGroup[] {
  // Sort all items by timestamp (most recent first)
  const sortedItems = [...items].sort((a, b) => b.timestamp - a.timestamp);

  // Three-level grouping: project → workspace → session
  const projectMap = new Map<string, Map<string, Map<string, InboxItem[]>>>();
  const projectLatest = new Map<string, number>();
  const workspaceLatest = new Map<string, number>();
  const sessionLatest = new Map<string, number>();

  for (const item of sortedItems) {
    const { project, workspace, session } = parseSessionName(item.sessionName);
    const wsKey = `${project}:${workspace}`;
    const sessKey = `${project}:${workspace}:${session}`;

    // Track latest timestamp for sorting groups
    if (!projectLatest.has(project) || item.timestamp > projectLatest.get(project)!) {
      projectLatest.set(project, item.timestamp);
    }
    if (!workspaceLatest.has(wsKey) || item.timestamp > workspaceLatest.get(wsKey)!) {
      workspaceLatest.set(wsKey, item.timestamp);
    }
    if (!sessionLatest.has(sessKey) || item.timestamp > sessionLatest.get(sessKey)!) {
      sessionLatest.set(sessKey, item.timestamp);
    }

    if (!projectMap.has(project)) {
      projectMap.set(project, new Map());
    }
    const workspaceMap = projectMap.get(project)!;

    if (!workspaceMap.has(workspace)) {
      workspaceMap.set(workspace, new Map());
    }
    const sessionMap = workspaceMap.get(workspace)!;

    if (!sessionMap.has(session)) {
      sessionMap.set(session, []);
    }
    sessionMap.get(session)!.push(item);
  }

  const result: ProjectGroup[] = [];
  for (const [project, workspaceMap] of projectMap) {
    const workspaces: WorkspaceGroup[] = [];
    let projectTotal = 0;

    for (const [workspace, sessionMap] of workspaceMap) {
      const sessions: SessionGroup[] = [];
      let workspaceTotal = 0;

      for (const [session, sessionItems] of sessionMap) {
        sessions.push({ session, items: sessionItems });
        workspaceTotal += sessionItems.length;
      }

      // Sort sessions by most recent
      const wsKey = `${project}:${workspace}`;
      sessions.sort((a, b) => {
        const aKey = `${wsKey}:${a.session}`;
        const bKey = `${wsKey}:${b.session}`;
        return (sessionLatest.get(bKey) || 0) - (sessionLatest.get(aKey) || 0);
      });

      workspaces.push({ workspace, sessions, totalItems: workspaceTotal });
      projectTotal += workspaceTotal;
    }

    // Sort workspaces by most recent
    workspaces.sort((a, b) => {
      const aKey = `${project}:${a.workspace}`;
      const bKey = `${project}:${b.workspace}`;
      return (workspaceLatest.get(bKey) || 0) - (workspaceLatest.get(aKey) || 0);
    });

    result.push({ project, workspaces, totalItems: projectTotal });
  }

  // Sort projects by most recent
  result.sort((a, b) => (projectLatest.get(b.project) || 0) - (projectLatest.get(a.project) || 0));

  return result;
}

type InboxDisplayItem =
  | { type: 'project-header'; project: string; totalItems: number }
  | { type: 'workspace-header'; workspace: string; itemCount: number; isFirstWorkspace: boolean }
  | { type: 'session-header'; session: string; itemCount: number; isFirstSession: boolean }
  | { type: 'item'; item: InboxItem; flatIndex: number };

function buildInboxDisplay(items: InboxItem[]): { displayItems: InboxDisplayItem[]; flatItems: InboxItem[] } {
  const hierarchical = groupInboxHierarchically(items);
  const displayItems: InboxDisplayItem[] = [];
  const flatItems: InboxItem[] = [];
  let flatIndex = 0;

  for (const projectGroup of hierarchical) {
    displayItems.push({
      type: 'project-header',
      project: projectGroup.project,
      totalItems: projectGroup.totalItems
    });

    projectGroup.workspaces.forEach((wsGroup, wsIdx) => {
      displayItems.push({
        type: 'workspace-header',
        workspace: wsGroup.workspace,
        itemCount: wsGroup.totalItems,
        isFirstWorkspace: wsIdx === 0
      });

      wsGroup.sessions.forEach((sessGroup, sessIdx) => {
        displayItems.push({
          type: 'session-header',
          session: sessGroup.session,
          itemCount: sessGroup.items.length,
          isFirstSession: sessIdx === 0
        });

        for (const item of sessGroup.items) {
          displayItems.push({ type: 'item', item, flatIndex });
          flatItems.push(item);
          flatIndex++;
        }
      });
    });
  }

  return { displayItems, flatItems };
}

function getSessionItems(items: InboxItem[], sessionId: string): InboxItem[] {
  return items
    .filter(item => item.sessionId === sessionId)
    .sort((a, b) => b.timestamp - a.timestamp);
}

// Header component with ASCII art on left and compact inbox badge on right
function Header({ inbox, unreadCount }: { inbox: InboxItem[]; unreadCount: number }) {
  // Build summary: one line per workspace with notifications
  const workspaceNotifications: Array<{ project: string; workspace: string; icons: string; count: number }> = [];
  const wsMap = new Map<string, { project: string; workspace: string; items: InboxItem[] }>();

  for (const item of inbox) {
    const { project, workspace } = parseSessionName(item.sessionName);
    const key = `${project}:${workspace}`;
    if (!wsMap.has(key)) {
      wsMap.set(key, { project, workspace, items: [] });
    }
    wsMap.get(key)!.items.push(item);
  }

  for (const [, data] of wsMap) {
    const icons = data.items.slice(0, 3).map(getInboxIcon).join('');
    workspaceNotifications.push({
      project: data.project,
      workspace: data.workspace,
      icons,
      count: data.items.length,
    });
  }

  return (
    <box flexDirection="row" width="100%" height={14}>
      {/* ASCII art on left - fixed width to prevent compression */}
      <box flexDirection="column" alignItems="flex-start" paddingLeft={1} width={68}>
        {ASCII_LINES.map((line, i) => (
          <text key={i} fg={line.color}>{line.text}</text>
        ))}
        <text fg={COLORS.textDim}> v{VERSION}</text>
      </box>

      {/* Compact inbox badge on right */}
      <box flexDirection="column" flexGrow={1} paddingLeft={2} paddingTop={2}>
        {unreadCount > 0 ? (
          <box flexDirection="column">
            <text fg={COLORS.title} height={1}>📥 {unreadCount} new notification{unreadCount > 1 ? 's' : ''}</text>
            <text fg={COLORS.textDim} height={1}>[i] view inbox</text>
            <text height={1}> </text>
            {workspaceNotifications.slice(0, 6).map((ws, i) => (
              <text key={i} fg={COLORS.text} height={1}>
                {ws.icons} {ws.project}/{ws.workspace}
              </text>
            ))}
            {workspaceNotifications.length > 6 && (
              <text fg={COLORS.textDim} height={1}>  +{workspaceNotifications.length - 6} more</text>
            )}
          </box>
        ) : (
          <box flexDirection="column">
            <text fg={COLORS.textDim} height={1}>📥 No notifications</text>
            <text fg={COLORS.textDim} height={1}>[i] view inbox</text>
          </box>
        )}
      </box>
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

// Workspace tree panel component
function WorkspaceTreePanel({
  workspaces,
  expandedWorkspaces,
  selectedTreeIndex,
  focused,
  projectName,
}: {
  workspaces: WorkspaceState[];
  expandedWorkspaces: Set<string>;
  selectedTreeIndex: number;
  focused: boolean;
  projectName: string | null;
}) {
  const tree = buildTree(workspaces, expandedWorkspaces);

  const renderTreeItem = (item: TreeItem, index: number) => {
    const isSelected = index === selectedTreeIndex && focused;
    const prefix = isSelected ? '> ' : '  ';

    if (item.type === 'workspace') {
      const ws = item.workspace;
      const expandIcon = expandedWorkspaces.has(ws.name) ? '▼' : '▶';
      let status = ws.uncommittedChanges > 0 ? `${ws.uncommittedChanges} chg` : 'clean';
      if (ws.isStale) status += ' (stale)';
      const branchInfo = `[${ws.branch}]`;
      const sessionCount = ws.sessions.length > 0 ? ` (${ws.sessions.length})` : '';

      return (
        <text
          key={`ws-${ws.name}`}
          fg={isSelected ? COLORS.selected : COLORS.text}
          height={1}
        >
          {prefix}{expandIcon} {ws.name} {branchInfo} {status}{sessionCount}
        </text>
      );
    }

    if (item.type === 'session') {
      const session = item.session;
      const statusIcon = session.attached ? '🟢' : '⚪';
      const title = session.processTitle || '(shell)';
      const sessionNum = session.name.split(':').pop() || session.id;

      return (
        <text
          key={`sess-${session.id}`}
          fg={isSelected ? COLORS.selected : COLORS.textDim}
          height={1}
        >
          {prefix}    {statusIcon} #{sessionNum}: {title}
        </text>
      );
    }

    if (item.type === 'new-session') {
      return (
        <text
          key={`new-${item.workspace.name}`}
          fg={isSelected ? COLORS.selected : COLORS.textDim}
          height={1}
        >
          {prefix}    + New session
        </text>
      );
    }

    return null;
  };

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
      <box flexDirection="column" paddingLeft={1} paddingTop={1} flexGrow={1}>
        {workspaces.length > 0 ? (
          tree.map((item, idx) => renderTreeItem(item, idx))
        ) : (
          <text fg={COLORS.textDim}>
            {projectName ? 'No workspaces. Press [n] to create one.' : 'Select a project'}
          </text>
        )}
      </box>
    </box>
  );
}

// Status bar component
function StatusBar({ activePanel }: { activePanel: 'projects' | 'workspaces' }) {
  const newAction = activePanel === 'projects' ? 'New Project' : 'New Workspace';
  return (
    <box width="100%" height={1} backgroundColor={COLORS.statusBar}>
      <text fg={COLORS.textDim}>
        {` [Arrows] Navigate  [Tab] Switch  [Enter] Open/Expand  [n] ${newAction}  [d] Delete  [i] Inbox  [?] Help  [q] Quit`}
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
      >
        <text fg={COLORS.title} height={1} paddingLeft={1} paddingTop={1}>{title}</text>
        <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
          {children}
        </box>
        {hint && (
          <box height={1} backgroundColor={COLORS.statusBar} width="100%">
            <text fg={COLORS.textDim} paddingLeft={1}>{hint}</text>
          </box>
        )}
      </box>
    </box>
  );
}

// Main App component
function App({ onQuit, onOpenShell }: { onQuit: () => void; onOpenShell: (projectName: string, workspaceName: string, sessionName: string) => Promise<void> }) {
  const [state, dispatch] = useReducer(stateReducer, createInitialState());
  const [flow, setFlow] = useState<FlowState>({ type: 'none' });
  const [error, setError] = useState<string | null>(null);
  const renderer = useRenderer();

  // Load initial data
  useEffect(() => {
    const load = async () => {
      const projects = loadProjects();
      dispatch({ type: 'SET_PROJECTS', projects });

      // Load inbox
      const { items: inboxItems, unreadCount } = await loadInbox();
      dispatch({ type: 'SET_INBOX', inbox: inboxItems, unreadCount });

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

  // Poll inbox every 3 seconds for sync across TUI instances
  useEffect(() => {
    const pollInbox = async () => {
      try {
        const { items: inboxItems, unreadCount } = await loadInbox();
        dispatch({ type: 'SET_INBOX', inbox: inboxItems, unreadCount });
      } catch {
        // Server might not be running, ignore
      }
    };

    const interval = setInterval(pollInbox, 3000);
    return () => clearInterval(interval);
  }, []);

  // Load workspaces when project changes
  const loadWorkspacesForProject = useCallback(async (projectName: string) => {
    const workspaces = await loadWorkspaces(projectName);
    dispatch({ type: 'SET_WORKSPACES', workspaces });
  }, []);

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

    try {
      if (flow.target.type === 'session') {
        // Kill session via tmux-lite
        const { killSession } = await import('../lib/tmux-lite/cli.js');
        await killSession(flow.target.session.id);
        if (state.currentProject) {
          await loadWorkspacesForProject(state.currentProject);
        }
      } else if (flow.target.type === 'workspace') {
        if (!state.currentProject) return;
        renderer.stop();
        process.stdout.write('\x1b[2J\x1b[H');
        await removeWorkspace(flow.target.name, { force: true });
        renderer.start();
        await loadWorkspacesForProject(state.currentProject);
      } else if (flow.target.type === 'project') {
        renderer.stop();
        process.stdout.write('\x1b[2J\x1b[H');
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

      // Inbox dialog
      if (flow.type === 'inbox') {
        const items = state.inbox;
        const { flatItems } = buildInboxDisplay(items);

        // If viewing a session thread
        if (flow.viewingSessionId) {
          const sessionItems = getSessionItems(items, flow.viewingSessionId);
          const sessionId = flow.viewingSessionId;

          // Escape goes back to list
          if (key.name === 'escape') {
            setFlow({ ...flow, viewingSessionId: null });
            return;
          }

          // 'a' attaches to session
          if (key.name === 'a') {
            const { clearInbox, listSessions } = await import('../lib/tmux-lite/cli.js');
            const sessions = await listSessions();
            const session = sessions.find(s => s.id === sessionId);

            if (session) {
              setFlow({ type: 'none' });

              const cliPath = new URL('../lib/tmux-lite/cli.ts', import.meta.url).pathname;
              renderer.suspend();
              const proc = spawn('bun', ['run', cliPath, 'attach', session.id, '-f'], { stdio: 'inherit' });
              await new Promise<void>((resolve) => proc.on('exit', () => resolve()));
              renderer.resume();

              for (const item of sessionItems) {
                await clearInbox(item.id);
              }

              if (state.currentProject) {
                await loadWorkspacesForProject(state.currentProject);
              }
              const { items: newItems, unreadCount } = await loadInbox();
              dispatch({ type: 'SET_INBOX', inbox: newItems, unreadCount });
            } else {
              setError('Session no longer exists');
              for (const item of sessionItems) {
                await clearInbox(item.id);
              }
              const { items: newItems, unreadCount } = await loadInbox();
              dispatch({ type: 'SET_INBOX', inbox: newItems, unreadCount });
              setFlow({ ...flow, viewingSessionId: null });
            }
            return;
          }

          // 'x' deletes this session's notifications
          if (key.name === 'x') {
            const { clearInbox } = await import('../lib/tmux-lite/cli.js');
            for (const item of sessionItems) {
              await clearInbox(item.id);
            }
            const { items: newItems, unreadCount } = await loadInbox();
            dispatch({ type: 'SET_INBOX', inbox: newItems, unreadCount });
            // Adjust selection and go back to list
            const newIndex = flow.selectedIndex >= newItems.length ? Math.max(0, newItems.length - 1) : flow.selectedIndex;
            setFlow({ ...flow, viewingSessionId: null, selectedIndex: newIndex });
            return;
          }

          return;
        }

        // List view handlers
        // Navigation
        if (key.name === 'up' || key.name === 'k') {
          setFlow({ ...flow, selectedIndex: Math.max(0, flow.selectedIndex - 1) });
          return;
        }
        if (key.name === 'down' || key.name === 'j') {
          const maxIndex = Math.max(0, flatItems.length - 1);
          setFlow({ ...flow, selectedIndex: Math.min(maxIndex, flow.selectedIndex + 1) });
          return;
        }

        // Enter opens detail view
        if ((key.name === 'return' || key.name === 'enter') && flatItems.length > 0) {
          const item = flatItems[flow.selectedIndex];
          if (item) {
            const sessionItems = items.filter(inboxItem => inboxItem.sessionId === item.sessionId);
            const unreadItems = sessionItems.filter(inboxItem => !inboxItem.read);

            // Mark thread as read when viewing
            if (unreadItems.length > 0) {
              const { markInboxRead } = await import('../lib/tmux-lite/cli.js');
              for (const unreadItem of unreadItems) {
                await markInboxRead(unreadItem.id);
              }
              const { items: newItems, unreadCount } = await loadInbox();
              dispatch({ type: 'SET_INBOX', inbox: newItems, unreadCount });
            }
            setFlow({ ...flow, viewingSessionId: item.sessionId });
          }
          return;
        }

        // Clear all
        if (key.name === 'c') {
          const { clearInbox } = await import('../lib/tmux-lite/cli.js');
          await clearInbox();
          dispatch({ type: 'SET_INBOX', inbox: [], unreadCount: 0 });
          setFlow({ type: 'none' });
          return;
        }

        // Delete selected item from list
        if (key.name === 'x' && flatItems.length > 0) {
          const item = flatItems[flow.selectedIndex];
          if (item) {
            const { clearInbox } = await import('../lib/tmux-lite/cli.js');
            await clearInbox(item.id);
            const { items: newItems, unreadCount } = await loadInbox();
            dispatch({ type: 'SET_INBOX', inbox: newItems, unreadCount });
            if (flow.selectedIndex >= newItems.length && newItems.length > 0) {
              setFlow({ ...flow, selectedIndex: newItems.length - 1 });
            }
          }
          return;
        }

        return;
      }

      // Confirm delete - for sessions use y/n, for projects/workspaces require typing name
      if (flow.type === 'confirm-delete') {
        if (flow.target.type === 'session') {
          // Quick y/n for sessions
          if (key.name === 'y') await handleDelete();
          else if (key.name === 'n') setFlow({ type: 'none' });
        }
        // For projects/workspaces, let input component handle it
        return;
      }

      // Confirm steal session
      if (flow.type === 'confirm-steal') {
        if (key.name === 'y') {
          // Force attach to steal
          const cliPath = new URL('../lib/tmux-lite/cli.ts', import.meta.url).pathname;
          setFlow({ type: 'none' });
          renderer.suspend();
          const proc = spawn('bun', ['run', cliPath, 'attach', flow.session.id, '-f'], { stdio: 'inherit' });
          await new Promise<void>((resolve) => proc.on('exit', () => resolve()));
          renderer.resume();

          // Refresh
          if (state.currentProject) {
            await loadWorkspacesForProject(state.currentProject);
            const { items: inboxItems, unreadCount } = await loadInbox();
            dispatch({ type: 'SET_INBOX', inbox: inboxItems, unreadCount });
          }
        } else if (key.name === 'n') {
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

      // Session name input - let input component handle it
      if (flow.type === 'new-session-name') {
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
      if (state.activePanel === 'projects' && state.projects.length > 0) {
        const newIndex = Math.max(0, state.selectedProjectIndex - 1);
        if (newIndex !== state.selectedProjectIndex) {
          dispatch({ type: 'SELECT_PROJECT', index: newIndex });
          // Auto-load workspaces for highlighted project
          const project = state.projects[newIndex];
          if (project) {
            dispatch({ type: 'SET_CURRENT_PROJECT', project: project.name });
            setCurrentProject(project.name);
            loadWorkspacesForProject(project.name);
          }
        }
      } else {
        dispatch({ type: 'MOVE_UP' });
      }
      return;
    }

    if (key.name === 'down' || key.name === 'j') {
      if (state.activePanel === 'projects' && state.projects.length > 0) {
        const newIndex = Math.min(state.projects.length - 1, state.selectedProjectIndex + 1);
        if (newIndex !== state.selectedProjectIndex) {
          dispatch({ type: 'SELECT_PROJECT', index: newIndex });
          // Auto-load workspaces for highlighted project
          const project = state.projects[newIndex];
          if (project) {
            dispatch({ type: 'SET_CURRENT_PROJECT', project: project.name });
            setCurrentProject(project.name);
            loadWorkspacesForProject(project.name);
          }
        }
      } else {
        dispatch({ type: 'MOVE_DOWN' });
      }
      return;
    }

    if (key.name === 'return' || key.name === 'enter') {
      if (state.activePanel === 'projects' && state.projects.length > 0) {
        // Switch to workspaces panel
        dispatch({ type: 'SET_ACTIVE_PANEL', panel: 'workspaces' });
      } else if (state.activePanel === 'workspaces' && state.workspaces.length > 0 && state.currentProject) {
        const tree = buildTree(state.workspaces, state.expandedWorkspaces);
        const item = tree[state.selectedTreeIndex];

        if (item) {
          if (item.type === 'workspace') {
            // Toggle expand/collapse
            dispatch({ type: 'TOGGLE_WORKSPACE', workspaceName: item.workspace.name });
          } else if (item.type === 'session') {
            // Attach to session directly
            const session = item.session;
            if (session.attached) {
              // Session is attached elsewhere, show steal confirmation
              setFlow({
                type: 'confirm-steal',
                session,
                workspace: item.workspace,
              });
            } else {
              // Attach directly
              const cliPath = new URL('../lib/tmux-lite/cli.ts', import.meta.url).pathname;
              renderer.suspend();
              const proc = spawn('bun', ['run', cliPath, 'attach', session.id], { stdio: 'inherit' });
              await new Promise<void>((resolve) => proc.on('exit', () => resolve()));
              renderer.resume();

              // Refresh
              await loadWorkspacesForProject(state.currentProject);
              const { items: inboxItems, unreadCount } = await loadInbox();
              dispatch({ type: 'SET_INBOX', inbox: inboxItems, unreadCount });
            }
          } else if (item.type === 'new-session') {
            // Show session name input flow
            setFlow({ type: 'new-session-name', workspace: item.workspace, inputValue: '' });
          }
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
        const tree = buildTree(state.workspaces, state.expandedWorkspaces);
        const item = tree[state.selectedTreeIndex];

        if (item) {
          if (item.type === 'workspace') {
            setFlow({ type: 'confirm-delete', target: { type: 'workspace', name: item.workspace.name }, inputValue: '' });
          } else if (item.type === 'session') {
            setFlow({ type: 'confirm-delete', target: { type: 'session', session: item.session, workspaceName: item.workspace.name }, inputValue: '' });
          }
          // Can't delete 'new-session' item
        }
      } else if (state.activePanel === 'projects' && state.projects.length > 0) {
        const project = state.projects[state.selectedProjectIndex];
        if (project) {
          setFlow({ type: 'confirm-delete', target: { type: 'project', name: project.name }, inputValue: '' });
        }
      }
      return;
    }

    if (key.name === '?' || (key.shift && key.name === '/')) {
      setFlow({ type: 'help' });
      return;
    }

    if (key.name === 'i') {
      setFlow({ type: 'inbox', selectedIndex: 0, viewingSessionId: null });
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
              'i          Show inbox',
              'r          Refresh lists',
              '?          Show this help',
              'q          Quit',
            ].join('\n')}
          </text>
        </Modal>
      );
    }

    // Inbox is rendered as full-screen, not a modal - handled in main render
    if (flow.type === 'inbox') {
      return null;
    }

    if (flow.type === 'confirm-delete') {
      let itemType: string;
      let itemName: string;
      let warning: string | null = null;

      if (flow.target.type === 'project') {
        itemType = 'project';
        itemName = flow.target.name;
        warning = 'This will delete all workspaces!';
      } else if (flow.target.type === 'workspace') {
        itemType = 'workspace';
        itemName = flow.target.name;
        warning = 'This will delete all sessions in this workspace!';
      } else {
        itemType = 'session';
        const sessionNum = flow.target.session.name.split(':').pop() || flow.target.session.id;
        itemName = `#${sessionNum}`;
      }

      // For sessions, use simple y/n confirmation
      if (flow.target.type === 'session') {
        return (
          <Modal title="Confirm Delete" hint="[y] Yes  [n] No" height={6}>
            <text fg={COLORS.text} height={1} marginTop={1}>Delete {itemType} "{itemName}"?</text>
          </Modal>
        );
      }

      // For projects and workspaces, require typing the name
      const handleDeleteWithConfirmation = async (typedName: string) => {
        if (typedName.trim() === itemName) {
          await handleDelete();
        } else {
          setError(`Name doesn't match. Type "${itemName}" to confirm.`);
        }
      };

      return (
        <Modal title="Confirm Delete" hint="[Enter] Delete  [Esc] Cancel" height={11}>
          <box flexDirection="column" flexGrow={1}>
            <text fg={COLORS.error} height={1} marginTop={1}>{warning}</text>
            <text height={1}> </text>
            <text fg={COLORS.text} height={1}>Type "{itemName}" to confirm:</text>
            <text height={1}> </text>
            <input
              placeholder={itemName}
              focused
              value={flow.inputValue}
              onInput={(v) => setFlow({ ...flow, inputValue: v })}
              onSubmit={handleDeleteWithConfirmation}
            />
          </box>
        </Modal>
      );
    }

    if (flow.type === 'confirm-steal') {
      const sessionNum = flow.session.name.split(':').pop() || flow.session.id;
      const title = flow.session.processTitle || '(shell)';
      return (
        <Modal title="Steal Session?" hint="[y] Yes  [n] No" height={8}>
          <text fg={COLORS.text} height={1} marginTop={1}>Session #{sessionNum} is attached elsewhere.</text>
          <text fg={COLORS.textDim} height={1}>Running: {title}</text>
          <text fg={COLORS.loading} height={1}>Steal this session?</text>
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
          <Modal title={currentStepData.title} hint={`[Enter] Submit  [Esc] Cancel  (${stepProgress})`} height={12} width={70}>
            <box flexDirection="column" flexGrow={1}>
              <text fg={COLORS.text} height={1} marginTop={1}>{currentStepData.description}</text>
              <text fg={COLORS.textDim} height={1}>(Secret will be stored securely in OS keychain)</text>
              <text height={1}> </text>
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
            </box>
          </Modal>
        );
      }

      // Input step (regular input)
      if (currentStepData.type === 'input') {
        return (
          <Modal title={currentStepData.title} hint={`[Enter] Submit  [Esc] Cancel  (${stepProgress})`} height={11} width={70}>
            <box flexDirection="column" flexGrow={1}>
              <text fg={COLORS.text} height={1} marginTop={1}>{currentStepData.description}</text>
              <text height={1}> </text>
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
            </box>
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
        <Modal title="New Workspace" hint="[Enter] Create  [Esc] Cancel" height={9}>
          <box flexDirection="column" flexGrow={1}>
            <text fg={COLORS.textDim} height={1} marginTop={1}>Enter workspace name:</text>
            <text height={1}> </text>
            <input
              placeholder="my-feature"
              focused
              value={flow.inputValue}
              onInput={(v) => setFlow({ ...flow, inputValue: v })}
              onSubmit={(v) => createWorkspaceManual(v)}
            />
          </box>
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

    if (flow.type === 'new-session-name') {
      const createSessionWithName = async (name: string) => {
        if (!name.trim()) return;
        setFlow({ type: 'new-session-creating', workspace: flow.workspace, sessionName: name.trim() });
        try {
          await onOpenShell(state.currentProject!, flow.workspace.name, name.trim());
          await loadWorkspacesForProject(state.currentProject!);
          const { items: inboxItems, unreadCount } = await loadInbox();
          dispatch({ type: 'SET_INBOX', inbox: inboxItems, unreadCount });
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Failed to create session');
        }
        setFlow({ type: 'none' });
      };

      return (
        <Modal title="New Session" hint="[Enter] Create  [Esc] Cancel" height={9}>
          <box flexDirection="column" flexGrow={1}>
            <text fg={COLORS.textDim} height={1} marginTop={1}>Enter session name:</text>
            <text height={1}> </text>
            <input
              placeholder="main"
              focused
              value={flow.inputValue}
              onInput={(v) => setFlow({ ...flow, inputValue: v })}
              onSubmit={createSessionWithName}
            />
          </box>
        </Modal>
      );
    }

    if (flow.type === 'new-session-creating') {
      return (
        <Modal title="New Session" height={5}>
          <text fg={COLORS.loading} paddingTop={1}>Creating session "{flow.sessionName}"...</text>
        </Modal>
      );
    }

    return null;
  };

  // Full-screen inbox view
  if (flow.type === 'inbox') {
    const items = state.inbox;

    // Detail view for a session thread
    if (flow.viewingSessionId) {
      const sessionItems = getSessionItems(items, flow.viewingSessionId);
      const sessionName = sessionItems[0]?.sessionName;
      const sessionParts = sessionName ? parseSessionName(sessionName) : null;
      const sessionLabel = sessionParts
        ? `${sessionParts.project} / ${sessionParts.workspace} / ${sessionParts.session}`
        : 'Session';
      const maxLinesPerItem = 8;

      return (
        <box flexDirection="column" width="100%" height="100%">
          <box flexDirection="column" border borderStyle="single" borderColor={COLORS.borderFocused} flexGrow={1} margin={1}>
            <text fg={COLORS.title} paddingLeft={1} height={1}>
              {` 📥 ${sessionLabel}${sessionItems.length > 0 ? ` (${sessionItems.length} notification${sessionItems.length > 1 ? 's' : ''})` : ''} `}
            </text>
            <box flexDirection="column" padding={1} flexGrow={1}>
              {sessionItems.length > 0 ? (
                sessionItems.map((item, itemIdx) => {
                  const timeAgo = formatTimeAgo(item.timestamp);
                  const typeLabel = getInboxTypeLabel(item);
                  const icon = getInboxIcon(item);
                  const lines = item.context.split('\n');
                  const previewLines = lines.slice(0, maxLinesPerItem);
                  const remainingLines = Math.max(0, lines.length - previewLines.length);

                  return (
                    <box key={item.id} flexDirection="column" marginBottom={itemIdx === sessionItems.length - 1 ? 0 : 1}>
                      <text fg={COLORS.title} height={1}>{icon} {typeLabel} · {timeAgo}</text>
                      {item.processTitle && <text fg={COLORS.loading} height={1}>Process: {item.processTitle}</text>}
                      <box flexDirection="column" paddingLeft={1} marginTop={1}>
                        {previewLines.map((line, lineIdx) => (
                          <text key={lineIdx} fg={COLORS.textDim} height={1}>{line}</text>
                        ))}
                        {remainingLines > 0 && (
                          <text fg={COLORS.textDim} height={1}>... ({remainingLines} more lines)</text>
                        )}
                      </box>
                    </box>
                  );
                })
              ) : (
                <text fg={COLORS.textDim} height={1}>No notifications for this session.</text>
              )}
            </box>
          </box>
          <box width="100%" height={1} backgroundColor={COLORS.statusBar}>
            <text fg={COLORS.textDim}> [a] Attach to session  [x] Delete  [Esc] Back to list</text>
          </box>
        </box>
      );
    }

    const { displayItems } = buildInboxDisplay(items);

    // Inbox list view - hierarchical grouped with tree connectors
    return (
      <box flexDirection="column" width="100%" height="100%">
        <box flexDirection="column" border borderStyle="single" borderColor={COLORS.borderFocused} flexGrow={1} margin={1}>
          <text fg={COLORS.title} paddingLeft={1} height={1}>
            {` 📥 INBOX ${state.unreadCount > 0 ? `(${state.unreadCount} unread)` : ''} `}
          </text>
          <box flexDirection="column" padding={1} flexGrow={1}>
            {items.length > 0 ? (
              displayItems.map((displayItem, displayIdx) => {
                if (displayItem.type === 'project-header') {
                  // Project header - prominent block
                  return (
                    <box key={`project-${displayItem.project}`} flexDirection="column">
                      {displayIdx > 0 && <text height={1}> </text>}
                      <text fg={COLORS.title} height={1}>
                        ┌─ 📁 {displayItem.project} ({displayItem.totalItems} notification{displayItem.totalItems > 1 ? 's' : ''})
                      </text>
                    </box>
                  );
                } else if (displayItem.type === 'workspace-header') {
                  // Workspace header - indented with tree connector
                  return (
                    <box key={`workspace-${displayItem.workspace}`} flexDirection="column">
                      {!displayItem.isFirstWorkspace && <text fg={COLORS.border} height={1}>│</text>}
                      <text fg={COLORS.loading} height={1}>
                        │  ┌─ 📂 {displayItem.workspace}
                      </text>
                    </box>
                  );
                } else if (displayItem.type === 'session-header') {
                  // Session header - further indented
                  return (
                    <box key={`session-${displayItem.session}`} flexDirection="column">
                      <text fg={COLORS.textDim} height={1}>
                        │  │  ├─ 💻 {displayItem.session}
                      </text>
                    </box>
                  );
                } else {
                  // Notification item - deepest indentation with selection highlight
                  const { item } = displayItem;
                  const isSelected = displayItem.flatIndex === flow.selectedIndex;
                  const timeAgo = formatTimeAgo(item.timestamp);
                  const icon = getInboxIcon(item);
                  const readIndicator = item.read ? ' ' : '•';
                  const prefix = isSelected ? '▶' : ' ';
                  const processInfo = item.processTitle || '';
                  const context = item.context.split('\n')[0].substring(0, 40);

                  return (
                    <box key={item.id} flexDirection="column">
                      <text
                        fg={isSelected ? COLORS.selected : item.read ? COLORS.textDim : COLORS.text}
                        height={1}
                      >
                        │  │  │   {prefix}{readIndicator} {icon} {processInfo}{processInfo ? ' · ' : ''}{timeAgo}
                      </text>
                      <text
                        fg={isSelected ? COLORS.selected : COLORS.textDim}
                        height={1}
                      >
                        │  │  │      {context}
                      </text>
                    </box>
                  );
                }
              })
            ) : (
              <text fg={COLORS.textDim}>No notifications</text>
            )}
          </box>
        </box>
        <box width="100%" height={1} backgroundColor={COLORS.statusBar}>
          <text fg={COLORS.textDim}> [↑↓] Navigate  [Enter] View  [x] Delete  [c] Clear all  [Esc] Back</text>
        </box>
      </box>
    );
  }

  // Main view
  return (
    <box flexDirection="column" width="100%" height="100%">
      <Header inbox={state.inbox} unreadCount={state.unreadCount} />

      <box flexDirection="row" flexGrow={1} width="100%" gap={1} paddingLeft={1} paddingRight={1}>
        <ProjectPanel
          projects={state.projects}
          selectedIndex={state.selectedProjectIndex}
          focused={state.activePanel === 'projects' && flow.type === 'none'}
          onNavigate={(index) => dispatch({ type: 'SELECT_PROJECT', index })}
        />
        <WorkspaceTreePanel
          workspaces={state.workspaces}
          expandedWorkspaces={state.expandedWorkspaces}
          selectedTreeIndex={state.selectedTreeIndex}
          focused={state.activePanel === 'workspaces' && flow.type === 'none'}
          projectName={state.currentProject}
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

  const handleOpenShell = async (projectName: string, workspaceName: string, sessionName: string) => {
    const workspacesDir = getProjectWorkspacesDir(projectName);
    const workspacePath = join(workspacesDir, workspaceName);
    const config = readProjectConfig(projectName);

    renderer.suspend();

    try {
      // TUI handles setup during creation, so just run select scripts
      await openWorkspaceShell(workspacePath, projectName, config.repository, false, true, sessionName);
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
