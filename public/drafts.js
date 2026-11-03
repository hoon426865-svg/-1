// Drafts live only in this page's memory, never in browser storage or URLs.
const baselines = new WeakMap();
const fields = form => [...form.elements].filter(field => field.name && !['submit','button','reset'].includes(field.type));
const value = field => ['checkbox','radio'].includes(field.type) ? field.checked : field.value;
const key = form => form.id || (form.dataset.decision ? `decision:${form.dataset.decision}` : `${form.className}:${form.dataset.id}`);
export function rememberForms(root) {
  for (const form of root.querySelectorAll('form')) {
    if (!baselines.has(form)) baselines.set(form, fields(form).map(value));
  }
}
export function captureDrafts(root) {
  const drafts = new Map();
  for (const form of root.querySelectorAll('form')) {
    const initial = baselines.get(form), controls = fields(form);
    if (!initial || !controls.some((field,i) => value(field) !== initial[i])) continue;
    drafts.set(key(form), {version:form.dataset.version, fields:controls.map(field => ({name:field.name,type:field.type,value:value(field)}))});
  }
  return drafts;
}
export function restoreDrafts(root, drafts) {
  rememberForms(root);
  for (const form of root.querySelectorAll('form')) {
    const draft = drafts.get(key(form));
    if (!draft) continue;
    for (const saved of draft.fields) {
      const field = fields(form).find(field => field.name === saved.name && field.type === saved.type);
      if (!field) continue;
      if (['checkbox','radio'].includes(field.type)) field.checked = saved.value;
      else field.value = saved.value;
    }
    // Keep the original optimistic-lock version with an in-progress edit.
    if (draft.version && form.dataset.version !== draft.version) {
      form.dataset.version = draft.version;
      const error = form.querySelector('[role="alert"]');
      if (error) error.textContent = '작성 중인 기록이 변경되었습니다. 입력 내용을 보관한 뒤 최신 기록을 확인하세요.';
    }
  }
}
export function acceptForm(form) {
  if (form) baselines.set(form, fields(form).map(value));
}
export function hasDrafts(root) { return captureDrafts(root).size > 0; }
