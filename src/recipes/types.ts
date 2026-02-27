/**
 * recipes/types.ts — Type definitions for the app recipe system.
 *
 * Recipes are structured step-by-step instructions that the agent
 * follows using its existing browser tools. They are NOT executable
 * scripts — the agent interprets each step and executes it with
 * navigate, elements, click, type, keys, eval_js, etc.
 */

export interface RecipeStep {
  /** Human-readable instruction for the agent (supports {param} placeholders) */
  instruction: string;
  /** Suggested browser tool to use (elements, click, type, keys, eval_js, navigate, etc.) */
  tool: string;
  /** Suggested params for the tool (agent may override based on actual page state) */
  params?: Record<string, any>;
  /** What to grep for in elements() output */
  grepHint?: string;
  /** How to check this step succeeded */
  validation?: string;
  /** Alternative approach if primary fails */
  fallback?: string;
}

export interface RecipeAction {
  /** Action identifier (e.g. "create_spreadsheet") */
  name: string;
  /** What this action does */
  description: string;
  /** Ordered steps to execute */
  steps: RecipeStep[];
  /** Whether user must be logged in */
  requiresAuth?: boolean;
}

export interface RecipeDefinition {
  /** App identifier (e.g. "google_sheets") */
  app: string;
  /** Human-readable name */
  displayName: string;
  /** Primary domain (e.g. "docs.google.com") */
  domain: string;
  /** Alternative domains */
  domainAliases?: string[];
  /** Maps to canvasApp detection in content-preload (e.g. "sheets") */
  canvasApp?: string;
  /** Available actions */
  actions: RecipeAction[];
}
