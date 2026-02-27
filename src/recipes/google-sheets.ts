import type { RecipeDefinition } from './types';

export const sheetsRecipes: RecipeDefinition = {
  app: 'google_sheets',
  displayName: 'Google Sheets',
  domain: 'docs.google.com',
  canvasApp: 'sheets',
  actions: [
    {
      name: 'create',
      description: 'Create a new Google Sheets spreadsheet',
      requiresAuth: true,
      steps: [
        { instruction: 'Navigate to sheets.new', tool: 'navigate', params: { url: 'https://sheets.new' } },
        { instruction: 'Wait for spreadsheet to load', tool: 'wait', params: { ms: 2000 } },
        { instruction: 'Verify spreadsheet loaded by checking for sheet tabs', tool: 'elements', grepHint: 'Sheet1' },
      ],
    },
    {
      name: 'write_cell',
      description: 'Write a value to a specific cell',
      steps: [
        { instruction: 'Click the Name Box (cell reference box showing current cell, top-left corner) to select it', tool: 'elements', grepHint: 'Name Box' },
        { instruction: 'Type cell reference "{cell}" and press Enter to navigate to that cell', tool: 'type', fallback: 'Use keys({ sequence: "ctrl+g" }) to open Go To dialog, then type the cell reference' },
        { instruction: 'Type the value "{value}"', tool: 'keys' },
        { instruction: 'Press Enter to confirm', tool: 'keys', params: { sequence: 'Enter' } },
      ],
    },
    {
      name: 'read_range',
      description: 'Read data from a range of cells',
      steps: [
        { instruction: 'Click the Name Box and type "{range}" then press Enter to select the range', tool: 'elements', grepHint: 'Name Box' },
        { instruction: 'Take a screenshot to visually read the selected data', tool: 'screenshot' },
        { instruction: 'Alternative: use text({ grep: "..." }) to extract visible text from the cells', tool: 'text', fallback: 'Use eval_js to read cell data from the Sheets internal API' },
      ],
    },
    {
      name: 'add_formula',
      description: 'Insert a formula into a cell',
      steps: [
        { instruction: 'Navigate to target cell "{cell}" using the Name Box', tool: 'elements', grepHint: 'Name Box' },
        { instruction: 'Press F2 to enter edit mode', tool: 'keys', params: { sequence: 'F2' } },
        { instruction: 'Type formula "{formula}" (must start with =)', tool: 'keys' },
        { instruction: 'Press Enter to confirm formula', tool: 'keys', params: { sequence: 'Enter' } },
        { instruction: 'Verify formula result by reading cell content', tool: 'text', validation: 'Cell should show computed result, not formula text' },
      ],
    },
    {
      name: 'format_range',
      description: 'Apply formatting (bold, color, borders, etc.) to cells',
      steps: [
        { instruction: 'Select the range "{range}" using the Name Box', tool: 'elements', grepHint: 'Name Box' },
        { instruction: 'Use toolbar buttons or keyboard shortcuts: Ctrl+B (bold), Ctrl+I (italic), Ctrl+U (underline)', tool: 'keys', grepHint: 'Bold|Italic|Underline' },
        { instruction: 'For colors/borders, click the Format menu', tool: 'elements', grepHint: 'Format' },
      ],
    },
    {
      name: 'create_chart',
      description: 'Create a chart from selected data',
      steps: [
        { instruction: 'Select data range "{range}" using the Name Box', tool: 'elements', grepHint: 'Name Box' },
        { instruction: 'Open the Insert menu', tool: 'elements', grepHint: 'Insert' },
        { instruction: 'Click "Chart"', tool: 'click', grepHint: 'Chart' },
        { instruction: 'Wait for chart editor to appear', tool: 'wait', params: { ms: 1500 } },
        { instruction: 'Configure chart type in the editor sidebar', tool: 'elements', grepHint: 'Chart type|Chart editor' },
      ],
    },
  ],
};
