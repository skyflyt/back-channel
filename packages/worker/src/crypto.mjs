import { generateKeyPairSync, diffieHellman, hkdfSync, randomBytes, createCipheriv, createDecipheriv, sign, verify, createPublicKey, createPrivateKey } from 'node:crypto';
export const canonical = value => JSON.stringify(value, Object.keys(value).sort());
const pub = key => key.export({ type: 'spki', format: 'pem' });
const priv = key => key.export({ type: 'pkcs8', format: 'pem' });
export function identity() {
    const e = generateKeyPairSync('x25519'), s = generateKeyPairSync('ed25519');
    return { encryptionKey: pub(e.publicKey), encryptionPrivateKey: priv(e.privateKey), signingKey: pub(s.publicKey), signingPrivateKey: priv(s.privateKey) };
}
export function binding(task, purpose) { return { v: 1, id: task.id, senderAgentId: task.senderAgentId, targetAgentId: task.targetAgentId, expiresAt: task.expiresAt, purpose }; }
function key(privateKey, publicKey, header) { return Buffer.from(hkdfSync('sha256', diffieHellman({ privateKey: createPrivateKey(privateKey), publicKey: createPublicKey(publicKey) }), Buffer.alloc(0), Buffer.from(canonical(header)), 32)); }
export function seal(payload, header, local, peer) {
    const e = generateKeyPairSync('x25519'), iv = randomBytes(12), ephemeralKey = pub(e.publicKey);
    const cipher = createCipheriv('aes-256-gcm', key(priv(e.privateKey), peer.encryptionKey, header), iv);
    cipher.setAAD(Buffer.from(canonical(header)));
    const envelope = { header, ephemeralKey, iv: iv.toString('base64'), ciphertext: Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]).toString('base64'), tag: cipher.getAuthTag().toString('base64') };
    // Nested header is separately canonicalized, avoiding JSON property-order ambiguity.
    envelope.signature = sign(null, Buffer.from(signedBytes(envelope)), local.signingPrivateKey).toString('base64');
    return JSON.stringify(envelope);
}
function signedBytes(e) { return JSON.stringify([canonical(e.header), e.ephemeralKey, e.iv, e.ciphertext, e.tag]); }
export function open(sealed, expected, local, peer) {
    if (typeof sealed !== 'string' || Buffer.byteLength(sealed) > 131072)
        throw Error('Invalid envelope size');
    const e = JSON.parse(sealed);
    if (canonical(e.header) !== canonical(expected))
        throw Error('Envelope route mismatch');
    if (!verify(null, Buffer.from(signedBytes(e)), peer.signingKey, Buffer.from(e.signature, 'base64')))
        throw Error('Invalid peer signature');
    const decipher = createDecipheriv('aes-256-gcm', key(local.encryptionPrivateKey, e.ephemeralKey, e.header), Buffer.from(e.iv, 'base64'));
    decipher.setAAD(Buffer.from(canonical(e.header)));
    decipher.setAuthTag(Buffer.from(e.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(e.ciphertext, 'base64')), decipher.final()]).toString());
}
