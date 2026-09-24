# DSH MiMo Connect

English | [中文](./README.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![npm](https://img.shields.io/npm/v/dsh-mimo-connect.svg)](https://www.npmjs.com/package/dsh-mimo-connect)
[![Node](https://img.shields.io/badge/node-%5E22.19.0%20%7C%7C%20%3E%3D24-339933.svg)](https://nodejs.org)
[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-0.1.5%20%7C%200.1.6%20%7C%200.1.7-4B6BFB.svg)](https://github.com/deepseek-ai/deepseek-harness)

Bring Xiaomi **MiMo** models into DeepSeek Harness and use them straight from the
DSH conversation window.

**No MiMo Switch, no background process, no autostart entry.**

## Highlights

- **Zero configuration once the desktop app is signed in** — nothing to do; the
  MiMo models simply appear in the picker.
- **Works without the desktop app** — the plugin can also sign in on its own.
- **No background program** — starts no proxy, injects no process, writes no
  autostart entry.
- **Follows your account** — switching accounts or signing out in the desktop
  app is picked up automatically.
- **Image input** — paste images when the model supports them.
- **Visible reasoning** — chain-of-thought streams as thinking events. There is
  no reasoning-level picker, and that is deliberate (see below).

## Install

```sh
dsh plugin --profile desktop add dsh-mimo-connect
dsh --profile desktop
```

Replace `desktop` with whichever profile you use (`web` / `desktop` / `dsh-tui`).

Then pick a model from the `MiMo` group in the model selector.

## Where credentials come from

The plugin resolves a credential in this order, and **stops at the first hit**:

| Order | Source | Notes |
|---|---|---|
| 1 | `$DSH_HOME/.mimo-connect-auth.json` | saved by the plugin's own sign-in |
| 2 | the MiMo desktop app's cookie DB | **read-only**, nothing on disk is modified |
| 3 | neither | tells you to run the `login` command |

The desktop cookie database lives at:

```text
%APPDATA%\Xiaomi MiMo\Partitions\xiaomi-account\Network\Cookies
```

It is a standard Chromium SQLite cookie store. The plugin **copies it to a
temporary file and queries that**, so it never contends with the running desktop
app for the lock. MiMo stores its cookie values in **plaintext** (`value` is
populated, `encrypted_value` is empty), so no DPAPI unwrapping is required.

## CLI

```sh
dsh plugin --profile desktop exec dsh-mimo-connect status    # sign-in state
dsh plugin --profile desktop exec dsh-mimo-connect verify     # one real completion
dsh plugin --profile desktop exec dsh-mimo-connect doctor     # local diagnostics
dsh plugin --profile desktop exec dsh-mimo-connect login      # sign in without the desktop app
dsh plugin --profile desktop exec dsh-mimo-connect logout     # delete the plugin's own credential
```

### About `login`

Xiaomi's passport endpoint **rejects every callback URL a third-party
integration can offer** (it answers `Callback连接不合法`), and `passToken` is
`HttpOnly`, so page JavaScript cannot read it either. A one-click OAuth-style
login is therefore not available.

`login` prints a step-by-step guide instead: open the sign-in page, copy three
values from the browser devtools (Application → Cookies), paste them back. The
plugin verifies the credential actually works before saving it.

**If you already run the MiMo desktop app, you do not need `login`** — its
sign-in is reused as-is.

## How it works

```text
credential (passToken / cUserId / userId)
   ↓  STS exchange (3 redirects)
serviceToken
   ↓  sent as a Cookie header
mimo-server-cn.xiaomimimo.com/api/route/chat/completions
```

The real endpoint speaks the OpenAI chat-completions protocol, so there is **no
protocol translation layer**. `model.headers` injects the cookie into the
request pi-ai builds, which also removes the need for a local shim.

### The attachment service

The plugin wires the host's `attachments` service into the adapter. This is not
optional: dsh-llm-pi-ai throws `UNSUPPORTED_CONTENT` the moment a message
contains an image block and no attachment service is available — **including a
text-only turn**, as long as an earlier tool result in that conversation carried
an image.

Switching to MiMo mid-conversation from another model (e.g. WorkBuddy) is the
easiest way to hit this, because the history comes along. Regression coverage:
`tests/image-guard.mjs`.

### One detail that matters

The gateway validates identity per domain: sending `.xiaomi.com` and
`.account.xiaomi.com` cookies in the **same header** makes it revoke the session
(`EXPIRED`) and bounce the request to the login page. The plugin therefore uses
a domain-scoped cookie jar, and emits each cookie name only once (taking the
value from the most specific matching domain). Guarded by `tests/cookie-jar.mjs`
and `tests/session.mjs`.

## Configuration

| Option | Default | Description |
|---|---|---|
| `cookieDb` | empty | explicit path to the desktop cookie database |
| `pollSeconds` | `30` | how often to re-check the credential; `0` disables polling |

The `MIMO_COOKIE_DB` environment variable overrides the cookie database path.

## Models

| ID | Display name | Multiplier |
|---|---|---|
| `mimo-v2.6-flash` | MiMo V2.6 Flash | x0.40 |
| `mimo-v2.6-pro` | MiMo V2.6 Pro | x1.00 |

The multiplier is the credit coefficient the desktop app displays. It is
informational only and does not affect requests.

The gateway exposes **no model-listing endpoint** (`/api/route/models` and
friends all return 404), so this list is a built-in snapshot taken from the
desktop app's `model-catalog.json` TEXT entries.

### No reasoning-level picker

The model picker will **not** offer Off / Minimal / Low / Medium / High. That is
intentional.

These models do produce chain-of-thought (returned as `reasoning_content`,
surfaced as thinking stream events), but the gateway **ignores every control
that was measured**:

| Parameter | Reasoning tokens |
|---|---|
| default | 176 / 211 |
| `thinking: { type: 'disabled' }` | 179 |
| `thinking: { enabled: false }` | 237 |
| `reasoning_effort: 'none'` | 181 |
| `reasoning_effort: 'low'` | 205 |
| `enable_thinking: false` | 210 |

None had any effect. Offering a picker that silently does nothing is worse than
offering none.

## On response speed

Measurements show the latency comes from the upstream gateway, not the plugin:

| Stage | Time |
|---|---|
| session cache hit | 0 ms |
| cookie header construction | < 0.01 ms |
| DNS | 9–28 ms |
| network round trip (no inference) | 37–169 ms |
| **one full completion** | **1–19 s (highly variable)** |

The same one-word prompt was measured anywhere between 1 s and 19 s. A bare
`fetch` bypassing the plugin entirely produces the same distribution, so the
plugin adds no measurable overhead.

Because the gateway ignores reasoning controls, there is currently **no
plugin-side way to speed this up**.

## Known limitations

- **Relies on non-public endpoints.** The plugin uses the desktop app's own
  endpoints and credentials, not an official Xiaomi API; upstream changes may
  require follow-up work.
- **Response speed depends on upstream.** Latency varies widely and is outside
  the plugin's control.
- **Credential lifetime.** `passToken` was measured at 30 days; after that you
  must sign in again (desktop app or `login`).
- **`serviceToken` needs short-term renewal.** Handled within the session, with
  one retry on a 401.
- **Quota is controlled by Xiaomi.** The plugin only forwards requests; it does
  not change limits, throttling, or account permissions.

## Development

```sh
node tests/run.mjs           # every suite
node tests/run.mjs cookie    # suites matching "cookie"
```

Suites that need a real credential skip themselves when none is present. A few
suites make real network calls when a credential is available.

`tools/` holds local deployment helpers that reference a machine-specific DSH
profile; they are not part of the published test suite.

## Disclaimer

- This project is **for personal study and research only**. It drives only your
  own MiMo account, on your own machine. Do not use it commercially or beyond
  reasonable personal use.
- You are responsible for complying with Xiaomi's terms of service. Any
  consequence of using this project (including but not limited to account
  restrictions, cleared quota, or service interruption) is yours to bear.
- This project is not affiliated with, or endorsed by, Xiaomi, Xiaomi MiMo, or
  DeepSeek. Names are used only to describe compatibility; trademarks remain
  with their respective owners.

## Credits

- [dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)
  (MIT) — reference for plugin layout, provider registration, and
  `PiAiAdapter` assembly.

## License

[MIT](./LICENSE)
