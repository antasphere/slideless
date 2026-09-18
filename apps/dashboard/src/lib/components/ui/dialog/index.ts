import { Dialog as DialogPrimitive } from 'bits-ui';

import Body from './dialog-body.svelte';
import Content from './dialog-content.svelte';
import Description from './dialog-description.svelte';
import Footer from './dialog-footer.svelte';
import Header from './dialog-header.svelte';
import Illustration from './dialog-illustration.svelte';
import Layout from './dialog-layout.svelte';
import Overlay from './dialog-overlay.svelte';
import Title from './dialog-title.svelte';

const Root: typeof DialogPrimitive.Root = DialogPrimitive.Root;
const Trigger: typeof DialogPrimitive.Trigger = DialogPrimitive.Trigger;
const Close: typeof DialogPrimitive.Close = DialogPrimitive.Close;
const Portal: typeof DialogPrimitive.Portal = DialogPrimitive.Portal;

export type { DialogSize } from './dialog-content.svelte';

export {
  Body,
  Close,
  Content,
  Description,
  //
  Root as Dialog,
  Close as DialogClose,
  Content as DialogContent,
  Description as DialogDescription,
  Body as DialogBody,
  Footer as DialogFooter,
  Header as DialogHeader,
  Layout as DialogLayout,
  Overlay as DialogOverlay,
  Portal as DialogPortal,
  Title as DialogTitle,
  Trigger as DialogTrigger,
  Footer,
  Header,
  Illustration,
  Layout,
  Overlay,
  Portal,
  Root,
  Title,
  Trigger
};
