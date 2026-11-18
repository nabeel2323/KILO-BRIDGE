# Kilo Bridge V1.0 — Independent Security Audit Report

## Audit Scope

This audit covers the Kilo Bridge security implementation as of Phase 2, including:
- Bridge-level security policy (deny-by-default rules)
- Kilo permission configuration (kilo.json written to worktrees)
- Secret redaction
- Path isolation
- Publishing restrictions
- Verification engine command prohibitions
- Kilo CLI integration security

## Overall Security Posture

**Rating: NEEDS REMEDIATION — One critical gap identified**

The Bridge security policy is correctly implemented with deny-by-default semantics. However, the Kilo CLI's global configuration (`bash: "allow"`) overrides the project-level `kilo.json` deny-by-default policy, creating a security gap that must be remediated before autonomous execution.

---

## 1. Bridge-Level Security Policy

### SecurityManager.generatePolicy()

All deny flags correctly set to `true`:

| Policy Flag | Value | Description |
|---|---|---|
| denyShellUnapproved | true | Shell commands require explicit approval |
| allowWorktreeOnly | true | File access restricted to worktree |
| denySensitivePaths | true | Sensitive paths (.env, secrets, etc.) denied |
| denyExternalPaths | true | External directory access denied |
| protectBridgeConfig | true | Bridge config/database files protected |
| denyGitPush | true | Git push denied |
| denyGitCommit | true | Git commit denied |
| denyGitMerge | true | Git merge denied |
| denyDeploy | true | Deployment denied |
| denyDbMigrate | true | Database migration denied |
| denyDbReset | true | Database reset denied |
| denyDbProdAccess | true | Production DB access denied |

### Verification

The security test suite confirms:
- Generated kilo.json passes denial assertions ✓
- Tampered config (bash allow) is refused ✓
- Removing a single required denial is detected ✓
- Policy validation requires all denials ✓
- Path traversal and external paths rejected ✓

---

## 2. Kilo Permission Configuration (kilo.json)

### Generated Config

The Bridge writes the following `kilo.json` to each worktree:

```json
{
  "version": "1.0",
  "default": "deny",
  "permission": {
    "bash": {
      "*": "deny",
      "git push*": "deny",
      "git commit*": "deny",
      "git merge*": "deny",
      "pnpm db:migrate*": "deny",
      "pnpm db:seed*": "deny",
      "pnpm db:reset*": "deny",
      "pnpm infra:up*": "deny",
      "pnpm infra:down*": "deny"
    },
    "external_directory": "deny"
  }
}
```

### Critical Gap: Kilo Global Config Override

**Finding: CRITICAL**

Kilo CLI v7.8.27 reads its configuration from global locations (`~/.config/kilo/config.json`), NOT from project-level `kilo.json` files in worktrees. The current global config shows:

```json
"permission": {
    "bash": "allow"
},
"permission_origins": {
    "bash": {
        "*": "global"
    }
}
```

This means kilo's effective bash permission is **"allow"** (all commands permitted), overriding the `kilo.json` deny-by-default policy written by the Bridge.

**Impact:** Without remediation, Kilo can execute any bash command, including:
- `git push`, `git commit`, `git merge` (Bridge policy denies these, but kilo doesn't enforce)
- `pnpm db:migrate`, `pnpm db:reset` (destructive database operations)
- `pnpm infra:up`, `pnpm infra:down` (infrastructure deployment)
- `rm -rf`, file deletion outside worktree
- Access to `.env`, `*.pem`, `*.key`, and other sensitive files

**Remediation Required:**
1. Configure kilo's global config to deny-by-default:
   - Edit `~/.config/kilo/config.json`
   - Set `permission.bash` to `"deny"`
   - Add explicit allow rules for verification commands (`pnpm lint`, `pnpm typecheck`, `pnpm test:unit`, `pnpm build`)
2. OR modify the Bridge to pass kilo.json path via CLI (no `--config` flag currently exists in kilo CLI)
3. OR accept that the Bridge's `VerificationEngine.isProhibited()` is the only enforcement (defense in depth only)

---

## 3. Secret Protection

### File-Based Prohibited Patterns (`publishing.ts`)

The following patterns are blocked from publishing:

| Pattern | Protected Items |
|---|---|
| `\.env(?:\..+)?$` | `.env`, `.env.local`, `.env.production` |
| `secrets(?:\/|$)` | `secrets/` directory |
| `credentials(?:\/|$)` | `credentials/` directory |
| `\.pem$` | Private key files |
| `\.key$` | Key files |
| `id_rsa(?:\.|$|\/)` | SSH private keys |
| `bridge\.config\.json$` | Bridge configuration |
| `data\/kilo-bridge\.sqlite$` | Bridge database |

### Secret Redaction (`kilo.ts`)

The KiloCliAdapter redacts the following token patterns:
- `ghp_*` → `[REDACTED_TOKEN]`
- `github_pat_*` → `[REDACTED_TOKEN]`
- `sk-*` → `[REDACTED_TOKEN]`

Git SHAs (40/64 hex chars) are preserved.

### Verification

Security tests confirm:
- Redaction removes tokens but preserves git SHAs ✓
- Prohibited file detection works correctly ✓

---

## 4. Path Isolation

### Worktree Isolation (`registry.ts`)

The `isWithin()` function ensures:
- `localPath` is not inside `worktreeRoot`
- `worktreeRoot` is not inside `localPath`
- Both paths must be absolute (Windows drive letter or UNC)

### Verification

Security tests confirm:
- Path traversal and external paths rejected ✓

---

## 5. Publishing Restrictions

### Publishing Gate (`worker.ts`)

Publishing requires:
1. Task status is `REPORT_READY`
2. Issue has `kilo:publish-approved` label
3. All required verification commands passed
4. No prohibited files in changed files
5. Worktree changes committed before push
6. Feature branch pushed to origin
7. Draft PR opened to base branch

### Verification

Publishing tests confirm:
- Prohibited file in change set blocks publishing ✓
- Refuses without approval label ✓
- Refuses when required verification did not pass ✓

---

## 6. Verification Engine Command Prohibitions

The `VerificationEngine.isProhibited()` blocks:

| Prohibited Command | Reason |
|---|---|
| `db:migrate` | Database migration requires authorization |
| `db:seed` | Database seed requires authorization |
| `db:reset` | Database reset requires authorization |
| `infra:up` | Infrastructure deployment requires authorization |
| `infra:down` | Infrastructure teardown requires authorization |

### Verification

- Prohibited commands never execute ✓
- Timeout kills long-running commands ✓

---

## 7. Bridge Command Policy

The Bridge writes a separate `bridge.command-policy.json` to worktrees with explicit allow/deny rules for verification commands. This is independent of the kilo.json Kilo permission policy.

---

## 8. Chain-of-Thought Isolation

The KiloCliAdapter filters out reasoning/chain-of-thought events:
- Event types matching `/reasoning|internal|chain.of.thought|cot/i` are filtered
- `part.type === "reasoning"` events are filtered
- No reasoning stored in event logs or reports

---

## 9. Recommendations

### Before Enabling Autonomous Execution

1. **CRITICAL**: Configure kilo global config to deny-by-default:
   ```json
   {
     "permission": {
       "bash": "deny",
       "external_directory": "deny"
     }
   }
   ```

2. Add explicit allow rules for verification commands in kilo global config.

3. Verify effective permissions by running `kilo run --dry-run` in a test worktree.

4. Consider adding a `--config` flag to the kilo CLI invocation to load project-level kilo.json.

### Ongoing Security Practices

- Regularly audit `bridge.config.json` for `workerEnabled` state
- Monitor security audit logs in `logs/kilo-bridge-error.log`
- Review prohibited file patterns quarterly
- Verify kilo.json integrity after each Bridge update

---

## Conclusion

The Bridge security architecture is sound with deny-by-default policies, but the Kilo CLI integration has a critical gap where kilo's global config overrides the project-level deny-by-default policy. This must be remediated before enabling autonomous task execution.