// SPDX-License-Identifier: MPL-2.0
export const DATA_CODE_RULES_PREFERENCE_KEY = 'data-code-rules';

export interface DataRulesPreferenceStore {
  get(): Promise<string | undefined>;
  set(value: string): Promise<void>;
  remove(): Promise<void>;
}

export const dataRulesPreference: DataRulesPreferenceStore = {
  async get(): Promise<string | undefined> {
    if (typeof GM_getValue !== 'function') return undefined;
    const value = GM_getValue<unknown>(DATA_CODE_RULES_PREFERENCE_KEY);
    return typeof value === 'string' ? value : undefined;
  },
  async set(value: string): Promise<void> {
    if (typeof GM_setValue === 'function') GM_setValue(DATA_CODE_RULES_PREFERENCE_KEY, value);
  },
  async remove(): Promise<void> {
    if (typeof GM_deleteValue === 'function') GM_deleteValue(DATA_CODE_RULES_PREFERENCE_KEY);
  },
};
