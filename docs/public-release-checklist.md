# Public release checklist

Run this checklist before changing the repository visibility to public.

## Third-party material

- Confirm that no vendor SDK archive, screenshot, API manual, or copied portal
  content is present in the current tree.
- Keep only independently written interoperability code and documentation.
- Link to `THIRD_PARTY_NOTICES.md` from the project README.
- If redistribution permission is uncertain, remove the material. A normal
  deletion does not remove it from Git history; rewrite the private history or
  publish a clean repository before making it public.

## Secrets and personal data

- Run `python scripts/audit_public_history.py` from a full clone.
- Review every commit author's email address and decide whether it is intended
  to be public. The scanner reports non-`noreply.github.com` author addresses
  as warnings without printing the addresses.
- Rotate any credential that was ever committed, even if it was later deleted.
- Manually inspect screenshots, binary files, release assets, Issues, and pull
  request attachments; a source scanner cannot prove those are clean.

## Repository settings

- Protect `main` and require the `python` and `worker` CI checks before merge.
- Block force pushes and branch deletion.
- After the history-audit CI job has run on a pull request, add
  `public-history` to the required checks.
- Enable secret scanning and private vulnerability reporting when the selected
  GitHub plan exposes those controls.

## Release

- Confirm the README installation path works from a fresh account.
- Create a signed or annotated version tag and GitHub release notes.
- Re-run the full test suite and review the final public diff.
