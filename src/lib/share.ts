/** Browser share helpers (clipboard + WhatsApp deep link). */
import { toWaNumber } from './ui-format';

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to legacy copy
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Starts the copy while the document still has focus, then opens WhatsApp
 * synchronously inside the click handler so popup blockers allow it.
 * Resolves to whether the clipboard copy succeeded.
 */
export function shareToWhatsApp(phone: string | null | undefined, text: string): Promise<boolean> {
  const copied = copyText(text);
  const url = `https://wa.me/${toWaNumber(phone)}?text=${encodeURIComponent(text)}`;
  window.open(url, '_blank', 'noopener,noreferrer');
  return copied;
}

