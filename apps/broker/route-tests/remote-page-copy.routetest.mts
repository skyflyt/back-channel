/**
 * The Devices page's role words (src/app/account/remote/remote-copy.ts): a PC you want to reach versus a
 * phone or laptop you reach from. On 2026-10-23 "Get a code for a PC" / "Get a code for a phone or laptop"
 * led a laptop that was meant to be reached to be registered as a remote, so the copy now states the
 * direction, and these tests keep it that way. Pure strings, no DB or auth mocking; run via test:routes
 * like lessons-page.routetest.mts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ADD_CHOICE, ADD_DEVICE_HINT, CODE_BUTTON, CODE_FOR, ROLE_NOUN, WHERE_TO_ENTER, deviceRoleLine } from "@/app/account/remote/remote-copy";
import { HOW_TO } from "@/lib/remote-app/readiness.mjs";

test("the Add flow asks what is being added: an agent, a PC, a phone or laptop", () => {
  assert.deepEqual(Object.keys(ADD_CHOICE), ["agent", "host", "remote"]);
  assert.deepEqual(ADD_CHOICE, { agent: "An agent", host: "A PC", remote: "A phone or laptop" });
});

test("the two code buttons say which direction each role is", () => {
  assert.equal(CODE_BUTTON.host, "Get a code for a PC you want to reach");
  assert.equal(CODE_BUTTON.remote, "Get a code for a phone or laptop you reach from");
  // Neither is a prefix of the other read aloud: both name the device and the direction.
  assert.match(CODE_BUTTON.host, /you want to reach$/);
  assert.match(CODE_BUTTON.remote, /you reach from$/);
});

test("the minted-code line repeats the button's direction, so the code and the button agree", () => {
  for (const role of ["host", "remote"] as const) {
    assert.ok(CODE_BUTTON[role].endsWith(CODE_FOR[role]), `${role}: "${CODE_BUTTON[role]}" should end with "${CODE_FOR[role]}"`);
  }
});

test("the add-device hint says where each role's code is typed, PC first, and never sends a PC to the client's dialog", () => {
  assert.ok(ADD_DEVICE_HINT.startsWith("Get a one-time code, then enter it on the device. "));
  assert.ok(ADD_DEVICE_HINT.indexOf(WHERE_TO_ENTER.host) < ADD_DEVICE_HINT.indexOf(WHERE_TO_ENTER.remote));
  assert.match(WHERE_TO_ENTER.host, /^On the PC: Back Channel Remote → Internet access → Register this PC\.$/);
  // Every direction is app → page → control, with the label each app shows (docs/vocabulary.md).
  assert.match(WHERE_TO_ENTER.remote, /^On a phone: Back Channel Remote → PCs → Internet access → Register this phone\. /);
  assert.match(WHERE_TO_ENTER.remote, /On a laptop you reach from: Back Channel Remote client → Internet access… → Register as a remote\.$/);
  assert.match(ADD_DEVICE_HINT, /Codes work once and expire after 10 minutes\.$/);
});

test("Your devices shows the role plainly: PC · reachable, Phone or laptop · reaches your PCs", () => {
  assert.equal(deviceRoleLine("host", true), "PC · reachable");
  assert.equal(deviceRoleLine("host", false), "PC · reachable once Internet access is on at the PC");
  assert.equal(deviceRoleLine("remote", true), "Phone or laptop · reaches your PCs");
  assert.equal(deviceRoleLine("remote", false), "Phone or laptop · reaches your PCs");
  assert.deepEqual(ROLE_NOUN, { host: "PC", remote: "Phone or laptop" });
});

test("the agent-readiness how-to for an unregistered PC points at Devices → Add → A PC on the website", () => {
  assert.equal(HOW_TO.registered, `On that PC, open Back Channel Remote → Internet access → Register this PC, with a code from the website: Back Channel → Devices → Add → ${ADD_CHOICE.host}.`);
});
