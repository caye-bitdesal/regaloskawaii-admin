import handler, { createScheduledHandler, PluginBridge } from "@emdash-cms/cloudflare/worker";

export { PluginBridge };

// Debe coincidir con "triggers.crons" en wrangler.jsonc; si no, el cron se ignora sin error.
const GENERAL_CRON = "*/15 * * * *";

export default {
	...handler,
	scheduled: createScheduledHandler({ generalCron: GENERAL_CRON }),
} satisfies ExportedHandler;
