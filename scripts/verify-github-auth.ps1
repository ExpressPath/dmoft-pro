[CmdletBinding()]
param(
    [string]$Hostname = "github.com",
    [string[]]$RequiredScopes = @("repo", "workflow")
)

$ErrorActionPreference = "Stop"

$ghCommand = Get-Command gh.exe -ErrorAction Stop
$gitCommand = Get-Command git.exe -ErrorAction Stop

$authLines = & $ghCommand.Source auth status --hostname $Hostname 2>&1
if ($LASTEXITCODE -ne 0) {
    throw "GitHub CLI is not authenticated for $Hostname. Complete the one-time setup in docs/GITHUB_AUTHENTICATION.md."
}
$authText = $authLines | Out-String

if ($authText -notmatch "\(keyring\)") {
    throw "GitHub CLI credentials are not stored in the operating-system keyring."
}

foreach ($scope in $RequiredScopes) {
    if (-not $authText.Contains("'$scope'")) {
        throw "GitHub CLI is missing the '$scope' scope. Run: gh auth refresh -h $Hostname -s $scope"
    }
}

$helperKey = "credential.https://$Hostname.helper"
$helpers = @(& $gitCommand.Source config --global --get-all $helperKey 2>$null)
if (-not ($helpers -match "auth git-credential")) {
    $setupSucceeded = $false
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        $setupOutput = @(& $ghCommand.Source auth setup-git --hostname $Hostname 2>&1)
        if ($LASTEXITCODE -eq 0) {
            $setupSucceeded = $true
            break
        }
        Start-Sleep -Milliseconds (250 * $attempt)
    }
    if (-not $setupSucceeded) {
        throw "Unable to configure Git to use the GitHub CLI credential helper: $($setupOutput -join ' ')"
    }
    $helpers = @(& $gitCommand.Source config --global --get-all $helperKey 2>$null)
}

if (-not ($helpers -match "auth git-credential")) {
    throw "GitHub CLI credential helper configuration was not persisted."
}

Write-Output "GitHub authentication ready: keyring-backed, required scopes present, non-interactive Git helper configured."
