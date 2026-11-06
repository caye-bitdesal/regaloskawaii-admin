import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { d1, r2 } from "@emdash-cms/cloudflare";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";
import { notifyGithub } from "./src/plugins/notify-github/index.ts";

export default defineConfig({
	output: "server",
	adapter: cloudflare(),
	// Un solo idioma: español. EmDash usa este locale para el contenido, las
	// taxonomías y la API (sin prefijo /es/ en las URLs).
	i18n: {
		defaultLocale: "es",
		locales: ["es"],
	},
	image: {
		layout: "constrained",
		responsiveStyles: true,
	},
	integrations: [
		react(),
		emdash({
			database: d1({ binding: "DB", session: "auto", coalesce: true }),
			storage: r2({ binding: "MEDIA" }),
			// Avisa a GitHub para reconstruir la web al publicar, despublicar o borrar.
			// Se configura en el panel: Plugins → notify-github → Settings.
			plugins: [notifyGithub()],
		}),
	],
	devToolbar: { enabled: false },
});
