import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getLongFormGenerationTimeoutMessage,
  LONG_FORM_GENERATION_TIMEOUT_MS,
} from '../src/constants.js';
import { DIARY_GENERATION_TIMEOUT_MS } from '../src/features/diary/panel.js';
import {
  AFFECTION_PROFILE_BUILDING_MAX_AGE_MS,
  AFFECTION_PROFILE_BUILD_TIMEOUT_MS,
} from '../src/features/affection/workflow.js';
import { CAPTURE_GENERATION_TIMEOUT_MS } from '../src/features/memoir/workflow.js';
import { OUTLINE_GENERATION_TIMEOUT_MS } from '../src/features/plot-outline/workflow.js';
import { SCHEDULE_GENERATION_TIMEOUT_MS } from '../src/features/schedule/workflow.js';
import { THEATER_GENERATION_TIMEOUT_MS } from '../src/features/mini-theater/panel.js';

test('all user-triggered long-form features expose the shared 300-second timeout contract', () => {
  assert.equal(LONG_FORM_GENERATION_TIMEOUT_MS, 300000);
  assert.deepEqual(
    {
      miniTheater: THEATER_GENERATION_TIMEOUT_MS,
      plotOutline: OUTLINE_GENERATION_TIMEOUT_MS,
      schedule: SCHEDULE_GENERATION_TIMEOUT_MS,
      diary: DIARY_GENERATION_TIMEOUT_MS,
      affectionProfile: AFFECTION_PROFILE_BUILD_TIMEOUT_MS,
      memoirCapture: CAPTURE_GENERATION_TIMEOUT_MS,
    },
    {
      miniTheater: LONG_FORM_GENERATION_TIMEOUT_MS,
      plotOutline: LONG_FORM_GENERATION_TIMEOUT_MS,
      schedule: LONG_FORM_GENERATION_TIMEOUT_MS,
      diary: LONG_FORM_GENERATION_TIMEOUT_MS,
      affectionProfile: LONG_FORM_GENERATION_TIMEOUT_MS,
      memoirCapture: LONG_FORM_GENERATION_TIMEOUT_MS,
    },
  );
});

test('long-form timeout diagnostics distinguish main wait-only from secondary cancellation', () => {
  assert.equal(
    getLongFormGenerationTimeoutMessage('小剧场', 'main_api'),
    '小剧场生成等待超过 300 秒，已停止等待；主 API 生成可能仍在后台继续。',
  );
  assert.equal(
    getLongFormGenerationTimeoutMessage('设定采集', 'secondary_api'),
    '设定采集生成等待超过 300 秒，副 API 请求已取消，请稍后重试。',
  );
  assert.equal(
    getLongFormGenerationTimeoutMessage('日记', 'secondary'),
    '日记生成等待超过 300 秒，副 API 请求已取消，请稍后重试。',
  );
});

test('affection building max age leaves a two-minute buffer beyond generation timeout', () => {
  assert.equal(AFFECTION_PROFILE_BUILDING_MAX_AGE_MS, 420000);
  assert.ok(AFFECTION_PROFILE_BUILDING_MAX_AGE_MS > AFFECTION_PROFILE_BUILD_TIMEOUT_MS);
});
