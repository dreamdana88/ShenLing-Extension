let workflowOptions = {
  addCommunicationLog: null,
  getActiveApiProfile: null,
};

export function configureCaptureWorkflow(options = {}) {
  workflowOptions = { ...workflowOptions, ...options };
}

export function getWorkflowOption(name) {
  const value = workflowOptions[name];
  return typeof value === 'function' ? value : null;
}
