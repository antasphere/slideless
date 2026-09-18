<script lang="ts" module>
  /** sm: a question. md: a form. lg: a form with room, or a result with code in it. */
  export type DialogSize = 'sm' | 'md' | 'lg';
</script>

<script lang="ts">
  import { cn } from '$lib/utils.js';
  import X from '@lucide/svelte/icons/x';
  import { Dialog as DialogPrimitive, type WithoutChildrenOrChild } from 'bits-ui';
  import type { Snippet } from 'svelte';
  import { t } from '$lib/i18n';
  import DialogBody from './dialog-body.svelte';
  import * as Dialog from './index.js';

  /* A dialog never leaves the screen. The surface is bounded by the viewport
     (`100dvh`, so a phone's moving browser bars are counted), and what is too
     tall scrolls INSIDE it, under soft shadows that show only while there is
     more to read. Two ways to fill it:

     - framed: the caller lays out `Dialog.Header`, `Dialog.Body` and
       `Dialog.Footer`; the header and the actions stay in place and only the
       body scrolls. FormDialog and ConfirmDialog are built this way.
     - plain (the default, what every older caller gets without a change): the
       whole content scrolls inside the bounded surface.

     Under 640px the surface is a sheet rising from the bottom edge, full
     width, padded for the home indicator. `aside` is a drawing panel on the
     left from 768px up; a phone never shows it. */
  let {
    ref = $bindable(null),
    class: className,
    portalProps,
    children,
    closable = true,
    size = 'md',
    framed = false,
    aside,
    ...restProps
  }: WithoutChildrenOrChild<DialogPrimitive.ContentProps> & {
    portalProps?: DialogPrimitive.PortalProps;
    children: Snippet;
    closable?: boolean;
    size?: DialogSize;
    framed?: boolean;
    aside?: Snippet;
  } = $props();
</script>

<Dialog.Portal {...portalProps}>
  <Dialog.Overlay />
  <DialogPrimitive.Content
    bind:ref
    class={cn('dlg', className)}
    data-size={size}
    data-framed={framed ? '' : undefined}
    data-aside={aside ? '' : undefined}
    {...restProps}
  >
    {#if aside}
      <div class="dlg-aside" aria-hidden="true">
        {@render aside()}
      </div>
    {/if}
    <div class="dlg-main">
      {#if framed}
        {@render children?.()}
      {:else}
        <DialogBody class="dlg-plain">
          {@render children?.()}
        </DialogBody>
      {/if}
    </div>

    {#if closable}
      <DialogPrimitive.Close class="dlg-close">
        <X class="size-4" />
        <span class="sr-only">{t('common.close')}</span>
      </DialogPrimitive.Close>
    {/if}
  </DialogPrimitive.Content>
</Dialog.Portal>

<style>
  /* Global on purpose: the surface is rendered by bits-ui in a portal, and its
     parts (header, footer, a caller's form) are other components' elements.
     Every rule is fenced by a `dlg` class so nothing leaks past a dialog. */
  :global {
    .dlg-overlay {
      position: fixed;
      inset: 0;
      z-index: 60;
      /* the ink of the paper, never a neutral black: a warm scrim */
      background: rgb(28 25 21 / 0.36);
      backdrop-filter: blur(5px) saturate(1.05);
      -webkit-backdrop-filter: blur(5px) saturate(1.05);
      animation-duration: calc(var(--motion-duration) * 1.15);
      animation-timing-function: var(--motion-ease);
      animation-fill-mode: both;
    }
    .dark .dlg-overlay {
      background: rgb(8 6 4 / 0.58);
    }
    .dlg-overlay[data-state='open'] {
      animation-name: dlg-fade-in;
    }
    .dlg-overlay[data-state='closed'] {
      animation-name: dlg-fade-out;
    }

    .dlg {
      --dlg-w: 520px;
      --dlg-aside-w: 0px;
      --dlg-pad: 24px;
      position: fixed;
      inset: 0;
      z-index: 60;
      margin: auto;
      display: flex;
      width: min(calc(100vw - 2rem), calc(var(--dlg-w) + var(--dlg-aside-w)));
      height: fit-content;
      max-height: min(calc(100dvh - 2rem), 760px);
      overflow: hidden;
      /* the outline button's paper, laid over the opaque bar colour so
         nothing under the dialog reads through it */
      background: linear-gradient(var(--plate-strong), var(--plate-strong)), var(--bar);
      color: var(--ink);
      border: 1px solid var(--hairline);
      border-radius: 16px;
      box-shadow:
        var(--shadow-lg),
        0 28px 64px -24px rgb(28 25 21 / 0.35),
        inset 0 1px 0 var(--plate-edge);
      outline: none;
      animation-duration: calc(var(--motion-duration) * 1.15);
      animation-timing-function: var(--motion-ease);
      animation-fill-mode: both;
    }
    .dlg[data-size='sm'] {
      --dlg-w: 440px;
    }
    .dlg[data-size='lg'] {
      --dlg-w: 640px;
    }
    .dlg[data-state='open'] {
      animation-name: dlg-in;
    }
    .dlg[data-state='closed'] {
      animation-name: dlg-out;
    }

    .dlg-main {
      position: relative;
      display: flex;
      min-width: 0;
      min-height: 0;
      flex: 1 1 auto;
      flex-direction: column;
    }
    /* a caller's <form> between the surface and its parts keeps the frame */
    .dlg-form {
      display: flex;
      min-height: 0;
      flex: 1 1 auto;
      flex-direction: column;
    }

    /* the drawing panel: a breath of the second ground and of the accent,
       one hairline between it and the form */
    .dlg-aside {
      display: none;
    }
    @media (min-width: 768px) {
      .dlg[data-aside] {
        --dlg-aside-w: 300px;
      }
      .dlg[data-aside][data-size='lg'] {
        --dlg-aside-w: 340px;
      }
      .dlg-aside {
        position: relative;
        display: flex;
        flex: none;
        width: var(--dlg-aside-w);
        flex-direction: column;
        overflow: hidden;
        border-right: 1px solid var(--hairline);
        background:
          radial-gradient(120% 80% at 20% 0%, var(--accent-soft), transparent 62%),
          color-mix(in oklab, var(--ground-2) 70%, transparent);
      }
    }

    .dlg-header {
      display: flex;
      flex: none;
      flex-direction: column;
      gap: 6px;
      /* the close button's room */
      padding-right: 28px;
      text-align: left;
    }
    .dlg[data-framed] .dlg-header {
      padding: 22px calc(var(--dlg-pad) + 32px) 14px var(--dlg-pad);
    }
    /* a header that scrolls with the words under it (a question whose
       description runs long): the body already gives the side padding */
    .dlg[data-framed] .dlg-words .dlg-header {
      padding: 16px 32px 0 0;
    }
    .dlg-title {
      font-family: var(--display);
      font-weight: 400;
      font-size: 21px;
      line-height: 1.2;
      letter-spacing: -0.012em;
      text-wrap: balance;
    }
    .dlg-description {
      color: var(--muted);
      font-size: 13.5px;
      line-height: 1.5;
      text-wrap: pretty;
    }

    .dlg-footer {
      display: flex;
      flex: none;
      flex-wrap: wrap;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
    }
    .dlg[data-framed] .dlg-footer {
      padding: 14px var(--dlg-pad) 16px;
      border-top: 1px solid var(--hairline);
      background: color-mix(in oklab, var(--ground-2) 46%, transparent);
    }

    .dlg-close {
      position: absolute;
      top: 14px;
      right: 14px;
      z-index: 3;
      display: inline-flex;
      width: 30px;
      height: 30px;
      align-items: center;
      justify-content: center;
      border-radius: 9px;
      color: var(--muted);
      transition:
        background-color var(--motion-duration) var(--motion-ease),
        color var(--motion-duration) var(--motion-ease);
    }
    .dlg-close:hover {
      background: color-mix(in oklab, var(--accent) 9%, transparent);
      color: var(--ink);
    }
    .dlg-close:focus-visible {
      outline: 2px solid var(--focus);
      outline-offset: 1px;
    }

    /* a phone: the sheet. Full width, from the bottom edge, its own top
       corners rounded, the home indicator's room under the actions. Nothing
       to drag: it closes by its button, its scrim or Escape. */
    @media (max-width: 639.98px) {
      .dlg {
        --dlg-pad: 18px;
        inset: auto 0 0 0;
        margin: 0;
        width: 100%;
        max-width: none;
        max-height: calc(100dvh - 20px - env(safe-area-inset-top, 0px));
        border-width: 1px 0 0;
        border-radius: 20px 20px 0 0;
        padding-bottom: env(safe-area-inset-bottom, 0px);
      }
      .dlg[data-state='open'] {
        animation-name: dlg-sheet-in;
      }
      .dlg[data-state='closed'] {
        animation-name: dlg-sheet-out;
      }
      .dlg-footer > * {
        flex: 1 1 0;
      }
      .dlg-title {
        font-size: 19px;
      }
    }

    @keyframes -global-dlg-fade-in {
      from {
        opacity: 0;
      }
    }
    @keyframes -global-dlg-fade-out {
      to {
        opacity: 0;
      }
    }
    @keyframes -global-dlg-in {
      from {
        opacity: 0;
        transform: translateY(6px) scale(0.98);
      }
    }
    @keyframes -global-dlg-out {
      to {
        opacity: 0;
        transform: translateY(4px) scale(0.98);
      }
    }
    @keyframes -global-dlg-sheet-in {
      from {
        transform: translateY(100%);
      }
    }
    @keyframes -global-dlg-sheet-out {
      to {
        transform: translateY(100%);
      }
    }
  }
</style>
