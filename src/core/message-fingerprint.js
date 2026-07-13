import { extractSummarySourceContent } from '../utils/text.js';
import { getChatMessageById } from './chat.js';
import {
  getGlobalSettings,
  getSummarySettings,
} from './settings.js';
import { stripMemoryBlock } from './summary.js';

export function createMessageContentFingerprint(content) {
  let hash = 0;
  const text = String(content || '').replace(/\s+/g, ' ').trim();
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return text ? `${text.length}:${Math.abs(hash)}` : '';
}

export function getAssistantMessageContentFingerprint(message, settings = getGlobalSettings()) {
  if (!message || message.role !== 'assistant') return '';
  const body = stripMemoryBlock(String(message.message || ''));
  const content = extractSummarySourceContent(body, getSummarySettings(settings)).trim();
  return createMessageContentFingerprint(content);
}

export function getMessageContentFingerprint(messageId, settings = getGlobalSettings()) {
  const message = getChatMessageById(Number(messageId));
  return getAssistantMessageContentFingerprint(message, settings);
}
