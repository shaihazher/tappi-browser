/**
 * aria-preload.ts — Preload script for the Aria tab (Phase 8.35).
 *
 * Exposes window.aria API for the Aria full-chat UI to communicate with main process.
 * Separate from the chrome preload (preload.ts) and content preload (content-preload.js).
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('aria', {
  // ─── Agent communication ───
  sendMessage: (message: string, conversationId?: string, codingMode?: boolean) =>
    ipcRenderer.send('aria:send', message, conversationId, codingMode),

  stopAgent: () => ipcRenderer.send('aria:stop'),

  onStreamStart: (cb: () => void) => {
    ipcRenderer.on('agent:stream-start', () => cb());
  },

  onStreamChunk: (cb: (chunk: { text: string; done: boolean }) => void) => {
    ipcRenderer.on('agent:stream-chunk', (_e, chunk) => cb(chunk));
  },

  onToolResult: (cb: (result: { toolName: string; result: string; display: string }) => void) => {
    ipcRenderer.on('agent:tool-result', (_e, result) => cb(result));
  },

  onReasoningChunk: (cb: (data: { text: string; done: boolean }) => void) => {
    ipcRenderer.on('agent:reasoning-chunk', (_e, data) => cb(data));
  },

  onTokenUsage: (cb: (data: { inputTokens: number; outputTokens: number; totalTokens: number }) => void) => {
    ipcRenderer.on('agent:token-usage', (_e, data) => cb(data));
  },

  // ─── Conversation management ───
  newChat: () => ipcRenderer.invoke('aria:new-chat'),

  switchConversation: (conversationId: string) =>
    ipcRenderer.invoke('aria:switch-conversation', conversationId),

  deleteConversation: (conversationId: string) =>
    ipcRenderer.invoke('aria:delete-conversation', conversationId),

  renameConversation: (conversationId: string, title: string) =>
    ipcRenderer.invoke('aria:rename-conversation', conversationId, title),

  listConversations: () => ipcRenderer.invoke('aria:list-conversations'),

  getConversationMessages: (conversationId: string, offset?: number, limit?: number) =>
    ipcRenderer.invoke('aria:get-messages', conversationId, offset, limit),

  searchConversations: (query: string) =>
    ipcRenderer.invoke('aria:search-conversations', query),

  onConversationUpdated: (cb: (data: { conversationId: string }) => void) => {
    ipcRenderer.on('aria:conversation-updated', (_e, data) => cb(data));
  },

  onConversationSwitched: (cb: (data: { conversationId: string }) => void) => {
    ipcRenderer.on('aria:conversation-switched', (_e, data) => cb(data));
  },

  // ─── Config ───
  getActiveConversationId: () => ipcRenderer.invoke('aria:get-active-conversation'),

  // ─── Developer Mode (Fix 4) ───
  getDevMode: () => ipcRenderer.invoke('devmode:get'),

  onDevModeChanged: (cb: (enabled: boolean) => void) => {
    ipcRenderer.on('devmode:changed', (_e, enabled) => cb(enabled));
  },

  // ─── Coding Mode (Fix 4) — Primary toggle lives in the Aria tab UI ───
  getCodingMode: () => ipcRenderer.invoke('codingmode:get'),

  setCodingMode: (enabled: boolean) => ipcRenderer.invoke('codingmode:set', enabled),

  onCodingModeChanged: (cb: (enabled: boolean) => void) => {
    ipcRenderer.on('codingmode:changed', (_e, enabled) => cb(enabled));
  },

  // ─── Team Status (Fix 4) ───
  getTeamStatus: () => ipcRenderer.invoke('team:status'),

  onTeamUpdated: (cb: (data: any) => void) => {
    ipcRenderer.on('team:updated', (_e, data) => cb(data));
  },

  // ─── Team Live Activity (coding mode) ───
  onTeammateStart: (cb: (data: { id: string; name: string; role: string; task: string }) => void) => {
    ipcRenderer.on('team:teammate-start', (_e, data) => cb(data));
  },
  onTeammateChunk: (cb: (data: { name: string; text: string; done: boolean }) => void) => {
    ipcRenderer.on('team:teammate-chunk', (_e, data) => cb(data));
  },
  onTeammateTool: (cb: (data: { name: string; toolName: string; display: string }) => void) => {
    ipcRenderer.on('team:teammate-tool', (_e, data) => cb(data));
  },
  onTeammateDone: (cb: (data: { name: string; status: string; summary: string }) => void) => {
    ipcRenderer.on('team:teammate-done', (_e, data) => cb(data));
  },
  onTeamMailboxMessage: (cb: (data: { from: string; to: string; text: string }) => void) => {
    ipcRenderer.on('team:mailbox-message', (_e, data) => cb(data));
  },

  // ─── Phase 9.096d: Teammate pulse / reasoning / interrupt events ───
  onTeammatePulse: (cb: (data: { name: string; text: string }) => void) => {
    ipcRenderer.on('team:teammate-pulse', (_e, data) => cb(data));
  },
  onTeammateReasoning: (cb: (data: { name: string; text: string }) => void) => {
    ipcRenderer.on('team:teammate-reasoning', (_e, data) => cb(data));
  },
  onTeammateInterrupt: (cb: (data: { name: string; message: string }) => void) => {
    ipcRenderer.on('team:teammate-interrupt', (_e, data) => cb(data));
  },

  // ─── Phase 9.096d: Unified interrupt/redirect IPC ───
  interruptAgent: (target: string, targetName: string | null, message: string) =>
    ipcRenderer.invoke('agent:interrupt', { target, targetName, message }),

  // ─── Projects (Phase 9.07) ───
  listProjects: (includeArchived?: boolean) =>
    ipcRenderer.invoke('projects:list', includeArchived ?? false),

  getProject: (projectId: string) =>
    ipcRenderer.invoke('projects:get', projectId),

  createProject: (name: string, workingDir: string, description?: string) =>
    ipcRenderer.invoke('projects:create', name, workingDir, description),

  getProjectArtifacts: (projectId: string) =>
    ipcRenderer.invoke('projects:get-artifacts', projectId),

  linkConversationToProject: (conversationId: string, projectId: string) =>
    ipcRenderer.invoke('projects:link-conversation', conversationId, projectId),

  getProjectConversations: (projectId: string) =>
    ipcRenderer.invoke('projects:get-conversations', projectId),

  // Phase 9.09: Create a new conversation pre-linked to a project
  newProjectConversation: (projectId: string) =>
    ipcRenderer.invoke('projects:new-conversation', projectId),

  // Phase 9.09: Listen for real-time project updates (agent auto-creates project, etc.)
  onProjectsUpdated: (cb: () => void) => {
    ipcRenderer.on('projects:updated', () => cb());
  },

  // Phase 9.095: Delete a project (unlink from sidebar, or delete everything)
  deleteProject: (projectId: string, mode: 'unlink' | 'delete-all') =>
    ipcRenderer.invoke('projects:delete', projectId, mode),

  // Phase 9.096b: Separate IPC for trashing project directory (requires explicit user confirmation)
  trashProjectDir: (dirPath: string) =>
    ipcRenderer.invoke('projects:trash-dir', dirPath),

  // ─── File Downloads (Phase 9.07 Track 5) ───
  onPresentDownload: (cb: (data: { path: string; name: string; size: number; formats: string[]; description?: string }) => void) => {
    ipcRenderer.on('agent:present-download', (_e, data) => cb(data));
  },

  downloadFile: (sourcePath: string, format: string, defaultName?: string) =>
    ipcRenderer.invoke('file:download', sourcePath, format, defaultName),

  // ─── Theme ───
  onThemeChanged: (cb: (darkMode: boolean) => void) => {
    ipcRenderer.on('theme:changed', (_e, darkMode: boolean) => cb(darkMode));
  },

  getTheme: () => ipcRenderer.invoke('theme:get'),
});
