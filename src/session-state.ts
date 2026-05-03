// Session state for tracking task progress and preventing stale responses

import { cometAI } from "./comet-ai.js";

export interface SessionState {
  currentTaskId: string | null;
  taskStartTime: number | null;
  lastPrompt: string | null;
  lastResponse: string | null;
  lastResponseTime: number | null;
  steps: string[];
  isActive: boolean;
}

export const sessionState: SessionState = {
  currentTaskId: null,
  taskStartTime: null,
  lastPrompt: null,
  lastResponse: null,
  lastResponseTime: null,
  steps: [],
  isActive: false,
};

export function generateTaskId(): string {
  return `task_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

export function startNewTask(prompt: string): string {
  const taskId = generateTaskId();
  sessionState.currentTaskId = taskId;
  sessionState.taskStartTime = Date.now();
  sessionState.lastPrompt = prompt;
  sessionState.lastResponse = null;
  sessionState.lastResponseTime = null;
  sessionState.steps = [];
  sessionState.isActive = true;
  cometAI.resetStabilityTracking();
  return taskId;
}

export function completeTask(response: string): void {
  sessionState.lastResponse = response;
  sessionState.lastResponseTime = Date.now();
  sessionState.isActive = false;
}

export function isSessionStale(): boolean {
  if (!sessionState.taskStartTime) return true;
  // Consider session stale if no activity for 5 minutes
  return Date.now() - sessionState.taskStartTime > 5 * 60 * 1000;
}
