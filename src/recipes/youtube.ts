import type { RecipeDefinition } from './types';

export const youtubeRecipes: RecipeDefinition = {
  app: 'youtube',
  displayName: 'YouTube',
  domain: 'youtube.com',
  actions: [
    {
      name: 'search',
      description: 'Search for videos',
      steps: [
        { instruction: 'Navigate to YouTube', tool: 'navigate', params: { url: 'https://www.youtube.com' } },
        { instruction: 'Find the search input', tool: 'elements', grepHint: 'Search' },
        { instruction: 'Type "{query}" and press Enter', tool: 'type' },
        { instruction: 'Wait for results', tool: 'wait', params: { ms: 1500 } },
        { instruction: 'Read search results (titles, channels, views)', tool: 'text' },
      ],
    },
    {
      name: 'get_transcript',
      description: 'Get the transcript/captions of the current video',
      steps: [
        { instruction: 'Ensure a video page is open (URL should contain /watch)', tool: 'text', validation: 'Page should show a video title and player' },
        { instruction: 'Scroll down slightly past the video player to see the description area', tool: 'scroll', params: { direction: 'down', amount: 300 } },
        { instruction: 'Click the "...more" button below the video to expand the description', tool: 'elements', grepHint: 'more' },
        { instruction: 'Look for and click "Show transcript" button', tool: 'elements', grepHint: 'Show transcript|Transcript' },
        { instruction: 'Wait for transcript panel to load', tool: 'wait', params: { ms: 1500 } },
        { instruction: 'Read the transcript text from the transcript panel', tool: 'text', grepHint: 'transcript' },
        { instruction: 'Alternative: Extract transcript data via JavaScript', tool: 'eval_js', fallback: 'Try: eval_js({ js: "document.querySelectorAll(\'ytd-transcript-segment-renderer .segment-text\').forEach(e => e.textContent)" })' },
      ],
    },
    {
      name: 'read_comments',
      description: 'Read comments on the current video',
      steps: [
        { instruction: 'Ensure a video page is open', tool: 'text' },
        { instruction: 'Scroll down past the video to trigger comment loading', tool: 'scroll', params: { direction: 'down', amount: 800 } },
        { instruction: 'Wait for comments to load (they lazy-load on scroll)', tool: 'wait', params: { ms: 2500 } },
        { instruction: 'Read comments from the page', tool: 'text', grepHint: 'ago|likes|Reply' },
        { instruction: 'Scroll more for additional comments if needed', tool: 'scroll', params: { direction: 'down' } },
      ],
    },
    {
      name: 'get_video_info',
      description: 'Get metadata about the current video (title, views, likes, channel, description)',
      steps: [
        { instruction: 'Ensure a video page is open', tool: 'text', validation: 'Should be on a youtube.com/watch page' },
        { instruction: 'Read video title and view count from the page', tool: 'text', grepHint: 'views|subscribers' },
        { instruction: 'Click "...more" to expand full description if collapsed', tool: 'elements', grepHint: 'more', fallback: 'Description might already be expanded' },
        { instruction: 'Read the full description', tool: 'text' },
      ],
    },
  ],
};
