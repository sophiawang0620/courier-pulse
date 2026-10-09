"""Fail on high-confidence secrets or personal shipment data in Git history."""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import PurePosixPath


SELF = "scripts/audit_public_history.py"
FORBIDDEN_HISTORY_PATHS = {"references/kye-official-api.md"}
FORBIDDEN_FILENAMES = {
    ".kuayue-watchlist.json",
    ".kuayue-push-state.json",
    ".kuayue-tracking-state.json",
}
FORBIDDEN_SUFFIXES = {".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"}
SYNTHETIC_WAYBILL = re.compile(r"^KY40000000[0-9A-Z]*$", re.IGNORECASE)
WAYBILL = re.compile(
    r"\b(?:KY|KYE)(?=[0-9A-Z]{8,20}\b)(?=[0-9A-Z]*\d)[0-9A-Z]{8,20}\b",
    re.IGNORECASE,
)
PHONE = re.compile(r"(?<!\d)1[3-9](?:[ -]?\d){9}(?!\d)")
SYNTHETIC_PHONES = {"13800000000", "13800138000"}
PROJECT_CREDENTIAL_ASSIGNMENT = re.compile(
    r"(?im)^[ \t]*(?:export[ \t]+)?(?:"
    r"KYE_APP_KEY|KYE_APP_SECRET|KYE_CUSTOMER_CODE|APP_ACCESS_TOKEN|MONITOR_TOKEN|"
    r"BARK_DEVICE_KEY|TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID"
    r")[ \t]*=[ \t]*['\"]?[^\s'\"#]{8,}"
)
HIGH_CONFIDENCE_SECRETS = {
    "private key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----"),
    "GitHub token": re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b"),
    "Telegram bot token": re.compile(r"\b\d{8,10}:[A-Za-z0-9_-]{30,}\b"),
    "Bark device URL": re.compile(r"https://api\.day\.app/[A-Za-z0-9_-]{16,}"),
}


def git(*args: str, text: bool = True) -> subprocess.CompletedProcess[str] | subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        ["git", *args],
        check=True,
        capture_output=True,
        text=text,
    )


def commits() -> list[str]:
    return [line for line in git("rev-list", "--all").stdout.splitlines() if line]


def paths_at(commit: str) -> list[str]:
    return [line for line in git("ls-tree", "-r", "--name-only", commit).stdout.splitlines() if line]


def blob_at(commit: str, path: str) -> str | None:
    data = git("show", f"{commit}:{path}", text=False).stdout
    if b"\0" in data or len(data) > 2_000_000:
        return None
    return data.decode("utf-8", errors="replace")


def sensitive_path(path: str) -> bool:
    normalized = PurePosixPath(path)
    name = normalized.name.lower()
    environment_file = (
        name == ".env"
        or (name.startswith(".env.") and not name.endswith(".example"))
        or name == ".dev.vars"
        or (name.startswith(".dev.vars.") and not name.endswith(".example"))
    )
    return (
        path in FORBIDDEN_HISTORY_PATHS
        or environment_file
        or name in FORBIDDEN_FILENAMES
        or normalized.suffix.lower() in FORBIDDEN_SUFFIXES
    )


def audit_history() -> tuple[set[tuple[str, str, str]], int]:
    findings: set[tuple[str, str, str]] = set()
    author_warnings = 0
    for commit in commits():
        author_email = git("show", "-s", "--format=%ae", commit).stdout.strip().lower()
        if author_email and not author_email.endswith("@users.noreply.github.com"):
            author_warnings += 1

        for path in paths_at(commit):
            if sensitive_path(path):
                findings.add((commit[:12], path, "sensitive filename"))
            # This file contains the signatures it searches for. Unit tests exercise
            # those signatures directly, so skipping it avoids scanner self-matches.
            if path == SELF:
                continue
            content = blob_at(commit, path)
            if content is None:
                continue
            for label, pattern in HIGH_CONFIDENCE_SECRETS.items():
                if pattern.search(content):
                    findings.add((commit[:12], path, label))
            if PROJECT_CREDENTIAL_ASSIGNMENT.search(content):
                findings.add((commit[:12], path, "project credential assignment"))
            for match in WAYBILL.finditer(content):
                if not SYNTHETIC_WAYBILL.fullmatch(match.group(0)):
                    findings.add((commit[:12], path, "non-synthetic KYE waybill"))
            if any(
                re.sub(r"\D", "", match.group(0)) not in SYNTHETIC_PHONES
                for match in PHONE.finditer(content)
            ):
                findings.add((commit[:12], path, "possible mainland China phone number"))

    return findings, author_warnings


def main() -> int:
    findings, author_warnings = audit_history()

    if author_warnings:
        print(
            f"WARNING: {author_warnings} commit(s) use a non-GitHub-noreply author email; "
            "review commit metadata before publishing."
        )
    if findings:
        print("Public-history audit failed:")
        for commit, path, label in sorted(findings):
            print(f"- {commit} {path}: {label}")
        return 1
    print("Public-history audit passed: no high-confidence secret or personal shipment pattern found.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
