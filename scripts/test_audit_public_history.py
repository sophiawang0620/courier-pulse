import subprocess
import unittest
from unittest import mock

import audit_public_history as audit


def completed(stdout: str) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(["git"], 0, stdout=stdout, stderr="")


class PublicHistoryAuditTests(unittest.TestCase):
    def run_audit(
        self,
        content: str,
        email: str = "maintainer@users.noreply.github.com",
        path: str = "fixture.txt",
    ):
        def fake_git(*args, **_kwargs):
            if args[:3] == ("show", "-s", "--format=%ae"):
                return completed(f"{email}\n")
            raise AssertionError(f"unexpected git call: {args}")

        with (
            mock.patch.object(audit, "commits", return_value=["a" * 40]),
            mock.patch.object(audit, "paths_at", return_value=[path]),
            mock.patch.object(audit, "blob_at", return_value=content),
            mock.patch.object(audit, "git", side_effect=fake_git),
        ):
            return audit.audit_history()

    def test_allows_documented_synthetic_fixtures(self):
        findings, author_warnings = self.run_audit(
            "KY4000000000001 KY40000000AB12 KyeOfficialClient KYE_WAYBILL_PATTERN "
            "13800000000 13800138000"
        )
        self.assertEqual(findings, set())
        self.assertEqual(author_warnings, 0)

    def test_reports_personal_data_and_high_confidence_tokens(self):
        findings, author_warnings = self.run_audit(
            "KY400" + "1148145267 139" + "12345678 " + "ghp_" + ("a" * 36),
            email="maintainer@example.com",
        )
        labels = {finding[2] for finding in findings}
        self.assertEqual(
            labels,
            {"non-synthetic KYE waybill", "possible mainland China phone number", "GitHub token"},
        )
        self.assertEqual(author_warnings, 1)

    def test_reports_lowercase_short_waybills_and_formatted_phone_numbers(self):
        findings, _ = self.run_audit(
            "ky400" + "12345 138-" + "0012-3456 139 " + "1234 5678"
        )
        labels = {finding[2] for finding in findings}
        self.assertEqual(
            labels,
            {"non-synthetic KYE waybill", "possible mainland China phone number"},
        )

    def test_reports_project_credential_assignments(self):
        content = "KYE_APP_" + "SECRET=real-secret-value\nAPP_ACCESS_" + "TOKEN=another-secret-value"
        findings, _ = self.run_audit(content)
        self.assertEqual(
            {finding[2] for finding in findings},
            {"project credential assignment"},
        )

    def test_reports_removed_vendor_reference_if_it_exists_in_history(self):
        findings, _ = self.run_audit(
            "historical vendor notes",
            path="references/kye-official-api.md",
        )
        self.assertEqual(
            {finding[2] for finding in findings},
            {"sensitive filename"},
        )

    def test_sensitive_path_allows_examples_but_rejects_private_variants(self):
        self.assertFalse(audit.sensitive_path("cloudflare-worker/.dev.vars.example"))
        self.assertFalse(audit.sensitive_path(".env.example"))
        self.assertTrue(audit.sensitive_path("cloudflare-worker/.dev.vars.production"))
        self.assertTrue(audit.sensitive_path(".env.local"))
        self.assertTrue(audit.sensitive_path("certificates/provider.key"))
        self.assertTrue(audit.sensitive_path("references/kye-official-api.md"))


if __name__ == "__main__":
    unittest.main()
