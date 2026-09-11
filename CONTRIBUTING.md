# Contributing

Use a focused branch and keep changes reviewable. For security issues, follow `SECURITY.md` instead of opening a public issue.

1. Install with `npm ci` using Node.js 22.
2. Add tests for behavior changes, including failure paths and tenant boundaries.
3. Run `npm run validate`.
4. If Android sources are present, run the Gradle lint, unit-test, and debug-assemble tasks.
5. Update contracts and documentation when an API or device behavior changes.

Pull requests should explain the problem, user-visible impact, validation evidence, security/privacy considerations, migration/rollback plan, and screenshots for UI changes. Do not weaken a check merely to make CI pass. Avoid destructive database migrations; use expand/migrate/contract changes.

By contributing, you agree that your contribution is licensed under the repository's MIT License.
