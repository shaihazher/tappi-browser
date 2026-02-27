import type { RecipeDefinition } from './types';

export const redditRecipes: RecipeDefinition = {
  app: 'reddit',
  displayName: 'Reddit',
  domain: 'reddit.com',
  domainAliases: ['old.reddit.com', 'www.reddit.com'],
  actions: [
    {
      name: 'search',
      description: 'Search Reddit posts',
      steps: [
        { instruction: 'Navigate to Reddit search', tool: 'navigate', params: { url: 'https://www.reddit.com/search/' } },
        { instruction: 'Find the search input', tool: 'elements', grepHint: 'Search' },
        { instruction: 'Type "{query}" and press Enter', tool: 'type' },
        { instruction: 'Wait for results', tool: 'wait', params: { ms: 1500 } },
        { instruction: 'Read search results (titles, subreddits, scores)', tool: 'text' },
      ],
    },
    {
      name: 'read_subreddit',
      description: 'Read posts from a subreddit',
      steps: [
        { instruction: 'Navigate to reddit.com/r/{subreddit}', tool: 'navigate' },
        { instruction: 'Wait for subreddit to load', tool: 'wait', params: { ms: 1500 } },
        { instruction: 'Read post titles, scores, and comment counts', tool: 'text' },
        { instruction: 'Scroll for more posts if needed', tool: 'scroll', params: { direction: 'down' } },
      ],
    },
    {
      name: 'read_thread',
      description: 'Read a post and its comments',
      steps: [
        { instruction: 'Ensure a Reddit thread is open (navigate to the post URL)', tool: 'text', validation: 'Page should show post title and comment section' },
        { instruction: 'Read the post title and body', tool: 'text' },
        { instruction: 'Scroll down to the comments section', tool: 'scroll', params: { direction: 'down' } },
        { instruction: 'Read comments (look for scores and timestamps)', tool: 'text', grepHint: 'points|ago|reply|comment' },
        { instruction: 'Continue scrolling for more comments', tool: 'scroll', params: { direction: 'down' } },
      ],
    },
    {
      name: 'post',
      description: 'Create a new post in a subreddit',
      requiresAuth: true,
      steps: [
        { instruction: 'Navigate to reddit.com/r/{subreddit}', tool: 'navigate' },
        { instruction: 'Click the Create Post button', tool: 'elements', grepHint: 'Create|Create Post|Submit' },
        { instruction: 'Wait for post editor', tool: 'wait', params: { ms: 1000 } },
        { instruction: 'Enter title "{title}" in the title field', tool: 'type', grepHint: 'Title|title' },
        { instruction: 'Enter body text "{body}" in the body editor', tool: 'type', grepHint: 'Text|body' },
        { instruction: 'Click Post/Submit button to publish', tool: 'elements', grepHint: 'Post|Submit' },
      ],
    },
    {
      name: 'view_user',
      description: 'View a Reddit user profile',
      steps: [
        { instruction: 'Navigate to reddit.com/user/{username}', tool: 'navigate' },
        { instruction: 'Wait for profile to load', tool: 'wait', params: { ms: 1500 } },
        { instruction: 'Read user profile info and recent posts/comments', tool: 'text', grepHint: 'karma|cake day|posts|comments' },
      ],
    },
  ],
};
