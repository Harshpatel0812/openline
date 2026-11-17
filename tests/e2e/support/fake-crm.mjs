// Local fake HubSpot + Pipedrive for the e2e journeys (CRM sync, OL-E8). Never reaches a real CRM.
// Needs `pnpm build` first (it runs packages/crm's compiled fake servers).
//   http://127.0.0.1:4900/health                 readiness
//   http://127.0.0.1:4900/hubspot|hubspot-app    HubSpot API / consent screen (auto-approves)
//   http://127.0.0.1:4900/pipedrive|pipedrive-oauth
//   GET  /_fake/state                            records, notes, opt-outs, revocations, writes
//   POST /_fake/reset | /_fake/knobs | /_fake/expire-tokens
//   POST|PATCH|DELETE /_fake/:provider/:type[/:id]   edit "the CRM side" (contacts|companies|deals)
// Start the API with CRM_MODE=fake (the default outside production) and
// CRM_FAKE_BASE_URL=http://127.0.0.1:4900.
import crm from "../../../packages/crm/dist/fake/index.js";

const PORT = Number(process.env.FAKE_CRM_PORT ?? 4900);
const server = new crm.FakeCrmServer();
await server.start(PORT, "127.0.0.1");
console.warn(`fake CRM listening on ${server.url}`);

const stop = async () => {
  await server.stop();
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
