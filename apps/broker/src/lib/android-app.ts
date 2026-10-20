/**
 * The BC Remote Android app that may use back-channel.app passkeys (Digital Asset Links, /.well-known/assetlinks.json)
 * and answer secret requests with them (src/lib/secrets-device.ts). A passkey prompt raised by an Android app carries
 * the origin "android:apk-key-hash:<base64url SHA-256 of its signing certificate>", not https://back-channel.app.
 *
 * Only the release ("pilot") signing identity, ruled 2026-10-20: the development build is debuggable, so anything on a
 * PC with ADB to the phone could drive its approval screen. The PC's secret broker pins the same origin itself
 * (secret-broker webauthn ANDROID_APP_ORIGINS); listing an app here alone lets nothing approve.
 */
export const ANDROID_APPS: readonly { packageName: string; certSha256: string }[] = [
  { packageName: "dev.appbridge.android.pilot", certSha256: "7ff0d86add017df8b61c7a0bdb69fe63a654ae4ad3fb17591abe93c745ea345e" },
];

const colonHex = (hex: string) => hex.toUpperCase().match(/../g)!.join(":");

/** The origins a WebAuthn assertion from one of these apps carries. */
export function androidOrigins(): string[] {
  return ANDROID_APPS.map((a) => `android:apk-key-hash:${Buffer.from(a.certSha256, "hex").toString("base64url")}`);
}

/** The Digital Asset Links statement: these apps share back-channel.app's sign-in credentials (passkeys). */
export function assetLinks() {
  return ANDROID_APPS.map((a) => ({
    relation: ["delegate_permission/common.get_login_creds"],
    target: { namespace: "android_app", package_name: a.packageName, sha256_cert_fingerprints: [colonHex(a.certSha256)] },
  }));
}
