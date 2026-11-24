// Type-only shim: TS routes import these at build time; the runtime lives in vault-bridge.mjs (docs/vault-bridge.md).
export {
  OPS,
  MAX_WORKER_WAIT_MS,
  WORKER_FRESH_MS,
  HOLD_MS,
  MAX_OPEN_PER_ACCOUNT,
  VaultBridgeError,
  workerOnline,
  ask,
  nextRequest,
  deliver,
  collect,
  _resetVaultBridge,
} from "./vault-bridge.mjs";
