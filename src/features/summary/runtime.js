let workflowOptions = {
  addCommunicationLog: null,
  getActiveApiProfile: null,
  getApiSettings: null,
  refreshSummaryPanel: null,
};

export function configureSummaryWorkflow(options = {}) {
  workflowOptions = {
    ...workflowOptions,
    ...options,
  };
}

export function requireWorkflowOption(name) {
  const value = workflowOptions[name];
  if (typeof value !== 'function') {
    throw new Error(`总结流程缺少依赖：${name}`);
  }
  return value;
}

export function refreshSummaryPanelAfterAction() {
  if (typeof workflowOptions.refreshSummaryPanel === 'function') {
    workflowOptions.refreshSummaryPanel();
  }
}

export function notifySummary(type, message, title = '自动总结') {
  const toastr = globalThis.toastr || globalThis.parent?.toastr;
  if (toastr && typeof toastr[type] === 'function') {
    toastr[type](message, title);
    return;
  }
  const logger = type === 'error' ? console.error : console.info;
  logger(`[蜃灵助手] ${title}：${message}`);
}
