// Shared picker rules; metadata for Codex comes from the installed CLI, not a fixed model list.
export const CLAUDE_MODELS = ['', 'fable', 'opus', 'sonnet', 'haiku'];
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export function modelOptions(type, catalog = [], selected = '') {
  if (type !== 'codex') return CLAUDE_MODELS.map(value => ({ value, label: value || 'default' }));
  const defaultModel = catalog.find(m => m.isDefault) ?? catalog[0];
  const options = [{ value: '', label: defaultModel ? `default (${defaultModel.displayName})` : 'default' }, ...catalog.map(m => ({ value: m.id, label: m.displayName }))];
  if (selected && !options.some(o => o.value === selected)) options.push({ value: selected, label: `${selected} (not in current model list)` });
  return options;
}

export function effortOptions(type, catalog = [], modelId = '') {
  if (type !== 'codex') return [{ value: '', label: 'default' }, ...CLAUDE_EFFORTS.map(value => ({ value, label: value }))];
  const model = modelId ? catalog.find(m => m.id === modelId) : catalog.find(m => m.isDefault) ?? catalog[0];
  return [
    { value: '', label: model?.defaultReasoningEffort ? `default (${model.defaultReasoningEffort})` : 'default' },
    ...(model?.supportedReasoningEfforts ?? []).map(e => ({ value: e.reasoningEffort, label: e.reasoningEffort, description: e.description })),
  ];
}
