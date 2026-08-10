# GitHub authentication and non-interactive publishing

Local publishing uses GitHub CLI's OAuth credential stored by the operating
system keyring. Git obtains HTTPS credentials through `gh auth git-credential`.
No passkey, OAuth token, personal access token, or credential export belongs in
this repository, an `.env` file, a shell profile, or CI logs.

## One-time setup

GitHub must authorize the device once and whenever a new OAuth scope is added:

```powershell
gh auth login --hostname github.com --git-protocol https --web
gh auth refresh --hostname github.com --scopes workflow
gh auth setup-git --hostname github.com
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-github-auth.ps1
```

The `workflow` scope is required because this repository publishes changes
under `.github/workflows/`. GitHub may require passkey confirmation during the
one-time grant. After authorization, `gh` stores the token in Windows
Credential Manager and normal `git push`, `gh pr`, and Actions inspection
are non-interactive.

## Verification-only bootstrap

Run this before a publishing session:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-github-auth.ps1
```

The script never opens a browser and never prints or writes the token. It fails
closed when authentication is absent, keyring storage is not active, a required
scope is missing, or Git is not configured to use the `gh` credential helper.
The process-scoped execution-policy override does not change the machine or user
PowerShell policy.

## Expected reauthentication boundaries

Repeated approval is not part of the normal workflow. GitHub can still require
reauthorization after credential revocation or expiry, an account switch, an
organization policy change, or a request for an additional scope. These controls
must not be bypassed. Re-run only the failing one-time command, then run the
verification script again.

GitHub Actions must use its ephemeral `GITHUB_TOKEN` and repository permissions.
Do not copy the local keyring token into Actions secrets. For unattended external
automation, use a narrowly scoped GitHub App or an organization-approved secret
manager rather than a developer token.
