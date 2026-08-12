# DMOFT Pro cold standby

The local research environment was placed in cold standby on 2026-08-12.

## Preserved checkpoint

- Repository: `https://github.com/ExpressPath/dmoft-pro.git`
- Branch: `codex/roadmap-skeletons`
- Tested commit before standby: `43091ad`
- Production sender: `https://dmoft-pro-billing.vercel.app/optical-lab?role=sender`
- Production reader: `https://dmoft-pro-billing.vercel.app/o`
- Local `billing/.env.local`, `billing/.vercel`, `billing/AGENTS.md`, and
  `billing/CLAUDE.md` are intentionally preserved.

Only reproducible dependencies, build outputs, caches, coverage files, and
development logs were removed. No source code or local configuration was
archived or deleted.

## Restore the billing and optical web app

Requirements: Node.js 22 and npm.

```powershell
Set-Location C:\Users\funct\Documents\Codex\dmoft-pro\billing
npm.cmd ci
npm.cmd run check
npm.cmd run dev
```

## Restore the Python client

Requirements: Python 3.11 or newer.

```powershell
Set-Location C:\Users\funct\Documents\Codex\dmoft-pro\client
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -e ".[dev]"
pytest
```

If the working tree is lost, clone the repository, switch to the preserved
branch, and then restore the locally held environment files from the normal
secret-management source before running the commands above.
