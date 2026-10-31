/**
 * The words the Devices page uses for a device's role (docs/appbridge-remote-access.md § Two roles).
 *
 * A registered device is one of two things, and the two are easy to mix up: a `host` is a PC you want to
 * reach, and a `remote` is the phone or laptop you reach it from. On 2026-10-23 a laptop that was meant
 * to be reached was registered with the "phone or laptop" code, so it became a remote and never
 * published a route. Since 2026-10-31 the code itself has no role (the app it is typed into decides), so
 * that trap is gone; the role words stay for the where-to-type lines and for "Your devices", phrased by
 * direction ("you want to reach" / "you reach from"). Pure strings, no React: the route tests import this
 * directly.
 */

export type RemoteRole = "host" | "remote";

/**
 * The three answers to "What are you adding?" on the Devices page (docs/web-ia.md), in the order shown: the agent
 * first, then the PC, since that is the device people set up first.
 */
export const ADD_CHOICE: Readonly<Record<"agent" | RemoteRole, string>> = Object.freeze({
  agent: "An agent",
  host: "A PC",
  remote: "A phone or laptop",
});

/** The code button on each device path. One code serves any device, so the button says just that. */
export const CODE_BUTTON: Readonly<Record<RemoteRole, string>> = Object.freeze({
  host: "Get a code",
  remote: "Get a code",
});

/** What the person said they are adding, read with "For a …" on the page (the code itself has no role). */
export const CODE_FOR: Readonly<Record<RemoteRole, string>> = Object.freeze({
  host: "PC you want to reach",
  remote: "phone or laptop you reach from",
});

/** The sentence that makes the role-less code plain, shown under every minted code. */
export const ANY_CODE_NOTE = "The same code works on any device: the app you type it into decides whether the device is reached or reaches.";

/**
 * Where to type the code, per role: the PC's owner console, or the phone's and the Windows client's own
 * dialog. Each direction is app → page → control, with the labels those apps show in their current
 * releases (docs/vocabulary.md § Cross-app directions). The phone line names Android 1.1.10.0's Settings.
 */
export const WHERE_TO_ENTER: Readonly<Record<RemoteRole, string>> = Object.freeze({
  host: "On the PC: Back Channel Remote → Internet access → Register this PC.",
  remote: "On a phone: Back Channel Remote → Settings → Back Channel account → Register this phone. On a laptop you reach from: Back Channel Remote client → Internet access… → Register as a remote.",
});

/** The one line under "What are you adding?", built from the two role lines so they cannot drift apart. */
export const ADD_DEVICE_HINT = `Get a one-time code, then enter it on the device. ${WHERE_TO_ENTER.host} ${WHERE_TO_ENTER.remote} Codes work once and expire after 10 minutes.`;

/**
 * The role line in "Your devices": the role, then what it does, plainly. A PC is reachable only while its
 * owner has Internet access switched on there, so that is said in the same breath.
 */
export function deviceRoleLine(role: RemoteRole, relayEnabled: boolean): string {
  if (role === "host") return relayEnabled ? "PC · reachable" : "PC · reachable once Internet access is on at the PC";
  return "Phone or laptop · reaches your PCs";
}

/** The fallback name of an unlabelled device, by role. */
export const ROLE_NOUN: Readonly<Record<RemoteRole, string>> = Object.freeze({ host: "PC", remote: "Phone or laptop" });
