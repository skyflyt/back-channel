-- One device code for any device (docs/appbridge-remote-access.md § Two roles): a code minted without a role is
-- stored as 'any' and takes the role the app claims when it is redeemed, so a person no longer has to know whether
-- the laptop they are adding is "a PC you want to reach" or "a phone or laptop you reach from". Codes minted with a
-- role keep refusing the other role exactly as before.
--
-- ADDITIVE: widens the CHECK on "AppBridgeDeviceCode"."role" to allow 'any'. No row is touched. The device's own
-- role ("AppBridgeDevice"."role") stays host|remote; it is fixed at the exchange.
--
-- Order: apply this migration BEFORE deploying the app change that mints 'any' codes; the old app keeps working
-- against the widened constraint.

ALTER TABLE "AppBridgeDeviceCode" DROP CONSTRAINT IF EXISTS "AppBridgeDeviceCode_role_check";
ALTER TABLE "AppBridgeDeviceCode" ADD CONSTRAINT "AppBridgeDeviceCode_role_check" CHECK ("role" IN ('host','remote','any'));
