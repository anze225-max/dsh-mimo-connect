# DSH MiMo Connect

English | [中文](./README.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![npm](https://img.shields.io/npm/v/dsh-mimo-connect.svg)](https://www.npmjs.com/package/dsh-mimo-connect)
[![Node](https://img.shields.io/badge/node-%5E22.19.0%20%7C%7C%20%3E%3D24-339933.svg)](https://nodejs.org)
[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-0.1.5%20%7C%200.1.6%20%7C%200.1.7%20%7C%200.2.0-rc.2-4B6BFB.svg)](https://github.com/deepseek-ai/deepseek-harness)

Bring MiMo's models into DeepSeek Harness and use them from the DSH
conversation window.

It runs on your own MiMo account's quota — **no separate API key to apply for,
and no extra resident program to install**.

> ⚠️ **Note: the MiMo desktop free quota has been retired.** This plugin existed
> to route that free quota into DSH; it now uses whatever quota your account
> has (subscription or otherwise). The plugin **neither provides nor bypasses**
> any allowance — whether you can use it depends entirely on your account.
>
> Also, the move to subscriptions may have changed the gateway's behaviour, and
> **some conclusions in this repository date from the free-quota era and have
> not been re-verified against a subscribed account** — the "Models" and "Known
> limitations" sections say which. The probe used to verify them ships with the
> repository.

![MiMo group in the model picker](./docs/model-picker.png)

When a session is routed to MiMo, the remaining quota appears directly under the
composer. Switch to another model and it is gone.

![Remaining quota on the same line as the session stats](./docs/quota-pill-inline.png)

Hover for the reset date.

![Hover shows the reset date](./docs/quota-pill-hover.jpg)

## Why this exists

MiMo's client quota can normally only be spent from inside the client. To use it
from DSH there are usually just two routes:

| Route | What it costs you |
|---|---|
| Apply for a platform API key | That is **platform billing**, a separate account from the client quota — you pay twice |
| Use a third-party reverse proxy | You install an **extra resident program**, plus an autostart entry |

This plugin is a third route: it **reuses the credentials the client has already
signed in with**, and brings that client quota into DSH. No key to apply for, no
extra program, no autostart entry.

## Highlights

- **Zero configuration** — with the client already signed in there is nothing to
  do; the models simply appear.
- **Uses your client quota** — the same quota you have inside the MiMo client,
  not platform billing.
- **No resident process** — starts no proxy, injects no process, writes no
  autostart entry. Close DSH and nothing is left behind.
- **Remaining quota in place** — while the session is routed to MiMo, the
  remaining quota and reset date show under the composer; with any other model
  the readout does not appear at all.
- **Works without the client** — the plugin can also sign in on its own.
- **Follows your account** — switching accounts or signing out in the client is
  picked up automatically.
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
contains an image block and no attachment service is available.

It also wires `resolveImageAccess` (mapped to the host's `fs` service), so the
image handle the model receives carries the normalized copy's read-only path.
When `fs` is unavailable the handle simply omits that path instead of failing the
turn.

Regression coverage: `tests/image-guard.mjs`.

### One detail that matters

The gateway validates identity per domain: sending `.xiaomi.com` and
`.account.xiaomi.com` cookies in the **same header** makes it revoke the session
(`EXPIRED`) and bounce the request to the login page. The plugin therefore uses
a domain-scoped cookie jar, and emits each cookie name only once (taking the
value from the most specific matching domain). Guarded by `tests/cookie-jar.mjs`
and `tests/session.mjs`.

## Remaining quota

While the session is routed to MiMo, a quota readout appears at the right of the
stats row under the composer:

```text
● MiMo 剩余 99.8%
```

Hovering shows the reset date (e.g. `重置于 2026-09-30`). The indicator dot turns
to a warning colour below 20% and to an alert colour below 5%.

**It only appears while the session is routed to MiMo.** With DeepSeek or any
other model the readout is absent entirely and issues no quota request — the
figure belongs to the session that is spending the allowance, not to unrelated
conversations.

The data comes from the client's own usage endpoint:

```text
GET mimo-server-cn.xiaomimimo.com/api/user/usage
→ {"code":0,"data":{"percent":99.8,"resetDate":"2026-09-30","resetAt":1790782334}}
```

`percent` is the **remaining** share, not the used share. The read is read-only
and consumes nothing; a successful reading is cached for 60 seconds and a failure
is backed off for 15. Every failure path simply shows nothing — it can never
affect inference.

The node half registers an `/api/mimo.quota` route (behind the same browser
session fence as every other `/api` route) and the browser half mounts a
component on the `conversation.composer.dock` slot to read it. On a host with no
browser connection (the CLI, for instance) the route is not registered and the
provider works as usual.

## Configuration

| Option | Default | Description |
|---|---|---|
| `cookieDb` | empty | explicit path to the desktop cookie database |
| `pollSeconds` | `30` | how often to re-check the credential; `0` disables polling |

The `MIMO_COOKIE_DB` environment variable overrides the cookie database path.

## Models

The plugin **asks the gateway for its roster first**, and only falls back to the
built-in snapshot when it cannot:

| Order | Source | Notes |
|---|---|---|
| 1 | `GET /api/route/models` | Queried with the credential; the gateway's roster wins |
| 2 | Built-in snapshot | Used when the gateway is unreachable or not entitled; `status` labels it as unverified |

> **This changed recently.** Measured during the desktop free-quota era, that
> endpoint returned **404** — "no such route" — so a built-in snapshot was the
> only option. Re-measured 2026-10-12 it returns **401**, which means "not
> authenticated" rather than "does not exist". The endpoint is there, so the
> roster is now fetched at runtime instead of hard-coded.
>
> The benefit: when upstream adds, renames, or retires a model, the plugin
> follows without a code change. And when the network or entitlements fail, the
> snapshot still lets the provider register and work, while `status` says
> plainly that the roster in effect is unverified.

The built-in snapshot (degradation only) mirrors the desktop app's
`model-catalog.json` TEXT entries:

| ID | Display name | Multiplier |
|---|---|---|
| `mimo-v2.6-flash` | MiMo V2.6 Flash | x0.40 |
| `mimo-v2.6-pro` | MiMo V2.6 Pro | x1.00 |

The multiplier is the credit coefficient the desktop app displays. It is
informational only and does not affect requests. When the gateway's roster
carries a multiplier, that one is preferred.

### Reasoning levels: unmeasured under subscriptions, so not declared

The model picker currently offers **no** Off / Minimal / Low / Medium / High.

These models do produce chain-of-thought (returned as `reasoning_content`,
surfaced as thinking stream events). **Whether the gateway honours any *control*
over it is an open question:**

- During the desktop free-quota era the measured answer was **no effect** —
  every `reasoning_effort` level and `thinking.type=disabled` came back
  indistinguishable (see the archived numbers below);
- After free quota was retired in favour of subscriptions the gateway's
  behaviour may have changed, **but that has not been verified against a real
  subscribed account**.

The plugin therefore **deliberately omits** any `reasoning` declaration:
guessing wrong would bring back a picker that silently does nothing, which is
worse than showing none.

**To enable the correct levels after subscribing**, run the measurement probe
once:

```sh
node tools/probe-gateway.mjs reasoning --confirm
```

It holds the prompt fixed and varies only the reasoning parameter, comparing
chain-of-thought length, and judges the result against criteria **fixed in
advance**: `high/low ≥ 1.5×`, not all levels equal, and the off switch below
half the baseline — all three must hold for "reasoning levels work". Decide how
to declare it from that evidence, rather than guessing first.

<details>
<summary>Archived numbers (measured during the desktop free-quota era)</summary>

| Parameter | Reasoning tokens |
|---|---|
| default | 176 / 211 |
| `thinking: { type: 'disabled' }` | 179 |
| `thinking: { enabled: false }` | 237 |
| `reasoning_effort: 'none'` | 181 |
| `reasoning_effort: 'low'` | 205 |
| `enable_thinking: false` | 210 |

The conclusion then was "none had any effect". These numbers **do not apply to
subscriptions**; they are kept only to explain why no picker was offered.
</details>

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

Because whether the gateway honours reasoning controls has not been verified
against a subscribed account, there is currently **no plugin-side way to speed
this up**.

## Known limitations

- **Free desktop quota has been retired in favour of subscriptions.** That free
  quota was the reason this plugin exists; it is gone. The plugin does not sell
  or bypass any allowance — whether you can use it depends entirely on whether
  your account has quota available.
- **The roster is unverified against a subscribed account.** The plugin now asks
  the gateway for models, but "which models the gateway returns under a
  subscription" has not been measured with a real subscribed credential (see
  "Models").
- **Whether reasoning levels work is undecided.** The old conclusion (no effect)
  dates from the free-quota era and may no longer hold; measure it with
  `tools/probe-gateway.mjs` before relying on it.
- **Relies on non-public endpoints.** The plugin uses the desktop app's own
  endpoints and credentials, not an official Xiaomi API; upstream changes may
  require follow-up work.
- **Response speed depends on upstream.** Latency varies widely and is outside
  the plugin's control.
- **The quota readout uses the same non-public endpoints.** If
  `/api/user/usage` changes or disappears, the readout silently stops appearing;
  model calls are unaffected.
- **Credential lifetime.** `passToken` was measured at 30 days; after that you
  must sign in again (desktop app or `login`).
- **`serviceToken` needs short-term renewal.** Handled within the session, with
  one retry on a 401.
- **Quota is controlled by Xiaomi.** The plugin only forwards requests; it does
  not change limits, throttling, or account permissions.

## Development

```sh
npm run build                 # produce the browser half, lib/client.js
node tests/run.mjs            # every suite
node tests/run.mjs client     # browser half only
node tests/run.mjs layout     # layout parity only
node tests/run.mjs cookie     # suites matching "cookie"
```

Suites report three distinct outcomes, never conflated:

- **pass** — the suite ran its checks and all of them held;
- **skip** — the suite found nothing on this machine to verify (exit code
  `SKIP_EXIT_CODE` = 10), and is *not* counted as a pass;
- **fail** — any other non-zero exit, or a signal.

A skip does not fail the run, but it is also **not evidence**: the skipped
suites are listed by name in the summary so that "nothing to check here" cannot
be misread as "verified". `boot-safety` (needs a DSH profile with the plugin
installed), `layout-parity` (needs a DSH installation), and `e2e-live` (needs a
real MiMo credential) all take the skip path on CI — which is to say **none of
those three is covered by CI**.

After changing client code, rebuild: a CI gate requires `lib/` to match
`src/client.js`, so committing a stale artifact fails the build.

Two further checks sit alongside the tests, and are equally hard gates on CI:

```sh
npm run format:check   # formatting (Prettier: no semicolons, single quotes, 2 spaces, 100 cols)
npm run typecheck      # JSDoc typecheck of src/ and bin/ (tsc --checkJs)
```

When formatting fails, `npm run format` fixes it in place. `lib/` is excluded via
`.prettierignore` — it is a build product and should never be formatted by hand.
The typecheck covers only `src/` and `bin/`: `tests/` and `tools/` lean on mocks
and dynamically built objects, where the added noise outweighs the benefit.

The rendering and layout suites need a few test-only dependencies:

```sh
npm i --no-save js-yaml@^4 react@18.3.1 react-dom@18.3.1 jsdom
```

They are not part of the published artifact — in the DSH page the browser half
takes React from the shell's platform module table.

`tools/` holds local deployment helpers; they are not part of the published test
suite. They resolve the target profile from `DSH_PROFILE_DIR`, `DSH_HOME`, or
`USERPROFILE`, so nothing is hard-coded to one machine. `npm run sync` builds
first and then syncs the plugin into that profile.

### The browser half

The client bundle is hand-written in the `__ModuleLoader__.load(...)` shape with
no bundler involved: `src/client.js` already has the artifact's form, and
`tools/build-client.mjs` adds a source map before writing `lib/client.js`. The
host discovers it through the `dsh.client` declaration in `package.json` and
serves the file named by `exports["./client"]` verbatim under `/plugins`.

Restart DSH after changing client code: the bundle is snapshotted at process
start and `patchReload` will not re-read it.

### Why the quota readout keeps up with the host's layout

The plugin registers its pill as an **ordinary entry** of the
`conversation.composer.dock` slot (`id: "mimo-quota"`, `order: 10`). The host's
own `StatsPills` registers in that same slot (`id: "stats"`, `order: 0`), so an
entry at `order: 10` lands directly beside the stats pill. The slot's container
is itself a flex row (`justify-content:center; align-items:center; gap:12px;
display:flex`), which makes the pill a **real child** of it, leaving layout
entirely to the host's own rules — no absolute positioning and no
hand-computed offsets.

The plugin declares only the pill's own geometry, matched item by item against
the host's stats pill (`border-radius:999px`, `corner-shape:round`,
`padding:1px 8px`, `gap:6px`, `font:inherit`, `line-height:inherit`,
`font-variant-numeric:tabular-nums`), so the two read as one row at any font
size or zoom.

The stylesheet is rendered by the component itself as a `<style>` element
carrying a `data-plugin-css` attribution marker, inserted on mount and removed
on unmount. It is deliberately not written to `document.head`, because the
host's `claimStyles` attributes every untagged `<style>` in the document to
whichever plugin is materializing and then deletes them when that plugin
unloads.

`tests/layout-parity.mjs` extracts the host's CSS verbatim from the
`dsh-client-ui-chat` artifacts and compares computed styles with both pills in
one container, covering changed font size, missing variables, a narrow container,
and a dark theme. It skips entirely (exit code 10, `SKIP_EXIT_CODE`) when no DSH
install is found; `DSH_APP_ROOT` overrides the location.

> Historical note: 0.2.0 and earlier took a different route — `createPortal` to
> send the pill into `[data-composer-stats]`, plus a `MutationObserver` to watch
> for the host replacing it. As of 0.3.0 the ordinary-slot-entry approach above
> is used instead, and neither the portal nor the observer is needed.

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
