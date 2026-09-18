<script lang="ts">
  import { Reveal } from '$lib/components/ui/reveal/index.js';

  /* The line under a form that says what went wrong. It folds open and
     closed instead of pushing the button down in one frame, keeps its words
     while it leaves, and is announced when it arrives. The message is
     rendered as text. */
  interface Props {
    message: string | null | undefined;
    class?: string;
  }
  let { message, class: className = '' }: Props = $props();

  let shown = $state('');
  $effect.pre(() => {
    if (message) shown = message;
  });
</script>

<Reveal open={!!message}>
  <p class="text-sm text-destructive {className}" role="alert">{shown}</p>
</Reveal>
