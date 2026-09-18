/**
 * What each tagged value in the dashboard means, as a tone and a glyph
 * (the Tag component draws them). One home, so "an API key" is amber with a key
 * on the audit log, on the key's own page and anywhere it shows next.
 */
import type { Component } from 'svelte';
import Monitor from '@lucide/svelte/icons/monitor';
import KeyRound from '@lucide/svelte/icons/key-round';
import ShieldCheck from '@lucide/svelte/icons/shield-check';
import Cpu from '@lucide/svelte/icons/cpu';
import Crown from '@lucide/svelte/icons/crown';
import UserCog from '@lucide/svelte/icons/user-cog';
import User from '@lucide/svelte/icons/user';
import Eye from '@lucide/svelte/icons/eye';
import PenLine from '@lucide/svelte/icons/pen-line';
import Download from '@lucide/svelte/icons/download';
import FileText from '@lucide/svelte/icons/file-text';
import FileImage from '@lucide/svelte/icons/image';
import FileCode from '@lucide/svelte/icons/file-code';
import FileArchive from '@lucide/svelte/icons/file-archive';
import Sheet from '@lucide/svelte/icons/sheet';
import Film from '@lucide/svelte/icons/film';
import Type from '@lucide/svelte/icons/type';
import File from '@lucide/svelte/icons/file';
import Lock from '@lucide/svelte/icons/lock';
import Mail from '@lucide/svelte/icons/mail';
import type { TagTone } from '$lib/components/ui/tag';
import { t } from '$lib/i18n';

export interface TagSpec {
  label: string;
  tone?: TagTone;
  icon?: Component;
  detail?: string;
  mono?: boolean;
  dot?: boolean;
  title?: string;
}

/** How an action arrived: a person in a browser, a key, an OAuth client, the system itself. */
export function viaTag(via: string): TagSpec {
  switch (via) {
    case 'session':
      return { label: t('tags.viaSession'), tone: 'slate', icon: Monitor };
    case 'api_key':
      return { label: t('tags.viaApiKey'), tone: 'amber', icon: KeyRound };
    case 'oauth':
      return { label: t('tags.viaOauth'), tone: 'indigo', icon: ShieldCheck };
    default:
      return { label: t('tags.viaSystem'), tone: 'neutral', icon: Cpu };
  }
}

export function roleTag(role: string): TagSpec {
  switch (role) {
    case 'owner':
      return { label: t('tags.roleOwner'), tone: 'clay', icon: Crown };
    case 'admin':
      return { label: t('tags.roleAdmin'), tone: 'indigo', icon: UserCog };
    default:
      return { label: t('tags.roleMember'), tone: 'slate', icon: User };
  }
}

/** `presentations:read` reads as what it touches, then what it may do with it. */
export function scopeTag(scope: string): TagSpec {
  const [what, verb = ''] = scope.split(':');
  const tone: TagTone = verb === 'read' ? 'green' : verb === 'write' ? 'clay' : 'violet';
  const icon = verb === 'read' ? Eye : verb === 'write' ? PenLine : Download;
  return { label: what, detail: verb, tone, icon, title: scope };
}

/** A sign-in method of the instance. */
export function methodTag(method: string): TagSpec {
  switch (method) {
    case 'password':
      return { label: method, tone: 'slate', icon: Lock };
    case 'api-key':
      return { label: method, tone: 'amber', icon: KeyRound };
    case 'oauth':
      return { label: method, tone: 'indigo', icon: ShieldCheck };
    case 'email-otp':
      return { label: method, tone: 'green', icon: Mail };
    default:
      return { label: method };
  }
}

/** What a file is, from its type: a short name a person says, never the MIME string. */
export function fileTag(contentType: string): TagSpec {
  const type = contentType.toLowerCase().split(';')[0].trim();
  const sub = type.split('/')[1] ?? '';
  const title = contentType;
  if (type === 'application/pdf') return { label: 'PDF', tone: 'clay', icon: FileText, title };
  if (type.startsWith('image/'))
    return {
      label: sub.replace('svg+xml', 'svg').replace('jpeg', 'jpg').toUpperCase(),
      tone: 'violet',
      icon: FileImage,
      title
    };
  if (type.startsWith('video/') || type.startsWith('audio/'))
    return { label: sub.toUpperCase(), tone: 'indigo', icon: Film, title };
  if (type.startsWith('font/') || /woff|ttf|otf/.test(sub))
    return { label: t('tags.fileFont'), tone: 'slate', icon: Type, title };
  if (type === 'text/html') return { label: 'HTML', tone: 'indigo', icon: FileCode, title };
  if (type === 'text/css' || /javascript|typescript/.test(sub))
    return { label: sub === 'css' ? 'CSS' : 'JS', tone: 'indigo', icon: FileCode, title };
  if (type === 'text/csv' || /spreadsheet|excel/.test(sub))
    return { label: type === 'text/csv' ? 'CSV' : t('tags.fileSheet'), tone: 'green', icon: Sheet, title };
  if (/json|xml|yaml/.test(sub))
    return { label: sub.replace(/.*\+/, '').toUpperCase(), tone: 'green', icon: FileCode, title };
  if (/zip|gzip|tar|compressed/.test(sub)) return { label: 'ZIP', tone: 'amber', icon: FileArchive, title };
  if (type.startsWith('text/'))
    return {
      label: sub === 'plain' ? t('tags.fileText') : sub === 'markdown' ? 'MD' : sub.toUpperCase(),
      tone: 'slate',
      icon: FileText,
      title
    };
  return { label: sub ? sub.slice(0, 12) : t('tags.fileOther'), icon: File, title };
}

/** A state: a dot, the tone saying whether it is alive. */
export function stateTag(label: string, state: 'ok' | 'off' | 'wait' | 'bad'): TagSpec {
  const tone: TagTone =
    state === 'ok' ? 'green' : state === 'wait' ? 'amber' : state === 'bad' ? 'danger' : 'neutral';
  return { label, tone, dot: true };
}
