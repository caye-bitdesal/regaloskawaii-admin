/**
 * Plugin «notify-github»: cuando se publica, despublica o borra contenido que sale en la
 * web pública, avisa a GitHub (repository_dispatch) para que el workflow «Build and deploy»
 * del repo de la web la reconstruya.
 *
 * Configuración en el panel: Plugins → Notify GitHub → Settings
 *   - Repositorio: «usuario/repo» de la web (p. ej. caye-bitdesal/regaloskawaii)
 *   - Token de GitHub: fine-grained, solo ese repo, permiso «Contents: Read and write».
 *     Se guarda cifrado con EMDASH_ENCRYPTION_KEY.
 *
 * Si GitHub falla, solo se registra el error: nunca bloquea la publicación
 * (el workflow tiene además una construcción diaria de seguridad).
 */
import type { PluginContext, PluginDescriptor } from "emdash";
import { definePlugin } from "emdash";

export interface NotifyGithubOptions {
	/** Colecciones que salen en la web. Cambios en otras no reconstruyen. */
	collections?: string[];
	/** Base de la API (solo para pruebas). */
	apiBase?: string;
}

const DEFAULT_COLLECTIONS = ["productos", "colecciones", "tiendas", "pages"];
const EVENT_TYPE = "content-updated";

const SETTINGS_SCHEMA = {
	repo: {
		type: "string",
		label: "Repositorio de la web",
		description: "usuario/repositorio en GitHub, p. ej. caye-bitdesal/regaloskawaii",
	},
	token: {
		type: "secret",
		label: "Token de GitHub",
		description: "Fine-grained, solo ese repositorio, permiso «Contents: Read and write».",
	},
} as const;

/** Descriptor para `emdash({ plugins: [notifyGithub()] })` en astro.config.mjs. */
export function notifyGithub(options: NotifyGithubOptions = {}): PluginDescriptor<NotifyGithubOptions> {
	const apiBase = options.apiBase ?? "https://api.github.com";
	return {
		id: "notify-github",
		version: "1.0.0",
		format: "native",
		entrypoint: new URL("./index.ts", import.meta.url).pathname,
		options,
		capabilities: ["content:read", "network:request"],
		allowedHosts: [new URL(apiBase).hostname],
	};
}

/** Lo llama EmDash al cargar el plugin (formato nativo). */
export function createPlugin(options: NotifyGithubOptions = {}) {
	const apiBase = (options.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
	const collections = new Set(options.collections ?? DEFAULT_COLLECTIONS);

	async function notify(ctx: PluginContext, action: string, collection: string, id: unknown) {
		if (!collections.has(collection)) return;
		const repo = (await ctx.settings.get<string>("repo"))?.trim();
		const token = (await ctx.settings.get<string>("token"))?.trim();
		if (!repo || !token) {
			ctx.log.warn("notify-github sin configurar (repositorio o token): no se avisa a GitHub");
			return;
		}
		if (!ctx.http) {
			ctx.log.error("notify-github necesita la capacidad network:request");
			return;
		}
		try {
			const res = await ctx.http.fetch(`${apiBase}/repos/${repo}/dispatches`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
					"Content-Type": "application/json",
					"User-Agent": "regaloskawaii-admin",
				},
				body: JSON.stringify({
					event_type: EVENT_TYPE,
					client_payload: { action, collection, id: String(id ?? "") },
				}),
			});
			if (res.status === 204 || res.ok) {
				ctx.log.info(`GitHub avisado (${action} en ${collection})`);
			} else {
				ctx.log.error(`GitHub respondió ${res.status} al avisar (${action} en ${collection})`);
			}
		} catch (e) {
			ctx.log.error(`No se pudo avisar a GitHub: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	const hook = (action: string) => ({
		priority: 220,
		timeout: 10_000,
		errorPolicy: "continue" as const,
		handler: async (event: { collection: string; content?: Record<string, unknown>; id?: string }, ctx: PluginContext) =>
			notify(ctx, action, event.collection, event.content?.id ?? event.id),
	});

	return definePlugin({
		id: "notify-github",
		version: "1.0.0",
		capabilities: ["content:read", "network:request"],
		allowedHosts: [new URL(apiBase).hostname],
		admin: { settingsSchema: SETTINGS_SCHEMA },
		hooks: {
			"content:afterPublish": hook("publish"),
			"content:afterUnpublish": hook("unpublish"),
			"content:afterDelete": hook("delete"),
		},
	});
}

export default createPlugin;
