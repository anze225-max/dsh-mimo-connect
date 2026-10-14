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
> **This has been measured with a real, non-subscribed account (2026-10-12)**,
> and the result is unambiguous: signing in, exchanging the `serviceToken` and
> reading the quota all work, but every actual inference is refused before a
> single token is generated:
>
> ```
> HTTP 403  {"error":{"code":"membership_required","biz_code":30012,
>            "message":"未开通会员或会员已到期，请订阅后使用"}}
> ```
>
> In other words **the plugin reaches the gateway's door but cannot get in** —
> which is exactly what "this plugin provides no allowance" means in practice.
> One conclusion (whether reasoning levels work) remains **unmeasurable** because
> of that gate; see the "Models" section.

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

> **`login` requires you to copy three values by hand. There is no way around it.**

Xiaomi's passport endpoint **rejects every callback URL a third-party
integration can offer** (it answers `Callback连接不合法`), and `passToken` is
`HttpOnly`, so page JavaScript cannot read it either. Together those two
constraints leave no room for a one-click login.

`login` prints a step-by-step guide instead: open the sign-in page, copy three
values from the browser devtools (Application → Cookies), paste them back.
Pasting a whole `passToken=xxxx` row works too — the prefix is stripped
automatically — and `cUserId` / `userId` may be left blank; only `passToken` is
required. The plugin verifies the credential actually works **before** saving it.

**If you already run the MiMo desktop app, you do not need `login`** — its
sign-in is reused as-is, with no prompt of any kind.

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
→ {"code":0,"message":"success","data":{"percent":0.0,"resetDate":null,"resetAt":null}}
```

> ### ⚠️ These fields have changed meaning under subscriptions
>
> The body above is the raw response from a real, **non-subscribed** account on
> 2026-10-12. Compared with the free-quota-era record:
>
> | Field | Free-quota era | Subscriptions (unsubscribed account) |
> |---|---|---|
> | `percent` | `99.8` = **remaining** % | `0.0` |
> | `resetDate` | `"2026-09-30"` | **`null`** |
> | `resetAt` | `1790782334` | **`null`** |
>
> The endpoint still answers **200** (the credential is fine), but the reset
> fields are now `null`. So:
>
> - **the reset date is not shown on an unsubscribed account** — the plugin
>   already omits the field when absent, so it never renders a fabricated date;
> - `percent: 0.0` with no subscription most plausibly means "no allowance
>   available", but that has **not** been verified on a subscribed account. The
>   UI wording therefore stays neutral and does not assert whether the number is
>   "remaining" or "used".
>
> Settling the semantics needs a **subscribed** account running
> `node tools/probe-gateway.mjs usage`.

The read is read-only and consumes nothing; a successful reading is cached for 60
seconds and a failure is backed off for 15. Every failure path simply shows
nothing — it can never affect inference.

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
| 1 | `GET /api/route/models` and friends | Attempted with the credential |
| 2 | Built-in snapshot | Where it always lands in practice; `status` reports `builtin` |

> ### ⚠️ Correction: the gateway has **no** model-listing endpoint
>
> This file previously claimed that `/api/route/models` answering **401** proved
> the endpoint existed. **That was wrong, and a real credential has now
> disproved it.**
>
> The mistake was treating 401 as evidence that a route exists. Measured with a
> real signed-in credential on 2026-10-12:
>
> - **everything** under the `/api/route/` prefix answers 401 without a session —
>   including invented paths like `/api/route/model/config` that certainly do not
>   exist;
> - everything outside that prefix answers 404, invented paths included.
>
> So the 401 is a **prefix-wide auth fence evaluated before routing**. It cannot
> be used to decide whether a route exists.
>
> With a valid credential, `/api/route/models`, `/api/route/model/list` and 14
> other candidate paths **all answered 404**, while the genuinely existing
> `/api/user/usage` answered **200** in the same run — proving the credential was
> fine and the 404s were not an auth problem. **The endpoint does not exist.**
>
> The plugin still asks first, but the purpose has changed: not to find an
> endpoint that works today, but so that if Xiaomi ever publishes a roster the
> plugin adopts it with no code change. Until then, landing on the snapshot is
> the **normal, expected** outcome rather than a malfunction.

The built-in snapshot is therefore what is actually in use — and it is
**measured**, not guessed:

| ID | Display name | Multiplier |
|---|---|---|
| `mimo-v2.6-flash` | MiMo V2.6 Flash | x0.40 |
| `mimo-v2.6-pro` | MiMo V2.6 Pro | x1.00 |

**Why those two ids are known to still be valid** — a control experiment with a
real credential (2026-10-12):

| Model id | Response | Meaning |
|---|---|---|
| `mimo-v2.6-flash` | `403 membership_required` | passed model validation, stopped by the **membership gate** |
| `mimo-v2.6-pro` | `403 membership_required` | same |
| `mimo-v2.5-flash` | `400 chat_model_not_public` | rejected at model validation |
| `mimo-v2.6-ultra` | `400 chat_model_not_public` | same |
| `mimo-v2.6` | `400 chat_model_not_public` | same |
| `gpt-4o` | `400 chat_model_not_public` | same |

The **status code is the signal**: near-miss ids fail at model validation (400),
while the two snapshot ids get further and are only stopped by the membership
gate (403). Reaching that gate shows the names are correct — the 403 text is
"membership not active or expired, please subscribe", which says nothing about
the model name.

The multiplier is the credit coefficient the desktop app displays. It is
informational only and does not affect requests.

### Reasoning levels: unmeasured under subscriptions, so not declared

The model picker currently offers **no** Off / Minimal / Low / Medium / High.

These models do produce chain-of-thought (returned as `reasoning_content`,
surfaced as thinking stream events). **Whether the gateway honours any *control*
over it is still undecided:**

- During the desktop free-quota era the measured answer was **no effect** —
  every `reasoning_effort` level and `thinking.type=disabled` came back
  indistinguishable (see the archived numbers below);
- On 2026-10-12 all six variants were re-run against a real signed-in account
  and **every one was refused with `403 membership_required` before generating a
  single token**. The account has no active subscription, so the re-run produced
  **no comparable data at all**.

So the field is omitted because it is **"not measurable yet"**, not because it
was **"measured as ineffective"**. Those are different claims, and this file
previously conflated them.

> That re-run also exposed a bug in the probe, now fixed: the old implementation
> reported "one level has a value" as "all levels are identical ⇒ controls
> ignored". That is a conclusion drawn from zero samples. It now reports that
> case separately as `insufficient`.

**With an account that has an active subscription**, one run settles it:

```sh
node tools/probe-gateway.mjs reasoning --confirm
```

It holds the prompt fixed and varies only the reasoning parameter, comparing
chain-of-thought length, and judges the result against criteria **fixed in
advance**: at least two levels must have measurements, not all levels equal,
`high/low ≥ 1.5×`, and the off switch below half the baseline. Decide how to
declare it from that evidence, rather than guessing first.

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
- **Without a subscription, inference is refused outright.** Measured with a real
  account: sign-in and session establishment work, but every inference returns
  `403 membership_required` ("membership not active or expired, please
  subscribe"). That is an account entitlement, not a plugin defect.
- **The gateway has no model-listing endpoint (measured and confirmed).** All 16
  candidate paths returned 404 under a valid credential; the plugin still asks,
  but in practice always uses the built-in snapshot. The snapshot's two model ids
  **are confirmed still valid** by a control experiment (see "Models").
- **Whether reasoning levels work remains undetermined.** The free-quota-era
  conclusion was "no effect"; the 2026-10-12 re-run against a real credential was
  refused with `403` for all six variants before any tokens were generated, so it
  produced **no comparable data**. The field is omitted because it is *not
  measurable yet*, not because it was *measured as ineffective*. A subscribed
  account running the probe settles it.
- **Relies on non-public endpoints.** The plugin uses the desktop app's own
  endpoints and credentials, not an official Xiaomi API; upstream changes may
  require follow-up work.
- **Response speed depends on upstream.** Latency varies widely and is outside
  the plugin's control.
- **The quota fields changed meaning under subscriptions.** `/api/user/usage`
  still answers 200, but on an unsubscribed account `percent` is `0.0` while
  `resetDate`/`resetAt` are `null`, so no reset date is shown (the plugin omits
  absent fields rather than rendering a fabricated date). Whether `percent` means
  "remaining" or "used" is not yet verified on a subscribed account.
- **`login` requires copying cookie values by hand.** `passToken` is `HttpOnly`
  and passport rejects third-party callbacks, so a one-click sign-in is
  impossible. This is a design constraint, not an outstanding defect.
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
node tests/run.mjs cli        # the command-line entry point
node tests/run.mjs credential # both credential sources
```

Each credential source (the desktop app's cookie database, and the plugin's own
`login`) has its own end-to-end suite:

- `tests/credential-paths.mjs` drives the real `apply()` against an upstream
  double that is **strict about `passToken`**, so "the jar was never seeded"
  fails instead of passing quietly. A lenient double hides exactly that class of
  bug.
- `tests/cli.mjs` runs the real `bin/cli.js` in real subprocesses, replacing only
  the network. The `login` prompts, `logout`'s deletion semantics, and the exit
  codes of `status` / `doctor` / `verify` are all pinned there.
- `tests/session-recovery.mjs` requires that a server-side revocation
  (`passToken=EXPIRED`) heals itself. That scenario comes from the real server:
  hop-by-hop probing showed passport revoking sessions exactly that way, while
  the stored credential is unchanged — so the old identity-comparison logic never
  re-seeded the jar. The assertions include "a revocation actually happened", so
  the suite cannot pass by failing to reach that path.

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

`boot-safety` carries one more limitation: it uses plain node to `import` the
installed plugin, but DSH keeps its `@deepseek-ai/*` framework packages inside
its own `app.asar` archive, where only the DSH process can resolve them. On a
machine with a **real** installation the import therefore fails at the first peer
dependency and degrades to a skip (exit code 10). That is not a plugin defect —
the sibling plugin `dsh-workbuddy-connect` works fine inside real DSH while
plain node cannot load it either. The suite loads via `pathToFileURL` and reports
this case as a skip rather than a failure; the plugin's `apply()` behaviour is
fully verified in-repo by `tests/entry.mjs`.

> This suite previously had a **false pass**: the profile held a junction into
> this repository, which happens to have `node_modules/@deepseek-ai/*`, so plain
> node resolved the imports and the suite "passed". It was verifying that
> coincidence, not the plugin. A real installation exposed it immediately, which
> is why it now behaves as described.

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
