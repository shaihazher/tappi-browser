/**
 * aria-preload.ts — Preload script for the Aria tab (Phase 8.35).
 *
 * Exposes window.aria API for the Aria full-chat UI to communicate with main process.
 * Separate from the chrome preload (preload.ts) and content preload (content-preload.js).
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('aria', {
  // ─── Agent communication ───
  sendMessage: (message: string, conversationId?: string) =>
    ipcRenderer.send('aria:send', message, conversationId),

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

  // ─── Deep mode events (forwarded from agent) ───
  onDeepPlan: (cb: (data: any) => void) => {
    ipcRenderer.on('agent:deep-plan', (_e, data) => cb(data));
  },
  onDeepSubtaskStart: (cb: (data: any) => void) => {
    ipcRenderer.on('agent:deep-subtask-start', (_e, data) => cb(data));
  },
  onDeepSubtaskDone: (cb: (data: any) => void) => {
    ipcRenderer.on('agent:deep-subtask-done', (_e, data) => cb(data));
  },
  onDeepStreamChunk: (cb: (data: any) => void) => {
    ipcRenderer.on('agent:deep-stream-chunk', (_e, data) => cb(data));
  },
  onDeepComplete: (cb: (data: any) => void) => {
    ipcRenderer.on('agent:deep-complete', (_e, data) => cb(data));
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
});
