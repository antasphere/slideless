import { getLocale, t } from '$lib/i18n';

/**
 * All formatters follow the app's UI locale (the i18n choice), not the OS
 * locale — dates, relative times, and byte units switch language together
 * with the rest of the dashboard.
 */

/** 2026-07-03T10:00:00Z → "Jul 3, 2026, 10:00" (app locale, viewer's timezone). */
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(getLocale(), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(getLocale(), { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatTimeAgo(iso: string | null): string {
  if (!iso) return t('format.never');
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return t('format.justNow');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('format.minutesAgo', { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('format.hoursAgo', { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return t('format.daysAgo', { n: days });
  return formatDate(iso);
}

export function formatBytes(bytes: number): string {
  // Localized unit ladder ('B|KB|MB|…' vs 'o|Ko|Mo|…').
  const units = t('format.byteUnits').split('|');
  if (bytes === 0) return `0 ${units[0]}`;
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}
