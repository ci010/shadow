import type { Hono } from 'hono'

/** A plugin registers its own routes onto the shared Hono app. */
export type GatewayPlugin = (app: Hono) => void
