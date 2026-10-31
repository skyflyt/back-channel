# Vocabulary

One word per concept, used the same way on the website, in Back Channel on your PC (Windows,
macOS) and in Back Channel on your phone (Android). Reviewers check user-facing copy against this
table. Internal identifiers (`Session`, `UserSkill`, `AppBridge*`, route paths, scope names, code
prefixes) do not change; this is about what people read.

## The story

> **Back Channel is home base for your AI agents.** Connect the agents you already use (Claude,
> Codex, ChatGPT, your own). Give them work, let them talk to your friends' agents, and let them
> use your computers, with you approving every step from your phone.

Three pillars. Every feature belongs to exactly one:

| Pillar | One line | What is in it |
|---|---|---|
| **Work** | Give your agents things to do and watch them do it | Lists, Toolkit, live agent sessions |
| **People** | Your agent talks to your friends' agents, privately | Inbox threads, friends, invites, public tool links, help someone |
| **Devices** | Your agents and your phone can reach your computers | PCs, phones, Remote app access, agents using PCs, secret approvals |

Three apps, each with one job, stated on its first screen:

- **The website** (back-channel.app): where you set things up, see everything, and read threads.
- **Back Channel on your PC**: makes a computer reachable by your phone and usable by your agents.
- **Back Channel on your phone**: your remote, and your approval device.

"Back Channel Remote" stays as the name of the Devices feature set and of the paid plan. It is not
the name of an app.

## The canon

| Concept | Say | Never say |
|---|---|---|
| An AI assistant connected to your account | **agent** | runtime, client, app, registered agent, agent fleet, assistant |
| A person you have connected with | **friend** | trusted peer, mutually trusted, your circle |
| A conversation between your agent and a friend's | **thread** | session, conversation, message, request |
| Your saved tools, prompts, scheduled checks, links | **Toolkit**; one item is a **tool** | library, artifact, lesson, skill |
| Tools published for anyone | **public tools**; the curated list is **Community tools** | lessons, link lessons, lesson library |
| A computer you reach, or that agents use | **PC** (a Mac is a "Mac"; together, "computers") | server, host, listener, desktop agent, agent |
| A phone or laptop that reaches PCs | **phone** / **laptop**; together with PCs, **devices** | client, remote, paired device, "device" for one phone |
| Making a PC or phone part of your account | **connect** (a connected PC, connect this PC) | pair, register, enrol, Internet access |
| The same-Wi-Fi flow with a matching code | **connect on the same Wi-Fi**; the step is **confirm the code** | pair, invitation, token, SAS |
| Things waiting on the person | **Approvals** | secret requests, pending requests, grant choice, needs attention |
| A secret an agent uses without seeing it | **secret**; the person **approves a secret use** | secret broker, broker, request code |
| Short-lived codes | **code**, qualified by purpose: **agent code**, **device code**, **invite code**, **help code** | API key, token, raw key, exchange code; `BCX`/`BC`/`BCS`/`ABD` in prose |
| The long-lived key | **developer key** (Settings only) | API key, raw key, agent token |
| Open panes on the phone | **workspace**; a saved set is a **saved workspace** | group, pane set, app view, app session |
| The pinned-apps strip | **taskbar** | app bar, pins |
| Alerts from a PC app | **alerts** | notifications, activity, app events |
| The product | **Back Channel**; the apps are "Back Channel on your PC" and "Back Channel on your phone" | BC Remote, AppBridge, Remote (as a name) |

## Cross-app directions

When one app tells the person to do something in another, name the destination the same way
everywhere: *app → page → control*, using the labels the destination shows today.

- *On the website: Back Channel → Devices → Add.* (Until the Devices tab exists: *Back Channel →
  Remote → Add a device.*)
- *On the PC: Back Channel on your PC → Internet access → Register this PC.*
- *On the phone: Back Channel on your phone → Internet access → Register this phone.*

Never point at a URL with a query string, an internal page id, or a page by a name only another app
uses.

## Not yet renamed

Page and tab labels inside the apps change in later phases (the website's tab merge, the PC
console's five-page rail, the phone's bottom navigation). Until then, cross-app directions use the
labels that exist, and the words inside each page follow the canon.
