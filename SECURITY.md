# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.2.x   | yes       |

## Threat model

freehub is a **local, single-user tool**. It binds `127.0.0.1` by default and trusts the
local user. It is not designed to be exposed to a network or the internet.

What is enforced:

- The control API (`/api/*`) accepts only same-origin browser requests and only a loopback
  `Host` header (plus `trustedHosts` from the config). This blocks drive-by attacks from
  arbitrary websites you have open in a browser.
- The bridge stop action never kills a process by port alone: a process is stopped only when
  freehub started it, or when its command line identifies it as `chat-bridge`.
- Request bodies are capped at 20 MB; configuration files are written atomically.
- The OpenAI-compatible endpoints (`/v1/*`) are CORS-open on purpose so browser-based clients
  can use them. They are not authenticated.

What is **not** enforced:

- No authentication token. Anyone who can execute code as your user can call the API.
- API keys are stored in plain text (`~/.freehub/keys.json`). Protect that file with OS ACLs.
- Custom provider `baseURL` values are not restricted. Only add providers you trust.
- The web-chat bridge drives a real browser session; provider terms of service may forbid this.

## If you need remote access

Do not change `host` to `0.0.0.0`. Put freehub behind a reverse proxy that terminates TLS and
enforces authentication (mTLS, basic auth, or an identity-aware proxy), bind freehub to
`127.0.0.1`, and firewall the port.

## Reporting a vulnerability

Please open a private GitHub Security Advisory (Security → Report a vulnerability) instead of
a public issue. Include reproduction steps, the version from `GET /healthz`, and the impact you
expect.

## Operational checklist

- [ ] `host` is `127.0.0.1`
- [ ] `~/.freehub/keys.json` and `config.json` are readable only by your user
- [ ] Keys are rotated after sharing logs or configs
- [ ] Review custom providers before adding them
- [ ] Read the provider's terms before using free tiers or the web-chat bridge
