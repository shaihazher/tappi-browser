import type { RecipeDefinition } from './types';

export const mapsRecipes: RecipeDefinition = {
  app: 'google_maps',
  displayName: 'Google Maps',
  domain: 'google.com/maps',
  domainAliases: ['maps.google.com'],
  actions: [
    {
      name: 'search',
      description: 'Search for a place or address',
      steps: [
        { instruction: 'Navigate to Google Maps', tool: 'navigate', params: { url: 'https://www.google.com/maps' } },
        { instruction: 'Find the search input', tool: 'elements', grepHint: 'Search Google Maps' },
        { instruction: 'Type "{query}" into search and press Enter', tool: 'type' },
        { instruction: 'Wait for results to load', tool: 'wait', params: { ms: 2000 } },
        { instruction: 'Read results from the side panel', tool: 'text' },
      ],
    },
    {
      name: 'get_directions',
      description: 'Get directions between two locations',
      steps: [
        { instruction: 'Navigate to Google Maps', tool: 'navigate', params: { url: 'https://www.google.com/maps' } },
        { instruction: 'Click Directions button', tool: 'elements', grepHint: 'Directions' },
        { instruction: 'Enter starting location "{from}" in the origin field', tool: 'type', grepHint: 'Choose starting point' },
        { instruction: 'Enter destination "{to}" in the destination field', tool: 'type', grepHint: 'Choose destination' },
        { instruction: 'Wait for route to calculate', tool: 'wait', params: { ms: 3000 } },
        { instruction: 'Read route options and travel time from the panel', tool: 'text', grepHint: 'min|hr|km|mi' },
      ],
    },
    {
      name: 'nearby_search',
      description: 'Find nearby places (restaurants, gas stations, etc.)',
      steps: [
        { instruction: 'Navigate to Google Maps', tool: 'navigate', params: { url: 'https://www.google.com/maps' } },
        { instruction: 'Search for "{category} near {location}"', tool: 'type', grepHint: 'Search' },
        { instruction: 'Press Enter', tool: 'keys', params: { sequence: 'Enter' } },
        { instruction: 'Wait for results', tool: 'wait', params: { ms: 2000 } },
        { instruction: 'Read the list of results with ratings and distance', tool: 'text', grepHint: 'stars|rating|open|closed' },
      ],
    },
    {
      name: 'save_place',
      description: 'Save a place to your lists',
      requiresAuth: true,
      steps: [
        { instruction: 'Ensure a place is selected (search first if needed)', tool: 'text' },
        { instruction: 'Click the Save button in the place details panel', tool: 'elements', grepHint: 'Save' },
        { instruction: 'Select a list to save to (Favorites, Want to go, etc.)', tool: 'elements', grepHint: 'Favorites|Want to go|Starred' },
      ],
    },
  ],
};
