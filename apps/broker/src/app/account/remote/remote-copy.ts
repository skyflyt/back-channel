/**
 * The words the Remote page uses for a device's role (docs/appbridge-remote-access.md § Two roles).
 *
 * A registered device is one of two things, and the two are easy to mix up: a `host` is a PC you want to
 * reach, and a `remote` is the phone or laptop you reach it from. On 2026-10-23 a laptop that was meant
 * to be reached was registered with the "phone or laptop" code, so it became a remote and never
 * published a route. Every role word on the page comes from here, phrased by direction ("you want to
 * reach" / "you reach from"), so the code buttons, the minted-code line and the device list all say the
 * same thing. Pure strings, no React: the route tests import this directly.
 */

export type RemoteRole = "host" | "remote";

/** The two code buttons, in the order the page shows them: the PC first, since that is the one people set up first. */
export const CODE_BUTTON: Readonly<Record<RemoteRole, string>> = Object.freeze({
  host: "Get a code for a PC you want to reach",
  remote: "Get a code for a phone or laptop you reach from",
});

/** What the minted code is for, read with "For a …" on the page. */
export const CODE_FOR: Readonly<Record<RemoteRole, string>> = Object.freeze({
  host: "PC you want to reach",
  remote: "phone or laptop you reach from",
});

/**
 * Where to type the code, per role: the PC's owner console, or the phone's and the Windows client's own
 * Internet access dialog. Each direction is app → page → control, with the labels those apps show today
 * (docs/vocabulary.md § Cross-app directions).
 */
export const WHERE_TO_ENTER: Readonly<Record<RemoteRole, string>> = Object.freeze({
  host: "On the PC: Back Channel Remote → Internet access → Register this PC.",
  remote: "On a phone: Back Channel Remote → PCs → Internet access → Register this phone. On a laptop you reach from: Back Channel Remote client → Internet access… → Register as a remote.",
});

/** The one line under "Add a device", built from the two role lines so they cannot drift apart. */
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
