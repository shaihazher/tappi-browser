/**
 * agent-bus.ts — Shared event bus for agent-level events.
 *
 * Extracted from agent.ts to break circular dependency between
 * agent.ts (imports tool-registry) and tool-registry.ts (needs to emit events).
 *
 * Import agentEvents from here, not from agent.ts.
 */

import { EventEmitter } from 'events';

export const agentEvents = new EventEmitter();
agentEvents.setMaxListeners(50);
