# Kilo Bridge V1.0 — Next-Step Instructions for First Controlled Task

## Prerequisites (Must Complete Before First Task)

### Step 1: Remediate Critical Security Gap

Configure kilo's global config to deny-by-default:

1. Open `~/.config/kilo/config.json` (or wherever kilo config is stored)
2. Find the `permission` section
3. Change `"bash": "allow"` to `"bash": "deny"`
4. Add explicit allow rules for verification commands:
   ```json
   {
     "permission": {
       "bash": "deny",
       "external_directory": "deny",
       "bash_rules": [
         { "command": "pnpm lint*", "action": "allow" },
         { "command": "pnpm typecheck*", "action": "allow" },
         { "command": "pnpm test:unit*", "action": "allow" },
         { "command": "pnpm build*", "action": "allow" },
         { "command": "pnpm format:check*", "action": "allow" }
       ]
     }
   }
   ```
5. Save and verify: `kilo config check`

### Step 2: Bootstrap GitHub Labels

```powershell
$env:KILO_BRIDGE_ROOT = "C:\TAIF\KILO-BRIDGE"
node dist\cli.js github bootstrap scs-platform
```

Expected output:
```
GitHub authenticated: True as nabeel2323
labels created: 7, exists: 0
```

Verify labels exist:
```powershell
$env:TEMP\gh\bin\gh.exe api repos/nabeel2323/scs-platform/labels?per_page=100 --jq '.[].name' | Select-String kilo
```

### Step 3: Verify Kilo Can Discover the Project

```powershell
node dist\cli.js init
node dist\cli.js projects list --json
```

Should show `scs-platform` as active.

### Step 4: Enable Worker (Only After Steps 1-3)

```powershell
node dist\cli.js configure set workerEnabled true
```

Verify:
```powershell
node dist\cli.js status --json
```

Should show `workerEnabled: true` in config.

## Enabling the First Controlled Task

### Option A: Create a Test Issue on GitHub

1. Go to https://github.com/nabeel2323/scs-platform/issues
2. Create a new issue with a harmless task (e.g., "Create a documentation file")
3. Add the `kilo:ready` label
4. Ensure the issue author is `nabeel2323` (in allowedAuthors)

### Option B: Start the Worker

```powershell
# Start continuous worker
node dist\cli.js start

# Or single poll
node dist\cli.js worker start --once
```

### Option C: Monitor Progress

```powershell
# Check worker status
node dist\cli.js status

# Check tasks
node dist\cli.js tasks --json

# Check specific task
node dist\cli.js task <task-id>

# Check reports
node dist\cli.js reports <task-id>
```

## Stopping After First Task

```powershell
# Graceful shutdown
node dist\cli: stop

# Or
node dist\cli.js worker stop
```

## Rollback / Abort

If something goes wrong:

1. Stop the worker immediately: `node dist\cli.js stop`
2. Disable worker: `node dist\cli.js configure set workerEnabled false`
3. Review logs: `Get-Content logs\kilo-bridge-error.log -Tail 50`
4. Check task state: `node dist\cli.js task <task-id>`

## Verification Checklist Before First Task

- [ ] Kilo global config `bash: "deny"` configured
- [ ] GitHub `kilo:*` labels bootstrapped
- [ ] `workerEnabled: true` in bridge.config.json
- [ ] `gh` CLI authenticated as `nabeel2323`
- [ ] `kilo` CLI installed (v7.8.27)
- [ ] SCS repo `nabeel2323/scs-platform` accessible
- [ ] Test issue created with `kilo:ready` label
- [ ] Worker started and polling

## Expected First Task Flow

1. Worker polls GitHub, discovers issue with `kilo:ready` label
2. Task created in DB with status `READY`
3. Task claimed, status → `CLAIMED` → `RUNNING`
4. Isolated worktree created at `ai/kilo/issue-N`
5. Kilo CLI executed in worktree
6. Verification commands run
7. Report generated and posted as GitHub comment
8. Status → `REPORT_READY`
9. (Optional) If `kilo:publish-approved` label added: commit, push, draft PR → `PUBLISHED`

## Contacts

- Bridge root: `C:\TAIF\KILO-BRIDGE`
- Config: `C:\TAIF\KILO-BRIDGE\bridge.config.json`
- Database: `C:\TAIF\KILO-BRIDGE\data\kilo-bridge.sqlite`
- Logs: `C:\TAIF\KILO-BRIDGE\logs\`
- Reports: `C:\TAIF\KILO-BRIDGE\reports\`