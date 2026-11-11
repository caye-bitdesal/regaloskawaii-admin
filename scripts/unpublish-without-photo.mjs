#!/usr/bin/env node
/**
 * Sustituido por deprioritize-without-photo.mjs: los productos sin foto ya no se pasan
 * a borrador, se quedan publicados con prioridad 0 (al final de la web).
 * Se mantiene este nombre para que sigan funcionando los workflows y comandos antiguos.
 */
console.log("unpublish-without-photo.mjs → ahora es deprioritize-without-photo.mjs (prioridad 0 en vez de borrador)\n");
await import("./deprioritize-without-photo.mjs");
