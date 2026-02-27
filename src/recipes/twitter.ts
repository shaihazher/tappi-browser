import type { RecipeDefinition } from './types';

export const twitterRecipes: RecipeDefinition = {
  app: 'twitter',
  displayName: 'Twitter/X',
  domain: 'x.com',
  domainAliases: ['twitter.com'],
  actions: [
    {
      name: 'compose',
      description: 'Write and post a tweet',
      requiresAuth: true,
      steps: [
        { instruction: 'Navigate to X', tool: 'navigate', params: { url: 'https://x.com' } },
        { instruction: 'Find the compose area or click "Post" button', tool: 'elements', grepHint: 'Post|What is happening|What\'s happening' },
        { instruction: 'Type tweet text "{text}"', tool: 'type' },
        { instruction: 'Click Post/Tweet button to publish', tool: 'elements', grepHint: 'Post', validation: 'Tweet should appear in timeline' },
      ],
    },
    {
      name: 'search',
      description: 'Search tweets and users',
      steps: [
        { instruction: 'Navigate to X search', tool: 'navigate', params: { url: 'https://x.com/search' } },
        { instruction: 'Find the search input', tool: 'elements', grepHint: 'Search' },
        { instruction: 'Type "{query}" and press Enter', tool: 'type' },
        { instruction: 'Wait for results', tool: 'wait', params: { ms: 1500 } },
        { instruction: 'Read search results', tool: 'text' },
      ],
    },
    {
      name: 'view_profile',
      description: 'View a user profile and recent tweets',
      steps: [
        { instruction: 'Navigate to x.com/{username}', tool: 'navigate' },
        { instruction: 'Wait for profile to load', tool: 'wait', params: { ms: 1500 } },
        { instruction: 'Read profile bio and stats', tool: 'text', grepHint: 'Following|Followers|Joined' },
        { instruction: 'Scroll to read recent tweets', tool: 'text' },
      ],
    },
    {
      name: 'read_thread',
      description: 'Read a tweet thread and its replies',
      steps: [
        { instruction: 'Ensure a tweet/thread is open (navigate to the tweet URL)', tool: 'text' },
        { instruction: 'Read the main tweet and thread content', tool: 'text' },
        { instruction: 'Scroll to load and read replies', tool: 'scroll', params: { direction: 'down' } },
        { instruction: 'Read reply content', tool: 'text', grepHint: 'replying|reply' },
      ],
    },
    {
      name: 'read_feed',
      description: 'Read your home timeline/feed',
      requiresAuth: true,
      steps: [
        { instruction: 'Navigate to X home', tool: 'navigate', params: { url: 'https://x.com/home' } },
        { instruction: 'Wait for feed to load', tool: 'wait', params: { ms: 2000 } },
        { instruction: 'Read posts from the timeline', tool: 'text' },
        { instruction: 'Scroll for more posts', tool: 'scroll', params: { direction: 'down' } },
      ],
    },
  ],
};
