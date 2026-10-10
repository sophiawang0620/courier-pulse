# Contributing

1. Create a focused branch and keep credentials, real waybills, addresses, phone numbers, `.dev.vars`, and local state files out of commits.
2. Add regression tests for behavior changes.
3. Run:

   ```text
   python -m unittest discover -s scripts -p "test_*.py"
   cd cloudflare-worker
   corepack enable
   pnpm install --frozen-lockfile
   pnpm run check
   pnpm test
   ```

4. Describe data-flow, quota, or deployment impacts in the pull request.

Use synthetic fixtures in tests and examples. Do not attach raw KYE responses unless every personal field has been removed.
