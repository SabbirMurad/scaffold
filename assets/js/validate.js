import { state } from './state.js';
import { anyModelError, anyEnumError } from './models.js';
import { anyColorError } from './colors.js';
import { anyTypoError } from './typography.js';
import { anyProviderError } from './api.js';
import { anyFrameError } from './props.js';

// Aggregate validity across every tab. The export button is gated on this so a
// project with any error can't be exported into broken Dart.
export function anyError() {
  if (anyModelError()) return true;
  if (anyEnumError()) return true;
  if (anyColorError()) return true;
  if (anyTypoError()) return true;
  if (anyProviderError()) return true;
  if (anyFrameError()) return true;
  return false;
}

// Reflect the current validity onto the export icon (error tint + hover hint).
// We avoid the native `disabled` attribute so the hover tooltip still shows the
// "Fix errors to export" hint; the click handler guards on the `has-error` class.
export function updateExportButton() {
  const btn = document.getElementById('btn-export-code');
  if (!btn) return;
  const bad = anyError();
  btn.classList.toggle('has-error', bad);
  btn.dataset.tooltip = bad ? 'Fix errors to export' : 'Export';
}
