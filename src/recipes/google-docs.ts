import type { RecipeDefinition } from './types';

export const docsRecipes: RecipeDefinition = {
  app: 'google_docs',
  displayName: 'Google Docs',
  domain: 'docs.google.com',
  canvasApp: 'docs',
  actions: [
    {
      name: 'create',
      description: 'Create a new Google Docs document',
      requiresAuth: true,
      steps: [
        { instruction: 'Navigate to docs.new', tool: 'navigate', params: { url: 'https://docs.new' } },
        { instruction: 'Wait for document to load', tool: 'wait', params: { ms: 2000 } },
        { instruction: 'Verify document loaded', tool: 'text', validation: 'Page should contain editable area' },
      ],
    },
    {
      name: 'insert_text',
      description: 'Type text at the current cursor position',
      steps: [
        { instruction: 'Click in the document body to position cursor', tool: 'elements', grepHint: 'docs-editor|kix-page' },
        { instruction: 'Type "{text}"', tool: 'keys' },
      ],
    },
    {
      name: 'add_heading',
      description: 'Add a heading (H1-H6) at the current position',
      steps: [
        { instruction: 'Position cursor where heading should go', tool: 'elements', grepHint: 'docs-editor' },
        { instruction: 'Apply heading style with Ctrl+Alt+{level} (1-6)', tool: 'keys', params: { sequence: 'ctrl+alt+{level}' } },
        { instruction: 'Type the heading text "{text}"', tool: 'keys' },
        { instruction: 'Press Enter to start a new line after heading', tool: 'keys', params: { sequence: 'Enter' } },
      ],
    },
    {
      name: 'find_replace',
      description: 'Find and replace text in the document',
      steps: [
        { instruction: 'Open Find & Replace with Ctrl+H', tool: 'keys', params: { sequence: 'ctrl+h' } },
        { instruction: 'Type "{find}" in the Find field', tool: 'type', grepHint: 'Find' },
        { instruction: 'Tab to Replace field and type "{replace}"', tool: 'type', grepHint: 'Replace with' },
        { instruction: 'Click "Replace all" to replace all occurrences', tool: 'elements', grepHint: 'Replace all' },
        { instruction: 'Close the dialog with Escape', tool: 'keys', params: { sequence: 'Escape' } },
      ],
    },
    {
      name: 'export_pdf',
      description: 'Download the document as PDF',
      steps: [
        { instruction: 'Open File menu', tool: 'elements', grepHint: 'File' },
        { instruction: 'Hover over or click "Download" submenu', tool: 'elements', grepHint: 'Download' },
        { instruction: 'Select "PDF Document (.pdf)"', tool: 'elements', grepHint: 'PDF' },
        { instruction: 'Wait for download to start', tool: 'wait', params: { ms: 2000 } },
      ],
    },
  ],
};
