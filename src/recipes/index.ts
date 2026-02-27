/**
 * recipes/index.ts — App recipe registry and tool factory.
 *
 * Exports createRecipeTools() which returns the `app_recipe` tool
 * for the agent's tool registry. Recipes provide structured
 * step-by-step instructions that the agent follows using its
 * existing browser tools.
 */

import { tool } from 'ai';
import { z } from 'zod';
import type { RecipeDefinition, RecipeAction } from './types';

// Import all recipe definitions
import { sheetsRecipes } from './google-sheets';
import { docsRecipes } from './google-docs';
import { mapsRecipes } from './google-maps';
import { gmailRecipes } from './gmail';
import { instagramRecipes } from './instagram';
import { youtubeRecipes } from './youtube';
import { twitterRecipes } from './twitter';
import { linkedinRecipes } from './linkedin';
import { redditRecipes } from './reddit';

export const ALL_RECIPES: RecipeDefinition[] = [
  sheetsRecipes,
  docsRecipes,
  mapsRecipes,
  gmailRecipes,
  instagramRecipes,
  youtubeRecipes,
  twitterRecipes,
  linkedinRecipes,
  redditRecipes,
];

/** Format the full list of available apps and actions */
function formatRecipeList(): string {
  const lines: string[] = ['Available app recipes:\n'];
  for (const recipe of ALL_RECIPES) {
    lines.push(`**${recipe.displayName}** (${recipe.domain})`);
    for (const action of recipe.actions) {
      const auth = action.requiresAuth ? ' 🔒' : '';
      lines.push(`  • ${recipe.app}:${action.name} — ${action.description}${auth}`);
    }
    lines.push('');
  }
  lines.push('Usage: app_recipe({ action: "app:action_name", params: { ... } })');
  lines.push('🔒 = requires authentication');
  return lines.join('\n');
}

/** Format a recipe action as step-by-step instructions */
function formatRecipeInstructions(recipe: RecipeDefinition, action: RecipeAction, params?: Record<string, string>): string {
  const lines: string[] = [
    `## ${recipe.displayName} — ${action.description}`,
    '',
  ];

  if (action.requiresAuth) {
    lines.push('⚠️ Requires authentication. Check if logged in first.');
    lines.push('');
  }

  lines.push('### Steps:');
  for (let i = 0; i < action.steps.length; i++) {
    const step = action.steps[i];
    let instruction = step.instruction;

    // Substitute params into instruction
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        instruction = instruction.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
      }
    }

    lines.push(`${i + 1}. ${instruction}`);
    if (step.grepHint) {
      // Also substitute params in grepHint
      let hint = step.grepHint;
      if (params) {
        for (const [key, value] of Object.entries(params)) {
          hint = hint.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
        }
      }
      lines.push(`   → Use: elements({ grep: "${hint}" })`);
    }
    if (step.validation) lines.push(`   ✓ Verify: ${step.validation}`);
    if (step.fallback) lines.push(`   ↩ Fallback: ${step.fallback}`);
  }

  return lines.join('\n');
}

/** Create the app_recipe tool for the agent's tool registry */
export function createRecipeTools() {
  return {
    app_recipe: tool({
      description: 'Get step-by-step instructions for common tasks on popular web apps. Returns guided workflows the agent follows using browser tools. Supported apps: Google Sheets, Docs, Maps, Gmail, Instagram, YouTube, Twitter/X, LinkedIn, Reddit.',
      inputSchema: z.object({
        action: z.string().describe('Either "list" to see all available recipes, or "app:action_name" (e.g. "gmail:compose", "youtube:get_transcript") to get specific instructions.'),
        params: z.string().optional().describe('JSON object of action-specific parameters substituted into instructions. Example: \'{"to": "user@email.com", "subject": "Hello"}\''),
      }),
      execute: async ({ action, params: paramsStr }: { action: string; params?: string }) => {
        let params: Record<string, string> | undefined;
        if (paramsStr) {
          try { params = JSON.parse(paramsStr); } catch { params = undefined; }
        }

        if (action === 'list') {
          return formatRecipeList();
        }

        const colonIdx = action.indexOf(':');
        if (colonIdx === -1) {
          return `❌ Invalid action format. Use "app:action_name" (e.g. "gmail:compose") or "list" to see all available recipes.`;
        }

        const appName = action.slice(0, colonIdx);
        const actionName = action.slice(colonIdx + 1);

        const recipe = ALL_RECIPES.find(r => r.app === appName);
        if (!recipe) {
          const available = ALL_RECIPES.map(r => r.app).join(', ');
          return `❌ Unknown app "${appName}". Available apps: ${available}`;
        }

        const recipeAction = recipe.actions.find(a => a.name === actionName);
        if (!recipeAction) {
          const available = recipe.actions.map(a => `${recipe.app}:${a.name}`).join(', ');
          return `❌ Unknown action "${actionName}" for ${recipe.displayName}. Available: ${available}`;
        }

        return formatRecipeInstructions(recipe, recipeAction, params);
      },
    }),
  };
}
