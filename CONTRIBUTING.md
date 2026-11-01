# Contributing

Thanks for taking a look at freehub.

## Ground rules

- Keep the runtime **dependency-free**: `freehub.cjs` must stay a single CommonJS file that
  runs on Node >= 18.17 with no `node_modules`.
- Keep the local-first security model: loopback bind, same-origin control API.
- Do not add provider-specific hacks that break the generic OpenAI-compatible path; use a
  provider config field instead.
- Never commit real API keys, `~/.freehub` data, binaries or logs.

## Development

```sh
node freehub.cjs serve     # run from the repository
npm test                   # offline tests (mocks on dynamic ports)
```

The test suite spawns its own mock providers and a temporary `FREEHUB_HOME`; it does not touch
your real configuration.

## Pull requests

- Describe the problem and the behavior change.
- Add or update a test in `test/run-tests.mjs` when touching routing, proxying or the API.
- Keep commits focused; a single feature plus its tests is ideal.

## Reporting security issues

See [SECURITY.md](SECURITY.md). Do not open a public issue for a vulnerability.
