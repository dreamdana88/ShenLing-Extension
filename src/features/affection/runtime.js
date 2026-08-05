import {
  getAffectionSettings,
  getGlobalSettings,
  getSummarySettings,
} from '../../core/settings.js';

let workflowOptions = {
  addCommunicationLog: null,
  getActiveApiProfile: null,
  refreshPanel: null,
};

export function configureAffectionWorkflow(options = {}) {
  workflowOptions = { ...workflowOptions, ...options };
}

export function getWorkflowOption(name) {
  const value = workflowOptions[name];
  return typeof value === 'function' ? value : null;
}

export function refreshAffectionPanel() {
  getWorkflowOption('refreshPanel')?.();
}

export function isAffectionAnalysisActive(settings = getGlobalSettings()) {
  const affection = getAffectionSettings(settings);
  const summary = getSummarySettings(settings);
  return Boolean(
    settings?.enabled === true
    && summary.enabled === true
    && affection.enabled === true
    && affection.mode === 'normal'
  );
}
