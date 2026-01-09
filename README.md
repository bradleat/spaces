# This repository has moved

**GitSpace has been renamed and moved to a new home:**

## https://github.com/inKibra/gitspace.sh

Please use the new repository for:
- Installation
- Issues and bug reports
- Pull requests and contributions
- Documentation

```bash
# Install from the new repo
npm install -g gitspace
```

---

<details>
<summary>Original README (archived)</summary>

# Spaces CLI

A powerful CLI tool for managing GitHub repository workspaces using git worktrees and optional Linear integration. Work on multiple features/tasks simultaneously, each in its own isolated workspace. Features an interactive TUI and support for repo config bundles for team onboarding.

## Features

- **Interactive TUI**: Beautiful terminal interface for managing projects and workspaces
- **Git Worktrees**: Work on multiple branches simultaneously without stashing
- **Linear Integration**: Create workspaces directly from Linear issues with automatic markdown documentation
- **Smart Branch Management**: Automatic detection of remote branches
- **Workspace Status**: Track uncommitted changes, stale workspaces, and more
- **Custom Scripts**: Convention-based scripts for setup, select, pre-setup, and removal phases
- **Repo Config Bundles**: Share onboarding configurations with your team, including scripts and setup steps
- **Secure Secrets**: Store sensitive values in OS keychain via Bun.secrets

## Prerequisites

The following tools must be installed and available in your PATH:

- [GitHub CLI (`gh`)](https://cli.github.com/) - for listing repositories
- [Git](https://git-scm.com/) - for worktree management
- [jq](https://stedolan.github.io/jq/) - for JSON processing
- [Bun](https://bun.sh) - runtime for the CLI

**GitHub Authentication**: You must authenticate the GitHub CLI before using Spaces:

```bash
gh auth login
```

## Installation

```bash
bun install -g https://github.com/bradleat/spaces

# Verify installation
spaces --version
```

## Quick Start

### Launch the TUI

Simply run `spaces` with no arguments to launch the interactive TUI:

```bash
spaces
```

The TUI provides a two-panel interface:
- **Left panel**: Your projects
- **Right panel**: Workspaces in the selected project

**Key Bindings:**
| Key | Action |
|-----|--------|
| `Enter` | Select project / Open workspace |
| `Tab` | Switch between panels |
| `n` | New project / workspace |
| `d` | Delete selected item |
| `?` | Show help |
| `q` | Quit |

### CLI Commands

You can also use traditional CLI commands:

#### 1. Add Your First Project

```bash
spaces add project
```

Select a GitHub repository, and Spaces will:
- Clone the repository to `~/spaces/<project-name>/base`
- Detect the default branch
- Run onboarding steps if a bundle is present
- Create project configuration

#### 2. Create a Workspace

```bash
# Create a workspace from a Linear issue (if configured)
spaces add

# Or create a workspace with a custom name
spaces add my-feature
```

#### 3. Switch Between Workspaces

```bash
# Interactive selection
spaces switch

# Switch to a specific workspace
spaces switch my-feature
```

## Repo Config Bundles

Repo config bundles allow repository owners to share onboarding configurations with their team. When someone clones a project that contains a bundle, they'll be guided through setup steps and have scripts automatically installed.

### Bundle Structure

A bundle is a directory (typically `.spaces-config/`) containing:

```
.spaces-config/
├── spaces-bundle.json    # Bundle manifest with onboarding steps
├── pre/                  # Scripts to run before setup
│   └── 01-copy-env.sh
├── setup/                # Scripts to run on first workspace creation
│   └── 01-install-deps.sh
├── select/               # Scripts to run every time workspace is opened
│   └── 01-status.sh
└── remove/               # Scripts to run before workspace deletion
    └── 01-cleanup.sh
```

### Bundle Manifest (`spaces-bundle.json`)

```json
{
  "version": "1.0",
  "name": "my-app-bundle",
  "description": "Setup bundle for my-app",
  "onboarding": [
    {
      "id": "welcome",
      "type": "info",
      "title": "Welcome",
      "description": "Let's get you set up!"
    },
    {
      "id": "node",
      "type": "confirm",
      "title": "Node.js",
      "description": "Node.js 18+ is required",
      "checkCommand": "node",
      "installUrl": "https://nodejs.org"
    },
    {
      "id": "api-key",
      "type": "secret",
      "title": "API Key",
      "description": "Enter your API key",
      "configKey": "apiKey"
    },
    {
      "id": "team-name",
      "type": "input",
      "title": "Team Name",
      "description": "Enter your team name",
      "configKey": "teamName",
      "defaultValue": "engineering"
    }
  ]
}
```

### Onboarding Step Types

| Type | Purpose | Storage |
|------|---------|---------|
| `info` | Display information | N/A |
| `confirm` | Verify installation (can check command in PATH) | N/A |
| `secret` | Collect sensitive values (masked input) | OS Keychain |
| `input` | Collect plain text values | Project config |

### Using Bundle Values in Scripts

Bundle values are passed to scripts as environment variables:

- `SPACE_VALUE_<KEY>` - Regular values from input steps
- `SPACE_SECRET_<KEY>` - Secret values from secret steps (fetched from OS keychain)

**Example script:**

```bash
#!/bin/bash
# .spaces-config/select/01-status.sh

WORKSPACE_NAME=$1
REPOSITORY=$2

# Access bundle values
if [ -n "$SPACE_VALUE_TEAMNAME" ]; then
  echo "Welcome, $SPACE_VALUE_TEAMNAME team!"
fi

# Access secrets (stored securely in OS keychain)
if [ -n "$SPACE_SECRET_APIKEY" ]; then
  echo "API Key configured"
fi
```

### Bundle Sources

Bundles can be loaded from:

1. **In-repo** (automatic): `.spaces-config/`, `spaces-config/`, or `.spaces/` in the cloned repository
2. **Local path**: `spaces add project --bundle-path /path/to/bundle/`
3. **Remote URL**: `spaces add project --bundle-url https://example.com/bundle.zip`

## Commands Reference

### `spaces` (TUI)

Launch the interactive terminal UI.

### `spaces add project`

Add a new project from GitHub.

```bash
spaces add project [options]

Options:
  --bundle-url <url>     Load bundle from remote URL (zip archive)
  --bundle-path <path>   Load bundle from local directory
  --skip-bundle          Skip bundle detection and onboarding
  --no-clone             Create project structure without cloning
  --org <org>            Filter repos to specific organization
  --linear-key <key>     Provide Linear API key via flag
```

### `spaces add [workspace-name]`

Create a new workspace in the current project.

```bash
spaces add [workspace-name] [options]

Options:
  --branch <name>        Specify different branch name from workspace name
  --from <branch>        Create from specific branch instead of base
  --no-setup             Skip setup commands
```

### `spaces switch [workspace-name]`

Switch to a workspace in the current project.

```bash
spaces switch [workspace-name]
# Alias: spaces sw
```

### `spaces switch project [project-name]`

Switch to a different project.

### `spaces list [subcommand]`

List projects or workspaces.

```bash
spaces list [subcommand] [options]
# Alias: spaces ls

Subcommands:
  projects               List all projects
  workspaces             List workspaces in current project (default)

Options:
  --json                 Output in JSON format
  --verbose              Show additional details
```

### `spaces remove workspace [workspace-name]`

Remove a workspace.

```bash
spaces remove workspace [workspace-name] [options]
# Alias: spaces rm workspace

Options:
  --force                Skip confirmation prompts
  --keep-branch          Don't delete git branch when removing workspace
```

### `spaces remove project [project-name]`

Remove a project.

```bash
spaces remove project [project-name] [options]
# Alias: spaces rm project

Options:
  --force                Skip confirmation prompts
```

### `spaces directory`

Print the current project directory path.

```bash
spaces directory
# Alias: spaces dir
```

## Configuration

### Global Configuration

Located at `~/spaces/.config.json`:

```json
{
  "currentProject": "my-app",
  "projectsDir": "/Users/username/spaces",
  "defaultBaseBranch": "main",
  "staleDays": 30
}
```

### Project Configuration

Located at `~/spaces/<project-name>/.config.json`:

```json
{
  "name": "my-app",
  "repository": "myorg/my-app",
  "baseBranch": "main",
  "linearApiKey": "lin_api_...",
  "linearTeamKey": "ENG",
  "bundleValues": {
    "teamName": "engineering"
  },
  "bundleSecretKeys": ["apiKey"],
  "appliedBundle": {
    "name": "my-app-bundle",
    "version": "1.0",
    "source": "/path/to/bundle",
    "appliedAt": "2025-01-01T00:00:00Z"
  }
}
```

- `bundleValues`: Values collected from input steps during onboarding
- `bundleSecretKeys`: Keys of secrets stored in OS keychain (values are NOT stored in config)
- `appliedBundle`: Information about the bundle that was applied

### Custom Scripts

Spaces uses **convention over configuration** for custom scripts:

```
~/spaces/<project-name>/scripts/
├── pre/           # Run before setup (terminal)
├── setup/         # Run once on workspace creation
├── select/        # Run every time workspace is opened
└── remove/        # Run before workspace deletion
```

#### Script Execution Rules

1. Scripts must be **executable** (`chmod +x`)
2. Scripts run **alphabetically** (use `01-`, `02-` prefixes)
3. **Working directory**: The workspace directory
4. **Arguments**: `$1` = workspace name, `$2` = repository name
5. **Environment**: Bundle values available as `SPACE_VALUE_*` and `SPACE_SECRET_*`

#### Script Phases

| Phase | When | Use Case |
|-------|------|----------|
| `pre/` | Once, before setup | Copy .env files, create directories |
| `setup/` | Once, on workspace creation | Install dependencies, initial build |
| `select/` | Every workspace open | Git fetch, status checks |
| `remove/` | Before deletion | Cleanup, notifications |

### Environment Variables

```bash
# Set the current project (overrides global config)
export SPACES_CURRENT_PROJECT="my-app"

# Available in scripts (from bundle onboarding):
# SPACE_VALUE_<KEY>    - Regular values
# SPACE_SECRET_<KEY>   - Secret values (from OS keychain)
```

## Directory Structure

```
~/spaces/
├── .config.json                 # Global configuration
├── <project-name>/
│   ├── .config.json             # Project configuration
│   ├── base/                    # Base repository clone
│   ├── workspaces/              # Git worktrees
│   │   └── <workspace-name>/
│   │       ├── .spaces-setup    # Setup completion marker
│   │       └── .prompt/         # Linear issue details (if applicable)
│   │           └── issue.md
│   └── scripts/                 # Custom scripts
│       ├── pre/
│       ├── setup/
│       ├── select/
│       └── remove/
```

## Troubleshooting

### GitHub CLI not authenticated

```
Error: GitHub CLI is not authenticated
```

**Solution:** Run `gh auth login` and follow the prompts.

### Missing dependencies

**Solution:** Install the missing dependencies using the provided URLs in the error message.

### Bundle secrets not available

If `SPACE_SECRET_*` variables are empty, ensure:
1. You completed the onboarding secret steps
2. Your OS keychain service is running (libsecret on Linux, Keychain on macOS)

## Development

```bash
# Install dependencies
bun install

# Development mode
bun run dev

# Type checking
bun run typecheck

# Run linter
bun run lint
```

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

</details>
