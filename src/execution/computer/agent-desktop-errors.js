// Bounded native error vocabulary; provider text must never cross stdio.
import { z } from 'zod'

export const desktopErrorCodes = z.enum(['desktop_unavailable', 'observation_failed', 'unavailable', 'window_unavailable', 'protected_target', 'stale_observation',
  'unsupported_action', 'outcome_unknown', 'invalid_request', 'capture_failed', 'host_failure',
  'user_interrupted', 'focus_denied', 'keyboard_focus_changed',
  'input_outside_window', 'input_unavailable', 'unsupported_shortcut'])
export const diagnosticReasons = new Set(['uia_verification_failed', 'uia_client_init', 'uia_tree_navigation', 'uia_root_unavailable', 'uia_identity_unavailable', 'uia_deadline', 'uia_budget', 'uia_process_mismatch', 'uia_root_protected_or_unknown', 'uia_geometry', 'uia_state_unavailable', 'uia_value_read', 'uia_text_read', 'uia_password_recheck', 'desktop_session', 'desktop_open', 'desktop_name', 'desktop_not_default'])
export const nativeResponse = z.union([
  z.object({ result: z.unknown().refine(v => v !== undefined) }).strict(),
  z.object({ error: z.object({ code: desktopErrorCodes, reason: z.string().max(1024).nullable().optional() }).strict() }).strict()
    .transform(value => ({ error: { code: value.error.code,
      ...(diagnosticReasons.has(value.error.reason) ? { reason: value.error.reason } : {}),
    } })), // never publish arbitrary native diagnostic/content strings
])
