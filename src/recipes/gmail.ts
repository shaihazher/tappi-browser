import type { RecipeDefinition } from './types';

export const gmailRecipes: RecipeDefinition = {
  app: 'gmail',
  displayName: 'Gmail',
  domain: 'mail.google.com',
  actions: [
    {
      name: 'compose',
      description: 'Compose and send a new email',
      requiresAuth: true,
      steps: [
        { instruction: 'Navigate to Gmail', tool: 'navigate', params: { url: 'https://mail.google.com' } },
        { instruction: 'Click the Compose button', tool: 'elements', grepHint: 'Compose' },
        { instruction: 'Wait for compose window to open', tool: 'wait', params: { ms: 1000 } },
        { instruction: 'Enter recipient "{to}" in the To field', tool: 'type', grepHint: 'To' },
        { instruction: 'Enter subject "{subject}" in the Subject field', tool: 'type', grepHint: 'Subject' },
        { instruction: 'Type email body "{body}" in the message area', tool: 'type', grepHint: 'message body' },
        { instruction: 'Click Send button to send the email', tool: 'elements', grepHint: 'Send', validation: '"Message sent" confirmation should appear' },
      ],
    },
    {
      name: 'read_inbox',
      description: 'Read recent emails from inbox',
      requiresAuth: true,
      steps: [
        { instruction: 'Navigate to Gmail inbox', tool: 'navigate', params: { url: 'https://mail.google.com/mail/u/0/#inbox' } },
        { instruction: 'Wait for inbox to load', tool: 'wait', params: { ms: 2000 } },
        { instruction: 'Read email list from page', tool: 'text' },
        { instruction: 'To open a specific email, use elements() to find it and click()', tool: 'elements' },
      ],
    },
    {
      name: 'search_email',
      description: 'Search for emails matching a query',
      requiresAuth: true,
      steps: [
        { instruction: 'Navigate to Gmail', tool: 'navigate', params: { url: 'https://mail.google.com' } },
        { instruction: 'Find the search input', tool: 'elements', grepHint: 'Search mail' },
        { instruction: 'Type search query "{query}" and press Enter', tool: 'type' },
        { instruction: 'Wait for search results', tool: 'wait', params: { ms: 1500 } },
        { instruction: 'Read search results', tool: 'text' },
      ],
    },
    {
      name: 'reply',
      description: 'Reply to the currently open email',
      requiresAuth: true,
      steps: [
        { instruction: 'Ensure an email is open. Click the Reply button', tool: 'elements', grepHint: 'Reply' },
        { instruction: 'Wait for reply compose area', tool: 'wait', params: { ms: 500 } },
        { instruction: 'Type reply message "{body}"', tool: 'type' },
        { instruction: 'Click Send', tool: 'elements', grepHint: 'Send' },
      ],
    },
    {
      name: 'label',
      description: 'Apply a label to the current email',
      requiresAuth: true,
      steps: [
        { instruction: 'Click the Labels button (tag icon) in the toolbar', tool: 'elements', grepHint: 'Label' },
        { instruction: 'Find and select label "{label}"', tool: 'elements', grepHint: '{label}' },
        { instruction: 'Click Apply', tool: 'elements', grepHint: 'Apply' },
      ],
    },
    {
      name: 'archive',
      description: 'Archive the currently open email',
      requiresAuth: true,
      steps: [
        { instruction: 'Ensure an email is open or selected', tool: 'text' },
        { instruction: 'Click the Archive button in the toolbar', tool: 'elements', grepHint: 'Archive' },
        { instruction: 'Verify email was archived', tool: 'text', validation: '"Conversation archived" notification should appear' },
      ],
    },
  ],
};
