import type { RecipeDefinition } from './types';

export const instagramRecipes: RecipeDefinition = {
  app: 'instagram',
  displayName: 'Instagram',
  domain: 'instagram.com',
  actions: [
    {
      name: 'view_profile',
      description: 'View a user profile and stats',
      steps: [
        { instruction: 'Navigate to instagram.com/{username}', tool: 'navigate' },
        { instruction: 'Wait for profile to load', tool: 'wait', params: { ms: 2000 } },
        { instruction: 'Read profile stats (posts, followers, following) and bio', tool: 'text', grepHint: 'posts|followers|following' },
      ],
    },
    {
      name: 'search',
      description: 'Search for users, tags, or places',
      requiresAuth: true,
      steps: [
        { instruction: 'Navigate to Instagram', tool: 'navigate', params: { url: 'https://www.instagram.com' } },
        { instruction: 'Click the Search icon in the sidebar', tool: 'elements', grepHint: 'Search' },
        { instruction: 'Type search query "{query}" in the search input', tool: 'type' },
        { instruction: 'Wait for results', tool: 'wait', params: { ms: 1000 } },
        { instruction: 'Read search results', tool: 'text' },
      ],
    },
    {
      name: 'read_feed',
      description: 'Read recent posts from your feed',
      requiresAuth: true,
      steps: [
        { instruction: 'Navigate to Instagram home', tool: 'navigate', params: { url: 'https://www.instagram.com' } },
        { instruction: 'Wait for feed to load', tool: 'wait', params: { ms: 2000 } },
        { instruction: 'Read post content from feed', tool: 'text' },
        { instruction: 'Scroll for more posts if needed', tool: 'scroll', params: { direction: 'down' } },
      ],
    },
    {
      name: 'view_post_comments',
      description: 'View comments on a post',
      steps: [
        { instruction: 'Ensure a post is open (navigate to its URL or click on it from feed)', tool: 'text' },
        { instruction: 'Find and read comments section', tool: 'text', grepHint: 'comments|likes' },
        { instruction: 'Click "View all comments" if available to expand', tool: 'elements', grepHint: 'View all|Load more', fallback: 'Scroll down to see more comments' },
      ],
    },
  ],
};
