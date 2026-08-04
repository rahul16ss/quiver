// ─── state ────────────────────────────────────────────────────────────
import { $ } from "./dom.js";

export const api = window.quiver;

export const state = {
  configured: false,
  agentAvailable: false,
  turnRunning: false,
  assistantBubble: null,
  pendingApproval: null,
  pendingApprovalAll: false,
  liveRunActive: false,
  attachments: [],
  lastContextEntryText: null,
  lastModelConfig: null,
  queuedSteerEl: null,
  overlayFocusStack: [],
  activeOverlayTrap: null,
  consentGateActive: false,
  consentGateShown: false,
  currentVerificationClaim: null,
  currentReviewDocument: null,
  documentCards: new Map(),
  excludedFromRun: new Set(),
  lineageClaims: new Map(),
  documentSources: new Map(),
  claimToDocument: new Map(),
  documentReviewStatus: new Map(),
  documentOverrideLogged: new Map(),
  documentMarkedFinal: new Map(),
  deliverableContextRecords: new Map(),
  chatArea: null,
  emptyState: null,
  promptInput: null,
  sendBtn: null,
  stopBtn: null,
  statusDot: null,
  activityStream: null,
};

export function initDom() {
  state.chatArea = $("chatArea");
  state.emptyState = $("emptyState");
  state.promptInput = $("promptInput");
  state.sendBtn = $("sendBtn");
  state.stopBtn = $("stopBtn");
  state.statusDot = $("statusDot");
  state.activityStream = $("activityStream");
}
