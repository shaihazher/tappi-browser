import type { RecipeDefinition } from './types';

export const linkedinRecipes: RecipeDefinition = {
  app: 'linkedin',
  displayName: 'LinkedIn',
  domain: 'linkedin.com',
  actions: [
    {
      name: 'search_people',
      description: 'Search for people on LinkedIn',
      requiresAuth: true,
      steps: [
        { instruction: 'Navigate to LinkedIn', tool: 'navigate', params: { url: 'https://www.linkedin.com' } },
        { instruction: 'Find the search input', tool: 'elements', grepHint: 'Search' },
        { instruction: 'Type "{query}" and press Enter', tool: 'type' },
        { instruction: 'Click the "People" filter tab to filter by people', tool: 'elements', grepHint: 'People' },
        { instruction: 'Wait for results', tool: 'wait', params: { ms: 1500 } },
        { instruction: 'Read search results', tool: 'text' },
      ],
    },
    {
      name: 'view_profile',
      description: 'View a LinkedIn profile',
      requiresAuth: true,
      steps: [
        { instruction: 'Navigate to linkedin.com/in/{username}', tool: 'navigate' },
        { instruction: 'Wait for profile to load', tool: 'wait', params: { ms: 2000 } },
        { instruction: 'Read profile headline, location, and summary', tool: 'text', grepHint: 'Experience|Education|About' },
        { instruction: 'Scroll to read experience and education sections', tool: 'scroll', params: { direction: 'down' } },
        { instruction: 'Read additional details', tool: 'text' },
      ],
    },
    {
      name: 'post',
      description: 'Create a new LinkedIn post',
      requiresAuth: true,
      steps: [
        { instruction: 'Navigate to LinkedIn feed', tool: 'navigate', params: { url: 'https://www.linkedin.com/feed/' } },
        { instruction: 'Click "Start a post" area', tool: 'elements', grepHint: 'Start a post' },
        { instruction: 'Wait for post editor to open', tool: 'wait', params: { ms: 1000 } },
        { instruction: 'Type post content "{text}"', tool: 'type' },
        { instruction: 'Click Post button to publish', tool: 'elements', grepHint: 'Post' },
      ],
    },
    {
      name: 'search_jobs',
      description: 'Search for job listings',
      requiresAuth: true,
      steps: [
        { instruction: 'Navigate to LinkedIn Jobs', tool: 'navigate', params: { url: 'https://www.linkedin.com/jobs/' } },
        { instruction: 'Find the job title search input', tool: 'elements', grepHint: 'Search by title|Search jobs' },
        { instruction: 'Type "{query}" in the job title field', tool: 'type' },
        { instruction: 'Optionally type "{location}" in the location field', tool: 'type', grepHint: 'Location|City' },
        { instruction: 'Press Enter or click Search', tool: 'keys', params: { sequence: 'Enter' } },
        { instruction: 'Wait for results', tool: 'wait', params: { ms: 2000 } },
        { instruction: 'Read job listings', tool: 'text' },
      ],
    },
    {
      name: 'read_feed',
      description: 'Read your LinkedIn feed',
      requiresAuth: true,
      steps: [
        { instruction: 'Navigate to LinkedIn feed', tool: 'navigate', params: { url: 'https://www.linkedin.com/feed/' } },
        { instruction: 'Wait for feed to load', tool: 'wait', params: { ms: 2000 } },
        { instruction: 'Read posts from feed', tool: 'text' },
        { instruction: 'Scroll for more posts', tool: 'scroll', params: { direction: 'down' } },
      ],
    },
  ],
};
