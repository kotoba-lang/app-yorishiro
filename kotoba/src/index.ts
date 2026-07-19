/**
 * yorishiro kotoba — barrel. kotoba-E2E split (plaintext public anchor catalog +
 * kotoba-E2E LE/confidential freeze-request payload, ADR-2605181100). Browser-
 * automation execution + Vault custody + the freeze ACTION stay etzhayyim via
 * consent-capability.
 */
export * from "./types.js";
export {
  registerAnchor,
  getAnchor,
  listAnchors,
  recordFreeze,
  listFreezes,
  getFreeze,
  coverage,
} from "./registry.js";
